import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventSource } from 'eventsource';
import axios from 'axios';
import { AgentService } from '@/agent/agent.provider';
import { InterviewSessionService } from '@/interviewer/interview-session.service';
import { EnhancedInterviewerService } from '@/interviewer/interview.service';
import { TemplateService } from '@/interviewer/template.service';
import { MessageRole, MessageType } from '@/database-test/entities/session-message.entity';
import { SessionMode } from '@/database-test/entities/interview-session-test.entity';
import { AxiosClient } from '@/shared/lib/axios-client';
import { AGENT_ENDPOINTS } from '@/shared/constants/agent';
import { mergeRoomAudio, parseTracksWithOffset } from '@/record-audio/merged-audio.util';
import { MinioService } from '@/record-audio/minio.service';
import { ChatService } from '@/interviewer/chat.service';
// import { ScoringService } from '@/interviewer/scoring.service';

@Injectable()
export class OrchestratorSSEService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrchestratorSSEService.name);

  // Global SSE connections (started once on boot)
  private metadataSSE: EventSource | null = null;
  private chatExternalSSE: EventSource | null = null;

  // Per-room transcript SSE: room_name → EventSource
  private readonly transcriptSSEs = new Map<string, EventSource>();

  // Retry timers
  private metadataRetryTimer: NodeJS.Timeout | null = null;
  private chatRetryTimer: NodeJS.Timeout | null = null;
  private readonly RETRY_DELAY_MS = 5000;
  private readonly MAX_RETRY_DELAY_MS = 60000;
  private metadataRetryCount = 0;
  private chatRetryCount = 0;

  // Debounce: room_name → timer
  private readonly answerDebounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingTranscripts = new Map<string, string[]>();
  private readonly ANSWER_DEBOUNCE_MS = 4000;

  // Track active rooms: room_name → session_id
  // This is in-memory fast lookup; source of truth is DB (roomName field)
  private readonly roomSessionMap = new Map<string, string>();

  // Silence timer: after bot asks a question, if no answer in 15s → skip to next
  private readonly silenceTimers = new Map<string, NodeJS.Timeout>();
  private readonly SILENCE_TIMEOUT_MS = 15_000;

  constructor(
    private readonly configService: ConfigService,
    private readonly agentService: AgentService,
    private readonly sessionService: InterviewSessionService,
    private readonly interviewerService: EnhancedInterviewerService,
    private readonly templateService: TemplateService,
    private readonly axiosClient: AxiosClient,
    private readonly minioService: MinioService,
    private readonly chatService: ChatService,
    // private readonly scoringService: ScoringService,
  ) {}

  onModuleInit() {
    this.logger.log('🚀 OrchestratorSSEService starting - subscribing global SSE streams...');
    this.subscribeMetadata();
    this.subscribeChatExternal();
  }

  onModuleDestroy() {
    this.logger.log('🛑 OrchestratorSSEService shutting down...');
    this.metadataSSE?.close();
    this.chatExternalSSE?.close();
    for (const es of this.transcriptSSEs.values()) es.close();
    if (this.metadataRetryTimer) clearTimeout(this.metadataRetryTimer);
    if (this.chatRetryTimer) clearTimeout(this.chatRetryTimer);
  }

  // ─────────────────────────────────────────────
  // GLOBAL SSE: Metadata
  // ─────────────────────────────────────────────

  private subscribeMetadata(): void {
    const baseUrl = this.configService.get<string>('AGENT_BASE_URL')!;
    const appid = this.configService.get<string>('MEZON_BOT_ID')!;
    const token = this.configService.get<string>('MEZON_TOKEN')!;
    const url = `${baseUrl}/api/sse/metadata?appid=${appid}&token=${token}`;

    this.logger.log('📡 Subscribing SSE /api/sse/metadata...');
    const es = new EventSource(url);

    es.onopen = () => {
      this.logger.log('✅ SSE /api/sse/metadata connected');
      this.metadataRetryCount = 0;
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleMetadataEvent(data);
      } catch {
        this.logger.warn(`[Metadata SSE] Failed to parse: ${event.data}`);
      }
    };

    es.onerror = () => {
      this.logger.error('[Metadata SSE] Connection error, will retry...');
      es.close();
      this.metadataSSE = null;
      this.scheduleMetadataRetry();
    };

    this.metadataSSE = es;
  }

  private scheduleMetadataRetry(): void {
    const delay = Math.min(
      this.RETRY_DELAY_MS * Math.pow(2, this.metadataRetryCount),
      this.MAX_RETRY_DELAY_MS,
    );
    this.metadataRetryCount++;
    this.logger.warn(`🔄 Retrying /api/sse/metadata in ${delay}ms (attempt ${this.metadataRetryCount})`);
    this.metadataRetryTimer = setTimeout(() => this.subscribeMetadata(), delay);
  }

  private handleMetadataEvent(data: any): void {
    const eventType = data.event_type;
    const roomName = data.room?.room_name;
    const roomId = data.room?.room_id;

    this.logger.log(`[Metadata] event_type=${eventType} room=${roomName}`);

    switch (eventType) {
      case 'room_started':
        // Room started - just log, wait for *start command
        this.logger.log(`🏠 Room started: ${roomName} (${roomId})`);
        break;

      case 'room_ended':
        this.handleRoomEnded(roomName);
        break;

      case 'room_record_done':
        this.handleRecordDone(roomName, data.metadata?.file_results || []);
        break;

      default:
        this.logger.debug(`[Metadata] Unknown event type: ${eventType}`);
    }
  }

  private async handleRecordDone(
    roomName: string,
    fileResults: {
      participant_identity: string;
      filename: string;
      started_at_ns: string;
      ended_at_ns: string;
    }[],
  ): Promise<void> {
    this.logger.log(`🎙️ room_record_done for room ${roomName}, ${fileResults.length} files`);

    if (!fileResults.length) {
      this.logger.warn(`[RecordDone] No file results for room ${roomName}`);
      return;
    }

    const session = await this.sessionService.getSessionByRoomName(roomName);
    if (!session) {
      this.logger.warn(`[RecordDone] No session found for room ${roomName}`);
      return;
    }

    this.logger.log(`[RecordDone] Processing audio for session ${session.id}`);

    try {
      const minioEndpoint = this.configService.get<string>('MINIO_ENDPOINT')!;
      const minioBucket = this.configService.get<string>('MINIO_BUCKET')!;

      // Build tracks from file_results using started_at_ns as timestamp key
      const tracksRecord: Record<string, string> = {};
      for (const f of fileResults) {
        tracksRecord[f.started_at_ns] = f.filename;
      }

      // Save individual track URLs to DB
      const tracksWithOffset = parseTracksWithOffset(tracksRecord, minioEndpoint, minioBucket);
      const individualUrls = tracksWithOffset.map(t => t.url);
      await this.sessionService.addAudioUrls(session.id, individualUrls);
      this.logger.log(`✅ Saved ${individualUrls.length} track URL(s) to session ${session.id}`);

      // Merge tracks
      this.logger.log(`🎵 Merging ${tracksWithOffset.length} tracks...`);
      const mergedPath = await mergeRoomAudio(tracksWithOffset);
      this.logger.log(`✅ Merged at: ${mergedPath}`);

      // Upload merged to MinIO
      const mergedUrl = await this.minioService.uploadFile(mergedPath);
      this.logger.log(`📦 Merged uploaded: ${mergedUrl}`);

      if (session.isExternal) {
        await this.chatService.sendAudioLinksToChatExternal(
          roomName,
          session.template.name,
          [mergedUrl],
        );
        this.logger.log(`📤 Sent audio link to external room ${roomName}`);
      } else {
        await this.chatService.sendAudioLinksToChat(
          session.channelId,
          session.template.name,
          [mergedUrl],
        );
        this.logger.log(`📤 Sent audio link to clan channel ${session.channelId}`);
      }

      // // Trigger scoring async — does not block audio delivery to user
      // const questions = session.selectedQuestions || [];
      // if (questions.length > 0) {
      //   this.scoringService.scoreInterview(
      //     session.id,
      //     mergedUrl,
      //     questions,
      //     async (scores) => {
      //       await this.sessionService.saveQuestionScores(session.id, scores);

      //       // Overall score = average of questions that have answers (score > 0)
      //       const validScores = scores.filter(s => s.score > 0);
      //       if (validScores.length > 0) {
      //         const avg = validScores.reduce((sum, s) => sum + s.score, 0) / validScores.length;
      //         const totalScore = Math.round(avg * 10) / 10;
      //         await this.sessionService.updateOverallScore(session.id, totalScore);
      //         this.logger.log(`[Scoring] Overall score: ${totalScore}/10 for session ${session.id}`);
      //       }
      //     },
      //   ).catch(err => this.logger.error(`[Scoring] Async error:`, err.message));
      // } else {
      //   this.logger.warn(`[Scoring] No questions found for session ${session.id}, skipping`);
      // }

    } catch (error) {
     this.logger.error(`[RecordDone] Failed to process audio:`, error);
      await this.sendChatMessage(roomName, `❌ Failed to process recording: ${error.message}`);
    }
  }

  private async handleRoomEnded(roomName: string): Promise<void> {
    this.logger.log(`🏁 Room ended: ${roomName}`);

    // Close transcript SSE for this room
    const transcriptSSE = this.transcriptSSEs.get(roomName);
    if (transcriptSSE) {
      transcriptSSE.close();
      this.transcriptSSEs.delete(roomName);
      this.logger.log(`🔌 Closed transcript SSE for room ${roomName}`);
    }

    // Cleanup debounce
    const timer = this.answerDebounceTimers.get(roomName);
    if (timer) {
      clearTimeout(timer);
      this.answerDebounceTimers.delete(roomName);
    }
    this.pendingTranscripts.delete(roomName);
    this.roomSessionMap.delete(roomName);
  }

  // ─────────────────────────────────────────────
  // GLOBAL SSE: Chat External
  // ─────────────────────────────────────────────

  private subscribeChatExternal(): void {
    const baseUrl = this.configService.get<string>('AGENT_BASE_URL')!;
    const appid = this.configService.get<string>('MEZON_BOT_ID')!;
    const token = this.configService.get<string>('MEZON_TOKEN')!;
    const url = `${baseUrl}/api/sse/chat_external?appid=${appid}&token=${token}`;

    this.logger.log('💬 Subscribing SSE /api/sse/chat_external...');
    const es = new EventSource(url);

    es.onopen = () => {
      this.logger.log('✅ SSE /api/sse/chat_external connected');
      this.chatRetryCount = 0;
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleChatExternalEvent(data);
      } catch {
        this.logger.warn(`[ChatExternal SSE] Failed to parse: ${event.data}`);
      }
    };

    es.onerror = () => {
      this.logger.error('[ChatExternal SSE] Connection error, will retry...');
      es.close();
      this.chatExternalSSE = null;
      this.scheduleChatRetry();
    };

    this.chatExternalSSE = es;
  }

  private scheduleChatRetry(): void {
    const delay = Math.min(
      this.RETRY_DELAY_MS * Math.pow(2, this.chatRetryCount),
      this.MAX_RETRY_DELAY_MS,
    );
    this.chatRetryCount++;
    this.logger.warn(`🔄 Retrying /api/sse/chat_external in ${delay}ms (attempt ${this.chatRetryCount})`);
    this.chatRetryTimer = setTimeout(() => this.subscribeChatExternal(), delay);
  }

  private handleChatExternalEvent(data: any): void {
    const roomName = data.room_name;
    const identity = data.participant_identity;
    const message: string = (data.message || '').trim();

    if (!roomName || !identity || !message) return;

    // Ignore bot's own messages
    const botId = this.configService.get<string>('MEZON_BOT_ID')!;
    if (identity.startsWith(botId) || identity.includes('agent-')) return;

    this.logger.log(`[ChatExternal] room=${roomName} identity=${identity} msg="${message}"`);

    // Parse commands
    if (message === '*templates') {
      this.handleTemplatesCommand(roomName);
    } else if (message.startsWith('*start')) {
      this.handleStartCommand(roomName, identity, message);
    } else if (message === '*stop' || message === '*cancel') {
      this.handleStopCommand(roomName, identity);
    } else if (message === '*end') {
      this.handleEndCommand(roomName, identity);
    }
  }

  // ─────────────────────────────────────────────
  // Command Handlers
  // ─────────────────────────────────────────────

  private async handleTemplatesCommand(roomName: string): Promise<void> {
    try {
      const templates = await this.templateService.getActiveTemplates();
      if (!templates.length) {
        await this.sendChatMessage(roomName, '❌ No templates available.');
        return;
      }

      const lines = [
        '📋 Available Interview Templates:',
        '━━━━━━━━━━━━━━━━━━━━━━',
        ...templates.map((t, i) =>
          `${i + 1}. ${t.name} (${t.numberOfQuestions} questions, level: ${t.level})`
        ),
        '━━━━━━━━━━━━━━━━━━━━━━',
        'Type *start <number> to begin. Example: *start 1',
      ];

      await this.sendChatMessage(roomName, lines.join('\n'));
    } catch (error) {
      this.logger.error('Error in handleTemplatesCommand:', error);
    }
  }

  private async handleStartCommand(roomName: string, participantIdentity: string, message: string): Promise<void> {
    try {
      this.logger.log(`🚀 *start from ${participantIdentity} in room ${roomName}`);

      // Check if already active session for this room
      const existing = await this.sessionService.getSessionByRoomName(roomName);
      if (existing && (existing.status === 'in_progress' || existing.status === 'pending')) {
        await this.sendChatMessage(roomName, '⚠️ An interview session is already active in this room.');
        return;
      }

      // Parse template number: *start 2 → index 1
      const parts = message.trim().split(/\s+/);
      const templateNumber = parts[1] ? parseInt(parts[1], 10) : NaN;

      const templates = await this.templateService.getActiveTemplates();
      if (!templates.length) {
        await this.sendChatMessage(roomName, '❌ No interview templates available.');
        return;
      }

      let selectedTemplate = templates[0];
      if (!isNaN(templateNumber) && templateNumber >= 1 && templateNumber <= templates.length) {
        selectedTemplate = templates[templateNumber - 1];
      } else if (!isNaN(templateNumber)) {
        await this.sendChatMessage(
          roomName,
          `❌ Invalid template number. Use *templates to see available options.`
        );
        return;
      }
      await this.sendChatMessage(roomName, `⏳ Starting interview with template: ${selectedTemplate.name}...`);

      const session = await this.sessionService.createSession(
        participantIdentity,
        participantIdentity,
        roomName,
        roomName,
        selectedTemplate.id,
        SessionMode.VOICE,
        true,
      );

      // Map room → session in memory
      this.roomSessionMap.set(roomName, session.id);

      await this.sessionService.startSession(session.id);
      this.logger.log(`✅ Session ${session.id} created for room ${roomName}`);

      // Invite agent + setup transcript SSE
      await this.agentService.handleInviteAgentExternal(roomName, session.id);
      // Subscribe transcript SSE for this room
      this.subscribeTranscript(roomName, session.id);

      // Generate and send greeting
      const greeting = await this.interviewerService.generateGreeting(selectedTemplate);
      await this.sessionService.addMessage(session.id, MessageRole.ASSISTANT, greeting, MessageType.TEXT);

      await this.agentService.sendTTS(roomName, greeting);
      await this.sendChatMessage(roomName, `🤖 ${greeting}`);
      this.logger.log(`✅ Interview started in room ${roomName}`);
    } catch (error) {
      this.logger.error(`Error in handleStartCommand:`, error);
      await this.sendChatMessage(roomName, `❌ Failed to start interview: ${error.message}`);
    }
  }

  private async handleStopCommand(roomName: string, participantIdentity: string): Promise<void> {
    try {
      const session = await this.sessionService.findSessionByUserAndRoom(participantIdentity, roomName);
      if (!session) {
        await this.sendChatMessage(roomName, '⚠️ No active interview session found.');
        return;
      }

      await this.agentService.handleRemoveAgentExternal(roomName, session.id);
      await this.sessionService.cancelSession2(session.id);
      this.roomSessionMap.delete(roomName);

      await this.sendChatMessage(roomName, '🛑 Interview session cancelled.');
      this.logger.log(`Session ${session.id} cancelled by ${participantIdentity}`);
    } catch (error) {
      this.logger.error(`Error in handleStopCommand:`, error);
    }
  }

  private async handleEndCommand(roomName: string, participantIdentity: string): Promise<void> {
    try {
      const session = await this.sessionService.findSessionByUserAndRoom(participantIdentity, roomName);
      if (!session) {
        await this.sendChatMessage(roomName, '⚠️ No active interview session found.');
        return;
      }

      await this.sendChatMessage(roomName, '⏳ Ending session, please wait for your recording...');

      // Remove agent → agent generates audio → POSTs to /api/interview/audio automatically
      await this.agentService.handleRemoveAgentExternal(roomName, session.id);

      // Close transcript SSE for this room
      this.closeTranscriptForRoom(roomName);

      this.logger.log(`✅ Session ${session.id} ended by ${participantIdentity} in room ${roomName}`);
    } catch (error) {
      this.logger.error(`Error in handleEndCommand:`, error);
      await this.sendChatMessage(roomName, `❌ Failed to end session: ${error.message}`);
    }
  }

  // ─────────────────────────────────────────────
  // Per-room Transcript SSE
  // ─────────────────────────────────────────────

  private subscribeTranscript(roomName: string, sessionId: string, retry = 0): void {
    const baseUrl = this.configService.get<string>('AGENT_BASE_URL')!;
    const appid = this.configService.get<string>('MEZON_BOT_ID')!;
    const token = this.configService.get<string>('MEZON_TOKEN')!;
    const url = `${baseUrl}/api/sse/stream_transcript?appid=${appid}&token=${token}&room=${roomName}`;

    this.logger.log(`🎙️ Subscribing transcript SSE for room ${roomName} (retry=${retry})`);
    const es = new EventSource(url);

    es.onopen = () => {
      this.logger.log(`✅ Transcript SSE connected for room ${roomName}`);
    };

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const identity = parsed.participant_identity || '';

        // Ignore bot's own speech
        // if (identity.startsWith('agent-') || identity.includes('UNKNOWN')) return;

        if (parsed.type === 'PARTIAL') {
          this.resetDebounce(roomName, sessionId);
          return;
        }

        if (parsed.type === 'FINAL') {
          this.handleFinalTranscript(roomName, sessionId, parsed.message);
        }
      } catch {
        this.logger.warn(`[Transcript SSE][${roomName}] Failed to parse: ${event.data}`);
      }
    };

    es.onerror = () => {
      this.logger.error(`[Transcript SSE][${roomName}] Error`);
      es.close();
      this.transcriptSSEs.delete(roomName);

      // Only retry if session still active
      if (this.roomSessionMap.has(roomName) && retry < 5) {
        const delay = 2000 + retry * 1000;
        setTimeout(() => this.subscribeTranscript(roomName, sessionId, retry + 1), delay);
      }
    };

    this.transcriptSSEs.set(roomName, es);
  }

  private handleFinalTranscript(roomName: string, sessionId: string, text: string): void {
    const trimmed = text?.trim();
    if (!trimmed || trimmed.length < 2) return;

    this.logger.log(`[Transcript][${roomName}] FINAL: "${trimmed}"`);

    const chunks = this.pendingTranscripts.get(roomName) || [];
    chunks.push(trimmed);
    this.pendingTranscripts.set(roomName, chunks);

    const existing = this.answerDebounceTimers.get(roomName);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.answerDebounceTimers.delete(roomName);
      const fullText = (this.pendingTranscripts.get(roomName) || []).join(' ');
      this.pendingTranscripts.delete(roomName);

      if (fullText.trim()) {
        this.logger.log(`[Transcript][${roomName}] ⏱️ Debounce fired: "${fullText}"`);
        this.processVoiceAnswer(roomName, sessionId, fullText);
      }
    }, this.ANSWER_DEBOUNCE_MS);

    this.answerDebounceTimers.set(roomName, timer);
  }

  private resetDebounce(roomName: string, sessionId: string): void {
    const existing = this.answerDebounceTimers.get(roomName);
    if (!existing) return;

    clearTimeout(existing);
    const timer = setTimeout(() => {
      this.answerDebounceTimers.delete(roomName);
      const fullText = (this.pendingTranscripts.get(roomName) || []).join(' ');
      this.pendingTranscripts.delete(roomName);
      if (fullText.trim()) {
        this.processVoiceAnswer(roomName, sessionId, fullText);
      }
    }, this.ANSWER_DEBOUNCE_MS);

    this.answerDebounceTimers.set(roomName, timer);
  }

  // ─────────────────────────────────────────────
  // Interview Logic
  // ─────────────────────────────────────────────

  private async processVoiceAnswer(
    roomName: string,
    sessionId: string,
    fullText: string,
  ): Promise<void> {
    try {
      this.clearSilenceTimer(roomName);
      
      const session = await this.sessionService.getSessionById(sessionId);
      if (!session) return;

      const userMessages = session.messages?.filter((m: any) => m.role === MessageRole.USER) || [];
      const isFirstMessage = userMessages.length === 0;

      await this.sessionService.addMessage(
        session.id,
        MessageRole.USER,
        fullText,
        MessageType.AUDIO,
        isFirstMessage ? undefined : session.currentQuestionIndex,
      );

      // Show user's answer in room chat
      await this.sendChatMessage(roomName, `🎤 ${fullText}`);

      await this.processNextStep(session, roomName);
    } catch (error) {
      this.logger.error(`[processVoiceAnswer] Error:`, error);
    }
  }

  private async processNextStep(session: any, roomName: string): Promise<void> {
    const freshSession = await this.sessionService.getSessionById(session.id);
    const nextQuestionNumber = freshSession.currentQuestionIndex + 1;
    const totalQuestions = freshSession.template.numberOfQuestions;

    if (nextQuestionNumber > totalQuestions) {
      // Interview complete
      this.logger.log(`✅ Interview complete for session ${session.id}`);

      const overallFeedback = await this.interviewerService.generateOverallFeedback(freshSession);
      await this.sessionService.completeSession(session.id, overallFeedback);

      const spokenCompletion = 'Congratulations! You have completed the interview. Thank you for your time. Please click on robot icon to receive your audio recording.';

      await this.sessionService.addMessage(session.id, MessageRole.ASSISTANT, spokenCompletion, MessageType.TEXT);
      await this.agentService.sendTTS(roomName, spokenCompletion);
      await this.sendChatMessage(roomName,
        `🎉 Congratulations! You have completed the interview. Thank you for your time. Please click on robot icon to receive your audio recording.`
      );
      return;
    }

    // Generate next question
    const nextQuestion = await this.interviewerService.generateQuestion(freshSession, nextQuestionNumber);
    await this.sessionService.addMessage(session.id, MessageRole.ASSISTANT, nextQuestion, MessageType.TEXT, nextQuestionNumber);
    await this.agentService.sendTTS(roomName, nextQuestion);
    await this.sendChatMessage(roomName, `❓ **Question ${nextQuestionNumber}/${totalQuestions}:**\n${nextQuestion}`);

    this.startSilenceTimer(roomName, session.id, nextQuestionNumber, totalQuestions);
  }

  private startSilenceTimer(
    roomName: string,
    sessionId: string,
    questionNumber: number,
    totalQuestions: number,
  ): void {
    this.clearSilenceTimer(roomName);

    const timer = setTimeout(async () => {
      this.silenceTimers.delete(roomName);
      this.logger.warn(`[Silence] No answer for Q${questionNumber} in room ${roomName} after ${this.SILENCE_TIMEOUT_MS}ms — skipping`);

      try {
        await this.sendChatMessage(roomName, `⏭️ No answer detected, moving to next question...`);

        // Save a placeholder answer so currentQuestionIndex advances
        await this.sessionService.addMessage(
          sessionId,
          MessageRole.USER,
          '[No answer — skipped due to silence]',
          MessageType.AUDIO,
          questionNumber,
        );

        const session = await this.sessionService.getSessionById(sessionId);
        if (session) {
          await this.processNextStep(session, roomName);
        }
      } catch (error) {
        this.logger.error(`[Silence] Error auto-skipping Q${questionNumber}:`, error.message);
      }
    }, this.SILENCE_TIMEOUT_MS);

    this.silenceTimers.set(roomName, timer);
    this.logger.log(`[Silence] Started 15s timer for Q${questionNumber} in room ${roomName}`);
  }

  private clearSilenceTimer(roomName: string): void {
    const timer = this.silenceTimers.get(roomName);
    if (timer) {
      clearTimeout(timer);
      this.silenceTimers.delete(roomName);
    }
  }

  private async sendChatMessage(roomName: string, text: string): Promise<void> {
    try {
      const baseUrl = this.configService.get<string>('AGENT_BASE_URL')!;
      const appid = this.configService.get<string>('MEZON_BOT_ID')!;
      const token = this.configService.get<string>('MEZON_TOKEN')!;

      await this.axiosClient.getInstance().post(
        `${baseUrl}/api/chat_external/send_message`,
        { account: { appid, token }, room_name: roomName, text },
      );
    } catch (error) {
      this.logger.error(`Failed to send chat message to room ${roomName}:`, error.message);
    }
  }

  public closeTranscriptForRoom(roomName: string): void {
    const es = this.transcriptSSEs.get(roomName);
    if (es) {
      es.close();
      this.transcriptSSEs.delete(roomName);
      this.logger.log(`🔌 Closed transcript SSE for room ${roomName}`);
    }
    this.answerDebounceTimers.delete(roomName);
    this.pendingTranscripts.delete(roomName);
    this.roomSessionMap.delete(roomName);
  }
}
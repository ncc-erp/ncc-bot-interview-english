import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventSource } from 'eventsource';
import { AgentService } from '@/agent/agent.provider';
import { InterviewSessionService } from '@/interviewer/interview-session.service';
import { EnhancedInterviewerService } from '@/interviewer/interview.service';
import { TemplateService } from '@/interviewer/template.service';
import { MessageRole, MessageType } from '@/database-test/entities/session-message.entity';
import { SessionMode, SessionStatus } from '@/database-test/entities/interview-session-test.entity';
import { AxiosClient } from '@/shared/lib/axios-client';
import { AGENT_ENDPOINTS } from '@/shared/constants/agent';
import { EventSourcePolyfill } from 'event-source-polyfill';
import { BotAuthService } from '@/auth/bot-auth.service';
import { InterviewTemplate } from '@/database-test/entities/interview-template.entity';

@Injectable()
export class OrchestratorSSEService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrchestratorSSEService.name);

  // Global SSE connections (started once on boot)
  private metadataSSE: EventSourcePolyfill | null = null;
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
  private readonly MAX_REASK_COUNT = 2;

  // Track active rooms: room_name → session_id
  // This is in-memory fast lookup; source of truth is DB (roomName field)
  private readonly roomSessionMap = new Map<string, string>();

  // Silence timer: after bot asks a question, if no answer in 15s → skip to next
  private readonly silenceTimers = new Map<string, NodeJS.Timeout>();
  private readonly SILENCE_TIMEOUT_MS = 15_000;

  private readonly roomIds = new Map<string, string>();
  private readonly awaitingTemplateSelection = new Map<string, { identity: string; timestamp: number }>();
  private readonly templateSelectionTimers = new Map<string, NodeJS.Timeout>();
  private authToken: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly agentService: AgentService,
    private readonly sessionService: InterviewSessionService,
    private readonly interviewerService: EnhancedInterviewerService,
    private readonly templateService: TemplateService,
    private readonly axiosClient: AxiosClient,
    private readonly botAuthService: BotAuthService,
  ) {
    this.logger.log('SSE Service instance created');
  }

  async onModuleInit() {
    this.authToken = await this.botAuthService.getValidAccessToken();
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
    for (const timer of this.templateSelectionTimers.values()) clearTimeout(timer);
    this.templateSelectionTimers.clear();
  }

  // ─────────────────────────────────────────────
  // GLOBAL SSE: Metadata
  // ─────────────────────────────────────────────

  private subscribeMetadata(): void {
    const baseUrl = this.configService.get<string>('AGENT_BASE_URL')!;
    const url = `${baseUrl}/api/v2/sse/metadata`;

    this.logger.log('📡 Subscribing SSE /api/v2/sse/metadata...');
    const es = new EventSourcePolyfill(url, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });

    es.onopen = () => {
      this.logger.log('✅ SSE /api/v2/sse/metadata connected');
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

    es.onerror = async () => {
      this.logger.error('[Metadata SSE] Connection error, will retry...');
      es.close();
      this.metadataSSE = null;
      this.authToken = await this.botAuthService.getValidAccessToken();
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

    if (roomName && roomId) {
      this.roomIds.set(roomName, roomId);
    }

    switch (eventType) {
      case 'room_started':
        // Room started - just log, wait for *start command
        this.logger.log(`🏠 Room started: ${roomName} (${roomId})`);
        break;

      case 'room_ended':
        this.handleRoomEnded(roomName);
        break;

      default:
        this.logger.debug(`[Metadata] Unknown event type: ${eventType}`);
    }
  }

  private async handleRoomEnded(roomName: string): Promise<void> {
    this.logger.log(`🏁 Room ended: ${roomName}`);

    // Close transcript SSE for this room
    const transcriptSSE = this.transcriptSSEs.get(roomName);
    const session = await this.sessionService.getSessionByRoomName(roomName);
    this.logger.log(`Session for room ${roomName}: ${session ? session.status : 'not found'}`);
    if (session && session.status === SessionStatus.COMPLETED) {
      await this.sessionService.endSession(session.id);
    }

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
    this.clearSilenceTimer(roomName);
    this.clearTemplateSelectionTimer(roomName);
    this.awaitingTemplateSelection.delete(roomName);
    this.roomSessionMap.delete(roomName);
    this.roomIds.delete(roomName);
    //update room status 
  }

  // ─────────────────────────────────────────────
  // GLOBAL SSE: Chat External
  // ─────────────────────────────────────────────

  private subscribeChatExternal(): void {
    const baseUrl = this.configService.get<string>('AGENT_BASE_URL')!;
    const url = `${baseUrl}/api/v2/sse/chat_external`;

    this.logger.log('💬 Subscribing SSE /api/v2/sse/chat_external...');
    const es = new EventSourcePolyfill(url, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });

    es.onopen = () => {
      this.logger.log('✅ SSE /api/v2/sse/chat_external connected');
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

    es.onerror = async () => {
      this.logger.error('[ChatExternal SSE] Connection error, will retry...');
      es.close();
      this.chatExternalSSE = null;
      this.authToken = await this.botAuthService.getValidAccessToken();
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
    this.logger.warn(`🔄 Retrying /api/v2/sse/chat_external in ${delay}ms (attempt ${this.chatRetryCount})`);
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
    } else {
      this.handleNumberSelection(roomName, identity, message);
    }
  }

  // ─────────────────────────────────────────────
  // Command Handlers
  // ─────────────────────────────────────────────

  private async handleTemplatesCommand(roomName: string): Promise<void> {
    try {
      const templates = await this.templateService.getActiveTemplates();
      if (!templates.length) {
        await this.sendChatMessage(roomName, '❌ No templates available.', true);
        return;
      }

      const templatesList = templates.map((t, i) => `[${i + 1}] ${t.name}`).join('  -  ');
      await this.sendChatMessage(roomName, `📋 Templates: ${templatesList}`, true);
      await this.sendChatMessage(roomName, '👉 Type *start<number> to begin (e.g., *start1).', true);
    } catch (error) {
      this.logger.error('Error in handleTemplatesCommand:', error);
    }
  }

  private async handleStartCommand(roomName: string, participantIdentity: string, message: string): Promise<void> {
    try {
      this.logger.log(`🚀 *start from ${participantIdentity} in room ${roomName} (msg: "${message}")`);

      const templates = await this.templateService.getActiveTemplates();
      if (!templates.length) {
        await this.sendChatMessage(roomName, '❌ No templates available.', true);
        return;
      }

      const args = message.replace('*start', '').trim();
      if (!args) {
        // Set awaiting template selection state
        this.awaitingTemplateSelection.set(roomName, {
          identity: participantIdentity,
          timestamp: Date.now(),
        });
        this.startTemplateSelectionTimer(roomName, participantIdentity);

        const templatesList = templates.map((t, i) => `[${i + 1}] ${t.name}`).join('  -  ');
        await this.sendChatMessage(roomName, `📋 Templates: ${templatesList}`, true);
        await this.sendChatMessage(roomName, '👉 Reply with the number to select (e.g., 1 or 2).', true);
        return;
      }

      const index = parseInt(args, 10);
      if (isNaN(index) || index < 1 || index > templates.length) {
        await this.sendChatMessage(
          roomName,
          `❌ Invalid template number. Please choose a number from 1 to ${templates.length}. Example: *start1`,
          true
        );
        return;
      }

      // Clear any pending selection since user started directly
      this.awaitingTemplateSelection.delete(roomName);
      this.clearTemplateSelectionTimer(roomName);

      const selectedTemplate = templates[index - 1];
      await this.startInterviewWithTemplate(roomName, participantIdentity, selectedTemplate);
    } catch (error: any) {
      this.logger.error(`Error in handleStartCommand:`, error);
      await this.sendChatMessage(roomName, `❌ Failed to start interview: ${error.message}`);
    }
  }

  private async handleNumberSelection(roomName: string, participantIdentity: string, message: string): Promise<void> {
    try {
      const pending = this.awaitingTemplateSelection.get(roomName);
      if (!pending || pending.identity !== participantIdentity) {
        return; // Not awaiting selection, or not from this user
      }

      const index = parseInt(message.trim(), 10);
      if (isNaN(index)) {
        return; // Ignore non-numeric chat messages
      }

      const templates = await this.templateService.getActiveTemplates();
      if (index < 1 || index > templates.length) {
        await this.sendChatMessage(
          roomName,
          `❌ Invalid template number. Please choose a number from 1 to ${templates.length}.`,
          true
        );
        return;
      }

      // Valid number! Clear the pending selection state
      this.awaitingTemplateSelection.delete(roomName);
      this.clearTemplateSelectionTimer(roomName);

      const selectedTemplate = templates[index - 1];
      await this.startInterviewWithTemplate(roomName, participantIdentity, selectedTemplate);
    } catch (error: any) {
      this.logger.error(`Error in handleNumberSelection:`, error);
      await this.sendChatMessage(roomName, `❌ Failed to select template: ${error.message}`);
    }
  }

  private async startInterviewWithTemplate(
    roomName: string,
    participantIdentity: string,
    selectedTemplate: InterviewTemplate,
  ): Promise<void> {
    // Check if already active room
    const roomId = this.roomIds.get(roomName);
    if (!roomId) {
      await this.sendChatMessage(
        roomName,
        '⏳ Room metadata is not ready yet. Please try *start again in a moment.'
      );
      return;
    }

    const participants = await this.getRoomParticipants(roomId);
    const starterParticipant = participants.find((participant) =>
      this.isMatchingParticipant(participant, participantIdentity),
    );
    const isStarterInRoom = !!starterParticipant;

    if (!isStarterInRoom) {
      this.logger.warn(
        `[Start] Participant ${participantIdentity} not found in room ${roomName} (${roomId})`
      );
      await this.sendChatMessage(
        roomName,
        '❌ Could not verify that you are in this room. Please rejoin the room and try again.'
      );
      return;
    }
    const starterDisplayName = this.getParticipantDisplayName(starterParticipant, participantIdentity);

    // Check if already active session for this room
    const existing = await this.sessionService.getSessionByRoomName(roomName);
    if (existing && (existing.status === 'in_progress' || existing.status === 'pending')) {
      await this.sendChatMessage(roomName, '⚠️ An interview session is already active in this room.');
      return;
    }

    await this.sendChatMessage(roomName, `⏳ Starting interview with template: ${selectedTemplate.name}...`);

    const session = await this.sessionService.createSession(
      participantIdentity,
      starterDisplayName,
      roomName,
      roomName,
      selectedTemplate.id,
      SessionMode.VOICE,
      true,
      roomId,
    );

    // Map room → session in memory
    this.roomSessionMap.set(roomName, session.id);

    await this.sessionService.startSession(session.id);
    this.logger.log(`✅ Session ${session.id} created for room ${roomName}`);

    // Invite agent first to avoid long AI greeting delays before bot joins room
    await this.agentService.handleInviteAgentExternal(roomName, session.id);
    // Subscribe transcript SSE for this room
    this.subscribeTranscript(roomName, session.id);

    // Generate and send greeting
    const greeting = await this.interviewerService.generateGreeting(selectedTemplate);

    await this.sessionService.addMessage(session.id, MessageRole.ASSISTANT, greeting, MessageType.TEXT);

    await this.agentService.sendTTS(roomName, greeting);
    await this.sendChatMessage(roomName, `🤖 ${greeting}`);
    this.logger.log(`✅ Interview started in room ${roomName}`);
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
    } catch (error: any) {
      this.logger.error(`Error in handleEndCommand:`, error);
      await this.sendChatMessage(roomName, `❌ Failed to end session: ${error.message}`);
    }
  }

  // ─────────────────────────────────────────────
  // Per-room Transcript SSE
  // ─────────────────────────────────────────────

  private subscribeTranscript(roomName: string, sessionId: string, retry = 0): void {
    const baseUrl = this.configService.get<string>('AGENT_BASE_URL')!;
    const url = `${baseUrl}/api/v2/sse/stream_transcript?room=${roomName}`;

    this.logger.log(`🎙️ Subscribing transcript SSE for room ${roomName} (retry=${retry})`);
    const es = new EventSourcePolyfill(url, {
      headers: {
        Authorization: `Bearer ${this.authToken}`,
      },
    });

    es.onopen = () => {
      this.logger.log(`✅ Transcript SSE connected for room ${roomName}`);
    };

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const identity = parsed.participant_identity || '';

        // Ignore bot's own speech
        if (identity.startsWith('agent-')) return;

        if (parsed.type === 'PARTIAL') {
          this.resetDebounce(roomName, sessionId);
          this.clearSilenceTimer(roomName);
          return;
        }

        if (parsed.type === 'FINAL') {
          this.handleFinalTranscript(roomName, sessionId, parsed.message);
        }
      } catch {
        this.logger.warn(`[Transcript SSE][${roomName}] Failed to parse: ${event.data}`);
      }
    };

    es.onerror = async () => {
      this.logger.error(`[Transcript SSE][${roomName}] Error`);
      es.close();
      this.transcriptSSEs.delete(roomName);
      this.authToken = await this.botAuthService.getValidAccessToken();

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

      const spokenCompletion = 'Congratulations! You have completed the interview. Thank you for your time. Please click on robot icon to end the interview.';

      await this.sessionService.addMessage(session.id, MessageRole.ASSISTANT, spokenCompletion, MessageType.TEXT);
      await this.agentService.sendTTS(roomName, spokenCompletion);

      const shouldSend = await this.sessionService.shouldSendResultLink();
      let completeMsg = `🎉 Congratulations! You have completed the interview. Thank you for your time. Please click on robot icon to end the interview.`;
      await this.sendChatMessage(roomName, completeMsg);

      let resultMsg = '';
      if (shouldSend) {
        const adminOrigin = this.configService.get<string>('ADMIN_ORIGIN') || 'http://localhost:3000';
        const candidateLink = `${adminOrigin}/candidate-result/${freshSession.candidateToken}`;
        resultMsg = `🔗 **Your Interview Results:**\n${candidateLink}`;
        await this.sendChatMessage(roomName, "The results are currently being processed and will be available within 5 minutes.", true);
        await this.sendChatMessage(roomName, resultMsg, true);
      }
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
    retryCount = 0,
  ): void {
    this.clearSilenceTimer(roomName);

    const timer = setTimeout(async () => {
      this.silenceTimers.delete(roomName);
      this.logger.warn(`[Silence] No answer for Q${questionNumber} in room ${roomName} after ${this.SILENCE_TIMEOUT_MS}ms — skipping`);

      try {
        const session = await this.sessionService.getSessionById(sessionId);
        if (!session) return;

        if (retryCount < this.MAX_REASK_COUNT) {
          const currentQuestion =
            session.messages
              ?.filter((m: any) =>
                m.role === MessageRole.ASSISTANT &&
                m.questionIndex === questionNumber
              )
              ?.at(-1)?.content;

          const repeatText = currentQuestion || await this.interviewerService.generateQuestion(session, questionNumber);

          await this.sendChatMessage(roomName, `I didn't hear your answer. Let me repeat the question.`);
          await this.agentService.sendTTS(roomName, repeatText);
          await this.sendChatMessage(roomName, `❓ **Question ${questionNumber}/${totalQuestions}:**\n${repeatText}`);

          this.startSilenceTimer(roomName, sessionId, questionNumber, totalQuestions, retryCount + 1);
          return;
        }

        await this.sendChatMessage(roomName, `⏭️ No answer detected, moving to next question...`);

        // Save a placeholder answer so currentQuestionIndex advances
        await this.sessionService.addMessage(
          sessionId,
          MessageRole.USER,
          '[No answer — skipped due to silence]',
          MessageType.AUDIO,
          questionNumber,
        );

        const refreshed = await this.sessionService.getSessionById(sessionId);
        if (refreshed) {
          await this.processNextStep(refreshed, roomName);
        }
      } catch (error: any) {
        this.logger.error(`[Silence] Error handling Q${questionNumber}:`, error.message);
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

  private startTemplateSelectionTimer(roomName: string, participantIdentity: string): void {
    this.clearTemplateSelectionTimer(roomName);

    const timer = setTimeout(async () => {
      this.templateSelectionTimers.delete(roomName);
      const pending = this.awaitingTemplateSelection.get(roomName);
      if (pending && pending.identity === participantIdentity) {
        this.awaitingTemplateSelection.delete(roomName);
        this.logger.warn(`[Template Selection] Timeout in room ${roomName} for ${participantIdentity}`);
        await this.sendChatMessage(
          roomName,
          '⚠️ Template selection timed out. Please type *start again to show the list of templates.',
          true,
        );
      }
    }, 120_000); // 2 minutes

    this.templateSelectionTimers.set(roomName, timer);
    this.logger.log(`[Template Selection] Started 2m timer for room ${roomName}`);
  }

  private clearTemplateSelectionTimer(roomName: string): void {
    const timer = this.templateSelectionTimers.get(roomName);
    if (timer) {
      clearTimeout(timer);
      this.templateSelectionTimers.delete(roomName);
      this.logger.log(`[Template Selection] Cleared timer for room ${roomName}`);
    }
  }

  private isChatEnabled(): boolean {
    const val = this.configService.get<string>('SHOW_ROOM_CHAT', 'true');
    return val.toLowerCase() !== 'false' && val !== '0';
  }

  private async sendChatMessage(roomName: string, text: string, isSendNoti: boolean = false): Promise<void> {
    if (!this.isChatEnabled() && !isSendNoti) return;

    try {
      const baseUrl = this.configService.get<string>('AGENT_BASE_URL')!;
      const agentId = this.agentService.getAgentIdForRoom(roomName);
      await this.axiosClient.getInstance().post(
        `${baseUrl}/api/v2/dispatch/agent-request`,
        {
          room_name: roomName,
          agent_id: 'agent-e7e1b7c2-2b6e-4e2a-9c1d-7f8e2a1b2c3d',
          payload: {
            request_type: 'send_chat_message',
            message: text,
            sender_name: 'Interview Bot',
          },
        }
      );
    } catch (error: any) {
      this.logger.error(`Failed to send chat message to room ${roomName}:`, error.message);
    }
  }

  private async getRoomParticipants(roomId: string): Promise<any[]> {
    const baseUrl = this.configService.get<string>('AGENT_BASE_URL')!;
    const url = `${baseUrl}/api/v2/rooms/participant/${encodeURIComponent(roomId)}`;

    const response = await this.axiosClient.getInstance().get(url);
    const data = response.data;

    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.participants)) return data.participants;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.data?.participants)) return data.data.participants;

    this.logger.warn(`[Participants] Unexpected response format for room ${roomId}`);
    return [];
  }

  private isMatchingParticipant(participant: any, participantIdentity: string): boolean {
    const target = String(participantIdentity || '').trim();
    if (!target) return false;

    const identity = String(participant?.identity || '').trim();
    const participantIdentityField = String(participant?.participant_identity || '').trim();
    const extName = String(participant?.metadata?.extName || '').trim();
    const extId = String(participant?.metadata?.extId || '').trim();

    return [identity, participantIdentityField, extName, extId].includes(target);
  }

  private getParticipantDisplayName(participant: any, fallback: string): string {
    const extName = String(participant?.metadata?.extName || '').trim();
    const name = String(participant?.name || '').trim();
    const identity = String(participant?.identity || '').trim();

    return extName || name || identity || fallback;
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
    this.clearSilenceTimer(roomName);
    this.clearTemplateSelectionTimer(roomName);
    this.awaitingTemplateSelection.delete(roomName);
    this.roomSessionMap.delete(roomName);
    this.roomIds.delete(roomName);
  }
}
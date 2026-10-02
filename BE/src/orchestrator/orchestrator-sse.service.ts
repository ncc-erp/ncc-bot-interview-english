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
import { isRepeatRequest, isStartRequest, getRepeatText } from '@/shared/utils/interview';
import { MinioService } from '@/record-audio/minio.service';

interface AuditLogEntry {
  timestamp: string;
  tag: string;
  message: string;
  details?: any;
}

@Injectable()
export class OrchestratorSSEService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrchestratorSSEService.name);

  // Global SSE connections (started once on boot)
  private metadataSSE: EventSourcePolyfill | null = null;
  private chatExternalSSE: EventSource | null = null;

  // Per-room transcript SSE: room_name → EventSource
  private readonly transcriptSSEs = new Map<string, EventSource>();

  // Audit Logs in memory per room: room_name → AuditLogEntry[]
  private readonly sessionAuditLogs = new Map<string, AuditLogEntry[]>();

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

  // IELTS Part 2 prep timers and phase tracking
  private readonly prepTimers = new Map<string, NodeJS.Timeout>();
  private readonly isPrepPhase = new Map<string, boolean>();
  private readonly speakingTimers = new Map<string, NodeJS.Timeout>();
  private readonly isBotSpeakingNextQuestion = new Map<string, boolean>();

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
    private readonly minioService: MinioService,
  ) {
    this.logger.log('SSE Service instance created');
  }

  /**
   * Log an audit event with exact timestamp and save to room's audit stream
   */
  public logAudit(roomName: string, tag: string, message: string, details?: any): void {
    const timestamp = new Date().toISOString();
    const entry: AuditLogEntry = { timestamp, tag, message, details };

    const detailStr = details
      ? ` | Data: ${typeof details === 'string' ? details : JSON.stringify(details)}`
      : '';
    this.logger.log(`[AUDIT][${roomName}][${tag}] ${message}${detailStr}`);

    const logs = this.sessionAuditLogs.get(roomName) || [];
    logs.push(entry);
    this.sessionAuditLogs.set(roomName, logs);
  }

  /**
   * Upload all accumulated audit logs for this room/session to MinIO
   */
  public async uploadAuditLog(roomName: string, sessionId?: string): Promise<string | null> {
    const logs = this.sessionAuditLogs.get(roomName);
    if (!logs || logs.length === 0) {
      this.logger.log(`[AUDIT][${roomName}] No audit logs recorded for upload.`);
      return null;
    }

    try {
      const header = [
        '================================================================================',
        '🎙️ NCC INTERVIEW BOT - DETAILED SESSION AUDIT LOG',
        `Room Name:     ${roomName}`,
        `Session ID:    ${sessionId || 'N/A'}`,
        `Generated At:  ${new Date().toISOString()}`,
        `Total Events:  ${logs.length}`,
        '================================================================================\n',
        'TIMELINE OF EVENTS (Agent SSE Streams, User Transcripts, Debounce & TTS):',
        '--------------------------------------------------------------------------------',
      ];

      const lines = logs.map((log) => {
        let line = `[${log.timestamp}] [${log.tag.padEnd(24, ' ')}] ${log.message}`;
        if (log.details !== undefined) {
          const formatted = typeof log.details === 'string'
            ? log.details
            : JSON.stringify(log.details, null, 2);
          line += `\n    └─ Details: ${formatted.replace(/\n/g, '\n       ')}`;
        }
        return line;
      });

      const fullLogContent = [...header, ...lines, '\n============================== END OF AUDIT LOG ==============================\n'].join('\n');

      const url = await this.minioService.uploadSessionLog(sessionId || 'room', fullLogContent, roomName);

      this.logger.log(`\n================================================================================\n🔗 SESSION AUDIT LOG SAVED TO MINIO:\n👉 ${url}\n================================================================================\n`);

      this.sessionAuditLogs.delete(roomName);
      return url;
    } catch (error: any) {
      this.logger.error(`[AUDIT][${roomName}] Failed to upload audit log to MinIO: ${error.message}`);
      return null;
    }
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
    if (roomName) {
      this.logAudit(roomName, 'METADATA_EVENT', `event_type=${eventType}`, data);
    }

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
    this.logAudit(roomName, 'ROOM_ENDED', `Room ended on Agent server. Status: ${session ? session.status : 'not found'}`);

    if (session && session.status === SessionStatus.COMPLETED) {
      await this.sessionService.endSession(session.id);
    }

    // Upload full session audit log to MinIO on room end
    await this.uploadAuditLog(roomName, session?.id);

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
    this.clearPrepTimer(roomName);
    this.clearSpeakingTimer(roomName);
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
    this.logAudit(roomName, 'CHAT_EXTERNAL_MSG', `Received message from ${identity}: "${message}"`, data);

    // Parse commands
    if (message === '*templates') {
      this.handleTemplatesCommand(roomName);
    } else if (message.startsWith('*start')) {
      this.handleStartCommand(roomName, identity, message);
    } else if (message === '*stop' || message === '*cancel') {
      this.handleStopCommand(roomName, identity);
    } else if (message === '*end') {
      this.handleEndCommand(roomName, identity);
    } else if (isRepeatRequest(message)) {
      this.handleRepeatQuestionRequest(roomName, identity);
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
      this.logAudit(roomName, 'COMMAND_START', `User initiated *start: "${message}"`, { participantIdentity });

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

    const participants = await this.getRoomParticipants(roomId, roomName);
    const starterParticipant = participants.find((participant) =>
      this.isMatchingParticipant(participant, participantIdentity),
    );
    const isStarterInRoom = !!starterParticipant;

    if (!isStarterInRoom) {
      this.logger.warn(
        `[Start] Participant ${participantIdentity} not found in room ${roomName} (${roomId}). Active participants in room (${participants.length}): ${JSON.stringify(participants)}. Proceeding with fallback.`
      );
    }
    const starterDisplayName = starterParticipant
      ? this.getParticipantDisplayName(starterParticipant, participantIdentity)
      : participantIdentity;

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
    this.logAudit(roomName, 'INTERVIEW_START', `Session created & started for candidate: ${starterDisplayName}`, {
      sessionId: session.id,
      template: selectedTemplate.name,
      totalQuestions: selectedTemplate.numberOfQuestions,
    });

    // Invite agent first to avoid long AI greeting delays before bot joins room
    await this.agentService.handleInviteAgentExternal(roomName, session.id);
    // Subscribe transcript SSE for this room
    this.subscribeTranscript(roomName, session.id);

    // Generate and send greeting
    const t0 = Date.now();
    const greeting = await this.interviewerService.generateGreeting(selectedTemplate);
    const greetingDuration = Date.now() - t0;

    await this.sessionService.addMessage(session.id, MessageRole.ASSISTANT, greeting, MessageType.TEXT);

    this.logAudit(roomName, 'BOT_TTS_GREETING', `Greeting generated in ${greetingDuration}ms and dispatched to Agent TTS`, {
      greeting,
      durationMs: greetingDuration,
    });

    await this.agentService.sendTTS(roomName, greeting);
    await this.sendChatMessage(roomName, `🤖 ${greeting}`);
    this.logger.log(`✅ Interview started in room ${roomName}`);
  }


  private async handleStopCommand(roomName: string, participantIdentity: string): Promise<void> {
    try {
      this.logAudit(roomName, 'COMMAND_STOP', `Stop command received from ${participantIdentity}`);
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

      // Upload audit log to MinIO on stop
      await this.uploadAuditLog(roomName, session.id);
    } catch (error) {
      this.logger.error(`Error in handleStopCommand:`, error);
    }
  }

  private async handleEndCommand(roomName: string, participantIdentity: string): Promise<void> {
    try {
      this.logAudit(roomName, 'COMMAND_END', `End command received from ${participantIdentity}`);
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

      // Upload audit log to MinIO on end
      await this.uploadAuditLog(roomName, session.id);
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
      this.logAudit(roomName, 'TRANSCRIPT_SSE_OPEN', 'Connected to Agent transcript SSE stream');
    };

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const identity = parsed.participant_identity || '';

        // Ignore bot's own speech
        if (identity.startsWith('agent-')) return;

        if (parsed.type === 'PARTIAL') {
          this.logAudit(roomName, 'SSE_STREAM_PARTIAL', `PARTIAL speech: "${parsed.message || ''}"`, {
            participant: identity,
            is_final: parsed.is_final,
          });
          this.resetDebounce(roomName, sessionId);
          this.clearSilenceTimer(roomName);
          return;
        }

        if (parsed.type === 'FINAL') {
          this.logAudit(roomName, 'SSE_STREAM_FINAL', `FINAL chunk: "${parsed.message || ''}"`, {
            participant: identity,
            raw: parsed,
          });
          this.handleFinalTranscript(roomName, sessionId, parsed.message);
        }
      } catch {
        this.logger.warn(`[Transcript SSE][${roomName}] Failed to parse: ${event.data}`);
        this.logAudit(roomName, 'SSE_STREAM_PARSE_ERR', `Failed to parse transcript event: ${event.data}`);
      }
    };

    es.onerror = async () => {
      this.logger.error(`[Transcript SSE][${roomName}] Error`);
      this.logAudit(roomName, 'TRANSCRIPT_SSE_ERR', `Transcript SSE error. Reconnect attempt ${retry + 1}/5`);
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

  private getSectionForQuestionNumber(session: any, questionNumber: number): any | null {
    if (!session?.selectedSections || !session?.selectedQuestions) return null;
    const targetQuestion = session.selectedQuestions[questionNumber - 1];
    if (!targetQuestion) return null;

    for (const section of session.selectedSections) {
      if (section.selectedQuestions?.includes(targetQuestion)) {
        return section;
      }
    }
    return null;
  }

  private clearPrepTimer(roomName: string): void {
    const timer = this.prepTimers.get(roomName);
    if (timer) {
      clearTimeout(timer);
      this.prepTimers.delete(roomName);
    }
    this.isPrepPhase.delete(roomName);
    this.isBotSpeakingNextQuestion.delete(roomName);
  }

  private clearSpeakingTimer(roomName: string): void {
    const timer = this.speakingTimers.get(roomName);
    if (timer) {
      clearTimeout(timer);
      this.speakingTimers.delete(roomName);
    }
    this.isBotSpeakingNextQuestion.delete(roomName);
  }

  private startPart2SpeakingTimer(
    roomName: string,
    sessionId: string,
    questionNumber: number,
    totalQuestions: number,
    speakingSeconds: number,
  ): void {
    // Trigger notification 5s before actual time-up to compensate for TTS latency
    const effectiveSpeakingTimerMs = Math.max(5, speakingSeconds - 5) * 1000;

    this.logAudit(roomName, 'PART2_SPEAKING_START', `Started ${speakingSeconds}s speaking timer for Q${questionNumber}`, {
      questionNumber,
      speakingSeconds,
      timerMs: effectiveSpeakingTimerMs,
    });

    const timer = setTimeout(async () => {
      this.speakingTimers.delete(roomName);
      this.logger.log(`[Part 2] Speaking time limit reached (triggered 5s early at ${effectiveSpeakingTimerMs / 1000}s) for Q${questionNumber} in room ${roomName}`);
      this.logAudit(roomName, 'PART2_SPEAKING_TIME_UP', `Part 2 speaking time expired for Q${questionNumber}`);

      // Lock transcript listening immediately to ignore late Part 2 speech & transition noise
      this.isBotSpeakingNextQuestion.set(roomName, true);

      // Clear any pending answer debounce timer and silence timer
      const debounceTimer = this.answerDebounceTimers.get(roomName);
      if (debounceTimer) clearTimeout(debounceTimer);
      this.answerDebounceTimers.delete(roomName);
      this.clearSilenceTimer(roomName);

      // Collect whatever text candidate spoke so far
      const pending = this.pendingTranscripts.get(roomName) || [];
      this.pendingTranscripts.delete(roomName);
      const fullText = pending.join(' ').trim() || '[Speaking time ended]';

      // Announce to candidate that speaking time is up
      const timeUpMsg = `⏰ Your speaking time for Part 2 is up. Thank you!`;
      await this.sendChatMessage(roomName, timeUpMsg, true);
      await this.agentService.sendTTS(roomName, `Your speaking time for this part is up. Thank you.`);

      // Delay 10 seconds before transitioning to Part 3 so user hears the time-up message and gets a smooth pause
      setTimeout(async () => {
        try {
          const session = await this.sessionService.getSessionById(sessionId);
          if (session) {
            const userMessages = session.messages?.filter((m: any) => m.role === MessageRole.USER) || [];
            const isFirstMessage = userMessages.length === 0;

            await this.sessionService.addMessage(
              session.id,
              MessageRole.USER,
              fullText,
              MessageType.AUDIO,
              isFirstMessage ? undefined : session.currentQuestionIndex,
            );

            // Clean up any stray transcripts/timers before transition
            const strayTimer = this.answerDebounceTimers.get(roomName);
            if (strayTimer) clearTimeout(strayTimer);
            this.answerDebounceTimers.delete(roomName);
            this.pendingTranscripts.delete(roomName);

            await this.processNextStep(session, roomName);
          }
        } catch (e: any) {
          this.logger.error(`Error handling Part 2 speaking time expiration:`, e);
        }
      }, 10000);
    }, effectiveSpeakingTimerMs);

    this.speakingTimers.set(roomName, timer);
    this.logger.log(`[Part 2] Started ${effectiveSpeakingTimerMs / 1000}s speaking timer (5s buffer applied) for Q${questionNumber} in room ${roomName}`);
  }

  private async handlePart2QuestionStart(
    roomName: string,
    sessionId: string,
    questionNumber: number,
    totalQuestions: number,
    section: any,
    cueCardContent: string,
    introPrefix = '',
  ): Promise<void> {
    const prepSeconds = section.prepTimeSeconds ?? 60;

    // 1. Send the Cue Card content into chat
    const cueCardChatMsg = `📋 **Topic:**\n\n${cueCardContent}`;
    await this.sendChatMessage(roomName, cueCardChatMsg, true);

    // 2. Bot speaks standard IELTS Part 2 instruction via TTS (combining intro into a single TTS call)
    const instructionBody = `I'm going to give you a topic and I'd like you to talk about it for one to two minutes. You have ${prepSeconds} seconds to prepare your answer.`;
    const part2Instruction = introPrefix ? `${introPrefix} ${instructionBody}` : `Now, ${instructionBody}`;
    await this.agentService.sendTTS(roomName, part2Instruction);

    // 3. Mark preparation phase
    this.isPrepPhase.set(roomName, true);
    this.clearPrepTimer(roomName);

    this.logAudit(roomName, 'PART2_PREP_START', `Started ${prepSeconds}s prep phase for Q${questionNumber}`, {
      cueCardTopic: cueCardContent,
      prepSeconds,
    });

    // 4. Add 5s buffer to preparation timer for TTS speech time and network latency
    const totalPrepTimerMs = (prepSeconds + 5) * 1000;

    const timer = setTimeout(async () => {
      this.prepTimers.delete(roomName);
      this.isPrepPhase.delete(roomName);
      this.logAudit(roomName, 'PART2_PREP_TIMEOUT', `Preparation time expired for Q${questionNumber}`);

      const startSpeakingMsg = `🔔 Preparation time is up. Please start speaking now!`;
      await this.sendChatMessage(roomName, startSpeakingMsg);
      await this.agentService.sendTTS(roomName, `Your preparation time is up. Please start speaking now.`);

      // Start Part 2 speaking timer & silence timer
      const speakingSeconds = section.speakingTimeSeconds ?? 120;
      this.startPart2SpeakingTimer(roomName, sessionId, questionNumber, totalQuestions, speakingSeconds);
      this.startSilenceTimer(roomName, sessionId, questionNumber, totalQuestions, 0, true);
    }, totalPrepTimerMs);

    this.prepTimers.set(roomName, timer);
    this.logger.log(`[Part 2] Started ${prepSeconds}+5s prep timer for Q${questionNumber} in room ${roomName}`);
  }

  private async handleFinalTranscript(roomName: string, sessionId: string, text: string): Promise<void> {
    const trimmed = text?.trim();
    if (!trimmed || trimmed.length < 2) return;

    if (this.isBotSpeakingNextQuestion.get(roomName)) {
      this.logger.log(`[Transcript][${roomName}] Ignored while bot is introducing section/question: "${trimmed}"`);
      this.logAudit(roomName, 'TRANSCRIPT_IGNORED', `Ignored because bot is speaking next question: "${trimmed}"`);
      return;
    }

    this.logger.log(`[Transcript][${roomName}] FINAL: "${trimmed}"`);

    // Check if in IELTS Part 2 preparation phase
    if (this.isPrepPhase.get(roomName)) {
      const lower = trimmed.toLowerCase();
      if (lower.includes('ready') || lower.includes('start') || isStartRequest(trimmed)) {
        this.logger.log(`[Part 2 Prep][${roomName}] ⚡ Candidate ready early during prep phase: "${trimmed}"`);
        this.logAudit(roomName, 'PART2_PREP_FAST_READY', `Candidate signaled ready early: "${trimmed}"`);
        this.clearPrepTimer(roomName);

        const startSpeakingMsg = `👍 Great! Please start speaking now.`;
        await this.sendChatMessage(roomName, startSpeakingMsg);
        await this.agentService.sendTTS(roomName, `Great! Please start speaking now.`);

        const session = await this.sessionService.getSessionById(sessionId);
        if (session) {
          const currentSection = this.getSectionForQuestionNumber(session, session.currentQuestionIndex);
          const speakingSeconds = currentSection?.speakingTimeSeconds ?? 120;
          this.startPart2SpeakingTimer(roomName, sessionId, session.currentQuestionIndex, session.template.numberOfQuestions, speakingSeconds);
          this.startSilenceTimer(roomName, sessionId, session.currentQuestionIndex, session.template.numberOfQuestions, 0, true);
        }
      } else {
        this.logger.log(`[Part 2 Prep][${roomName}] Speech ignored during preparation phase: "${trimmed}"`);
        this.logAudit(roomName, 'PART2_PREP_SPEECH_IGNORED', `Speech ignored during prep phase: "${trimmed}"`);
      }
      return;
    }

    // Fast-track start check: If candidate responds to greeting, start Q1 immediately without waiting for debounce timer
    let isFastTrack = false;
    try {
      const session = await this.sessionService.getSessionById(sessionId);
      if (session && session.currentQuestionIndex === 0 && isStartRequest(trimmed)) {
        isFastTrack = true;
      }
    } catch (e) {
      this.logger.error(`Error loading session for fast-track check:`, e);
    }

    if (isFastTrack) {
      this.logger.log(`[Transcript][${roomName}] ⚡ Fast-track start fired: "${trimmed}"`);
      this.logAudit(roomName, 'DEBOUNCE_FAST_TRACK', `Fast-track fired on start response: "${trimmed}"`);
      const existing = this.answerDebounceTimers.get(roomName);
      if (existing) clearTimeout(existing);
      this.answerDebounceTimers.delete(roomName);
      this.pendingTranscripts.delete(roomName);

      await this.processVoiceAnswer(roomName, sessionId, trimmed);
      return;
    }

    const chunks = this.pendingTranscripts.get(roomName) || [];
    chunks.push(trimmed);
    this.pendingTranscripts.set(roomName, chunks);

    const existing = this.answerDebounceTimers.get(roomName);
    if (existing) clearTimeout(existing);

    // Determine debounce MS: 10s for IELTS Part 2 long turn, 4s default
    let debounceMs = this.ANSWER_DEBOUNCE_MS;
    try {
      const session = await this.sessionService.getSessionById(sessionId);
      if (session) {
        const currentSection = this.getSectionForQuestionNumber(session, session.currentQuestionIndex);
        if (currentSection?.type === 'IELTS_PART2') {
          debounceMs = 10_000; // 10s debounce for Part 2 per user configuration
        }
      }
    } catch (e) {
      this.logger.error(`Error checking section for debounce time:`, e);
    }

    this.logAudit(roomName, 'DEBOUNCE_CHUNK_ADDED', `Appended FINAL chunk (${chunks.length} total). Debounce timer reset to ${debounceMs}ms`, {
      latestChunk: trimmed,
      accumulatedText: chunks.join(' '),
      debounceMs,
    });

    const timer = setTimeout(() => {
      this.answerDebounceTimers.delete(roomName);
      const fullText = (this.pendingTranscripts.get(roomName) || []).join(' ');
      this.pendingTranscripts.delete(roomName);

      if (fullText.trim()) {
        this.logger.log(`[Transcript][${roomName}] ⏱️ Debounce fired (${debounceMs}ms): "${fullText}"`);
        this.logAudit(roomName, 'DEBOUNCE_FIRED', `Debounce expired (${debounceMs}ms). Complete answer sent to processing: "${fullText}"`, {
          fullText,
          chunksCount: chunks.length,
        });
        this.processVoiceAnswer(roomName, sessionId, fullText);
      }
    }, debounceMs);

    this.answerDebounceTimers.set(roomName, timer);
  }

  private resetDebounce(roomName: string, sessionId: string): void {
    const existing = this.answerDebounceTimers.get(roomName);
    if (!existing) return;

    clearTimeout(existing);
    this.logAudit(roomName, 'DEBOUNCE_RESET_BY_PARTIAL', 'Debounce timer extended due to active candidate speech (PARTIAL event)');

    const timer = setTimeout(() => {
      this.answerDebounceTimers.delete(roomName);
      const fullText = (this.pendingTranscripts.get(roomName) || []).join(' ');
      this.pendingTranscripts.delete(roomName);
      if (fullText.trim()) {
        this.logAudit(roomName, 'DEBOUNCE_FIRED', `Debounce expired after reset: "${fullText}"`);
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
      this.clearSpeakingTimer(roomName);

      const session = await this.sessionService.getSessionById(sessionId);
      if (!session) return;

      this.logAudit(roomName, 'USER_ANSWER_RECEIVED', `Candidate answer for Q${session.currentQuestionIndex}: "${fullText}"`, {
        questionIndex: session.currentQuestionIndex,
        answer: fullText,
      });

      if (isRepeatRequest(fullText)) {
        this.logger.log(`[Repeat] Detected repeat request from voice in room ${roomName}: "${fullText}"`);
        this.logAudit(roomName, 'REPEAT_DETECTED', `Candidate asked to repeat question: "${fullText}"`);
        await this.sendChatMessage(roomName, `🎤 ${fullText}`);

        const repeatText = await getRepeatText(session, this.interviewerService);
        if (session.currentQuestionIndex === 0) {
          await this.sendChatMessage(roomName, `I didn't catch that. Let me repeat the greeting.`);
          await this.agentService.sendTTS(roomName, repeatText);
          await this.sendChatMessage(roomName, `🤖 ${repeatText}`);
        } else {
          const section = this.getSectionForQuestionNumber(session, session.currentQuestionIndex);
          const isPart2 = section?.type === 'IELTS_PART2';

          if (isPart2) {
            const cueCardTopicText = repeatText;
            const instructionBody = `I'm going to give you a topic and I'd like you to talk about it for one to two minutes.`;
            const part2Instruction = `Now, ${instructionBody}`;
            await this.sendChatMessage(roomName, `Let me repeat the instructions.`);
            await this.agentService.sendTTS(roomName, part2Instruction);
            await this.sendChatMessage(roomName, `📋 Topic:\n\n${cueCardTopicText}`, true);
          } else {
            await this.sendChatMessage(roomName, `Let me repeat the question.`);
            await this.agentService.sendTTS(roomName, repeatText);
            await this.sendChatMessage(roomName, `❓ Question ${session.currentQuestionIndex}/${session.template.numberOfQuestions}:**\n${repeatText}`);
          }

          // Restart silence timer
          this.startSilenceTimer(roomName, session.id, session.currentQuestionIndex, session.template.numberOfQuestions, 0, isPart2);
        }
        return;
      }

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
      this.logAudit(roomName, 'PROCESS_ANSWER_ERROR', `Error processing answer: ${error}`);
    }
  }

  private async processNextStep(session: any, roomName: string): Promise<void> {
    const freshSession = await this.sessionService.getSessionById(session.id);
    const nextQuestionNumber = freshSession.currentQuestionIndex + 1;
    const totalQuestions = freshSession.template.numberOfQuestions;

    if (nextQuestionNumber > totalQuestions) {
      // Interview complete
      this.logger.log(`✅ Interview complete for session ${session.id}`);
      this.logAudit(roomName, 'INTERVIEW_COMPLETE', `All ${totalQuestions} questions completed. Generating overall feedback...`);

      const t0 = Date.now();
      const overallFeedback = await this.interviewerService.generateOverallFeedback(freshSession);
      const feedbackTime = Date.now() - t0;
      this.logAudit(roomName, 'AI_FEEDBACK_GENERATED', `Feedback generated in ${feedbackTime}ms`, { feedbackTime });

      await this.sessionService.completeSession(session.id, overallFeedback);

      const spokenCompletion = 'Congratulations! You have completed the interview. Thank you for your time. Please click on robot icon to end the interview.';

      await this.sessionService.addMessage(session.id, MessageRole.ASSISTANT, spokenCompletion, MessageType.TEXT);
      this.logAudit(roomName, 'BOT_TTS_COMPLETION', spokenCompletion);
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

      // Upload audit log to MinIO on interview completion
      await this.uploadAuditLog(roomName, session.id);
      return;
    }

    // Generate next question
    const t0 = Date.now();
    const nextQuestion = await this.interviewerService.generateQuestion(freshSession, nextQuestionNumber);
    const genTime = Date.now() - t0;

    await this.sessionService.addMessage(session.id, MessageRole.ASSISTANT, nextQuestion, MessageType.TEXT, nextQuestionNumber);

    const prevSection = freshSession.currentQuestionIndex > 0
      ? this.getSectionForQuestionNumber(freshSession, freshSession.currentQuestionIndex)
      : null;
    const nextSection = this.getSectionForQuestionNumber(freshSession, nextQuestionNumber);

    const isNewSection = !prevSection || (nextSection && prevSection.name !== nextSection.name);
    const isIeltsTemplate = freshSession.template?.type === 2;

    let questionTextToSpeak = nextQuestion;
    let part2IntroPrefix = '';

    const isPart3Section = nextSection?.type === 'IELTS_PART3' || nextSection?.name?.toLowerCase().includes('part 3');

    if (isNewSection && (isIeltsTemplate || nextSection?.type?.startsWith('IELTS_') || isPart3Section)) {
      if (nextSection?.type === 'IELTS_PART1' || nextSection?.name?.toLowerCase().includes('part 1')) {
        const part1Intro = `In this first part, I'd like to ask you some questions about yourself.`;
        await this.sendChatMessage(roomName, `📢 **Part 1:** ${part1Intro}`);
        questionTextToSpeak = `${part1Intro} ${nextQuestion}`;
      } else if (nextSection?.type === 'IELTS_PART2' || nextSection?.name?.toLowerCase().includes('part 2')) {
        const part2Intro = `Now, moving on to Part 2.`;
        await this.sendChatMessage(roomName, `📢 **Part 2:** ${part2Intro}`);
        part2IntroPrefix = part2Intro;
      } else if (isPart3Section) {
        const part3Intro = `Now, let's move on to Part 3. We've been talking about a topic, and I'd like to ask you some more general questions related to this.`;
        await this.sendChatMessage(roomName, `📢 **Part 3:** ${part3Intro}`);
        questionTextToSpeak = `${part3Intro} ${nextQuestion}`;

        // Lock user transcript listening during transition and Q1 TTS
        this.isBotSpeakingNextQuestion.set(roomName, true);
      }
    }

    this.logAudit(roomName, 'AI_QUESTION_GENERATED', `Generated Q${nextQuestionNumber}/${totalQuestions} in ${genTime}ms: "${nextQuestion}"`, {
      questionNumber: nextQuestionNumber,
      totalQuestions,
      genTimeMs: genTime,
      questionText: nextQuestion,
      textToSpeak: questionTextToSpeak,
    });

    if (nextSection && (nextSection.type === 'IELTS_PART2' || nextSection.name?.toLowerCase().includes('part 2'))) {
      const cueCardContent = nextQuestion;
      await this.handlePart2QuestionStart(roomName, session.id, nextQuestionNumber, totalQuestions, nextSection, cueCardContent, part2IntroPrefix);
    } else {
      await this.sendChatMessage(roomName, `❓ **Question ${nextQuestionNumber}/${totalQuestions}:**\n${nextQuestion}`);
      await this.agentService.sendTTS(roomName, questionTextToSpeak);

      if (isPart3Section && isNewSection) {
        // Unlock listening after TTS finishes reading Q1 of Part 3 (10s delay)
        setTimeout(() => {
          this.startSilenceTimer(roomName, session.id, nextQuestionNumber, totalQuestions);
        }, 10000);
      } else {
        this.startSilenceTimer(roomName, session.id, nextQuestionNumber, totalQuestions);
      }
    }
  }

  private startSilenceTimer(
    roomName: string,
    sessionId: string,
    questionNumber: number,
    totalQuestions: number,
    retryCount = 0,
    isPart2 = false,
  ): void {
    this.clearSilenceTimer(roomName);
    // Unlocks transcript listening when silence timer starts (meaning bot has finished reading question)
    this.isBotSpeakingNextQuestion.delete(roomName);
    const timeoutMs = isPart2 ? 25_000 : this.SILENCE_TIMEOUT_MS;

    this.logAudit(roomName, 'SILENCE_TIMER_START', `Started ${timeoutMs / 1000}s silence timer for Q${questionNumber} (attempt ${retryCount + 1}/${this.MAX_REASK_COUNT + 1})`, {
      questionNumber,
      timeoutMs,
      retryCount,
    });

    const timer = setTimeout(async () => {
      this.silenceTimers.delete(roomName);
      this.logger.warn(`[Silence] No answer for Q${questionNumber} in room ${roomName} after ${timeoutMs}ms — skipping`);
      this.logAudit(roomName, 'SILENCE_TIMEOUT_FIRED', `No answer after ${timeoutMs}ms for Q${questionNumber}. Retry count: ${retryCount}/${this.MAX_REASK_COUNT}`);

      try {
        const session = await this.sessionService.getSessionById(sessionId);
        if (!session) return;

        if (retryCount < this.MAX_REASK_COUNT) {
          const currentQuestion =
            session.messages
              ?.filter((m: any) =>
                m.role === MessageRole.ASSISTANT &&
                m.questionNumber === questionNumber
              )
              ?.at(-1)?.content;

          const repeatText = currentQuestion || await this.interviewerService.generateQuestion(session, questionNumber);

          await this.sendChatMessage(roomName, `I didn't hear your answer. Let me repeat the question.`);
          await this.agentService.sendTTS(roomName, repeatText);
          await this.sendChatMessage(roomName, `❓ **Question ${questionNumber}/${totalQuestions}:**\n${repeatText}`);

          this.startSilenceTimer(roomName, sessionId, questionNumber, totalQuestions, retryCount + 1, isPart2);
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
    }, timeoutMs);

    this.silenceTimers.set(roomName, timer);
    this.logger.log(`[Silence] Started ${timeoutMs / 1000}s timer for Q${questionNumber} in room ${roomName}`);
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
          agent_id: agentId || this.configService.get<string>('MEZON_AGENT_ID'),
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

  private async getRoomParticipants(roomId: string, roomName?: string): Promise<any[]> {
    const baseUrl = this.configService.get<string>('AGENT_BASE_URL')!;

    // Attempt 1: Query by roomId
    try {
      const url = `${baseUrl}/api/v2/rooms/participant/${encodeURIComponent(roomId)}`;
      const response = await this.axiosClient.getInstance().get(url);
      const data = response.data;
      const list = Array.isArray(data) ? data : (data?.participants || data?.data || data?.data?.participants);
      if (Array.isArray(list) && list.length > 0) return list;
    } catch (e: any) {
      this.logger.debug(`[Participants] Fetch failed for roomId ${roomId}: ${e.message}`);
    }

    // Attempt 2: Query by roomName
    if (roomName && roomName !== roomId) {
      try {
        const url = `${baseUrl}/api/v2/rooms/participant/${encodeURIComponent(roomName)}`;
        const response = await this.axiosClient.getInstance().get(url);
        const data = response.data;
        const list = Array.isArray(data) ? data : (data?.participants || data?.data || data?.data?.participants);
        if (Array.isArray(list) && list.length > 0) return list;
      } catch (e: any) {
        this.logger.debug(`[Participants] Fetch failed for roomName ${roomName}: ${e.message}`);
      }
    }

    return [];
  }

  private isMatchingParticipant(participant: any, participantIdentity: string): boolean {
    const target = String(participantIdentity || '').trim();
    if (!target) return false;

    let metadata = participant?.metadata;
    if (typeof metadata === 'string') {
      try {
        metadata = JSON.parse(metadata);
      } catch { }
    }

    const candidates = [
      String(participant?.identity || '').trim(),
      String(participant?.participant_identity || '').trim(),
      String(participant?.user_id || '').trim(),
      String(participant?.userId || '').trim(),
      String(participant?.ext_id || '').trim(),
      String(participant?.extId || '').trim(),
      String(participant?.id || '').trim(),
      String(metadata?.extName || '').trim(),
      String(metadata?.extId || '').trim(),
      String(metadata?.user_id || '').trim(),
      String(metadata?.userId || '').trim(),
    ].filter(Boolean);

    return candidates.some((cand) => cand === target || cand.includes(target) || target.includes(cand));
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
    this.clearPrepTimer(roomName);
    this.clearSpeakingTimer(roomName);
    this.clearTemplateSelectionTimer(roomName);
    this.awaitingTemplateSelection.delete(roomName);
    this.roomSessionMap.delete(roomName);
    this.roomIds.delete(roomName);
  }

  private async handleRepeatQuestionRequest(roomName: string, participantIdentity: string): Promise<void> {
    try {
      const session = await this.sessionService.findSessionByUserAndRoom(participantIdentity, roomName);
      if (!session) {
        this.logger.warn(`[Repeat] No active session found for user ${participantIdentity} in room ${roomName}`);
        return;
      }

      this.clearSilenceTimer(roomName);

      const repeatText = await getRepeatText(session, this.interviewerService);
      if (session.currentQuestionIndex === 0) {
        await this.sendChatMessage(roomName, `I didn't catch that. Let me repeat the greeting.`);
        await this.agentService.sendTTS(roomName, repeatText);
        await this.sendChatMessage(roomName, `🤖 ${repeatText}`);
      } else {
        await this.sendChatMessage(roomName, `Let me repeat the question.`);
        await this.agentService.sendTTS(roomName, repeatText);
        await this.sendChatMessage(roomName, `❓ **Question ${session.currentQuestionIndex}/${session.template.numberOfQuestions}:**\n${repeatText}`);

        // Restart silence timer
        this.startSilenceTimer(roomName, session.id, session.currentQuestionIndex, session.template.numberOfQuestions);
      }
    } catch (error) {
      this.logger.error(`Error in handleRepeatQuestionRequest:`, error);
    }
  }
}
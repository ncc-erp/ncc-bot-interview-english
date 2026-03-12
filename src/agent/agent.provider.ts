import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bull";
import { Queue } from "bull";
import { ButtonBuilder, ButtonStyle, EmbedBuilder, SmartMessage, type Nezon } from "@n0xgg04/nezon";
import { EventSource } from "eventsource";
import axios from "axios";
import { AxiosClient } from "@/shared/lib/axios-client";
import {
  AGENT_ENDPOINTS,
  buildStreamMessageUrl,
} from "@/shared/constants/agent";
import { AgentEvent } from "@/agent/agent.type";
import { Account } from "@/agent/agent.type";
import { TTSProvider } from "./tts.provider";
import { EnhancedInterviewerService } from "@/interviewer/interview.service";
import { InterviewSessionService } from "@/interviewer/interview-session.service";
import { MessageRole, MessageType } from "@/database-test/entities/session-message.entity";

interface VoiceBuffer {
  chunks: string[];
  lastUpdateTime: number;
  timeoutHandle: NodeJS.Timeout | null;
  isProcessing: boolean;
}

interface ProcessedMessage {
  content: string;
  timestamp: number;
}

export interface VoiceMessageProcessedEvent {
  sessionId: string;
  userId: string;
  channelId: string;
  voiceText: string;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly sseConnections = new Map<string, EventSource>();
  private readonly roomSessions = new Map<string, string>();
  private readonly roomAgents = new Map<string, string>();

  // Cache sessions để tránh load lại nhiều lần
  private readonly sessionCache = new Map<string, {
    data: any,
    timestamp: number
  }>();
  private readonly CACHE_TTL_MS = 30000;

  // NEW: Track processed messages to prevent duplicates
  private readonly processedMessages = new Map<string, ProcessedMessage[]>();
  private readonly MESSAGE_DEDUP_WINDOW_MS = 3000; // 3 seconds window for deduplication

  // Debounce timers: roomName -> timer handle
  // When user stops speaking for ANSWER_DEBOUNCE_MS, process their answer
  private readonly answerDebounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly ANSWER_DEBOUNCE_MS = 3000;

  // Accumulate FINAL transcripts per room until debounce fires
  private readonly pendingTranscripts = new Map<string, string[]>();

  // Callback for voice message processed event (kept for compatibility but no longer used for confirm flow)
  private voiceMessageCallback?: (event: VoiceMessageProcessedEvent) => void;

  constructor(
    @InjectQueue("tts") private readonly ttsQueue: Queue,
    private readonly configService: ConfigService,
    private readonly axiosClient: AxiosClient,
    private readonly interviewer: EnhancedInterviewerService,
    private readonly ttsService: TTSProvider,
    private readonly sessionService: InterviewSessionService,
  ) { }

  /**
   * NEW: Register callback for voice message processed event
   */
  onVoiceMessageProcessed(callback: (event: VoiceMessageProcessedEvent) => void): void {
    this.voiceMessageCallback = callback;
  }

  /**
   * NEW: Enable transcript stream for voice room
   */
  async enableTranscript(roomName: string): Promise<void> {
    try {
      const baseurl = this.configService.get<string>('AGENT_BASE_URL')!;
      const agentId = this.roomAgents.get(roomName);
      this.logger.log(`🎙️ Enabling transcript for room ${roomName}...`);
      await this.axiosClient.getInstance().post(`${baseurl}/api/dispatch/agent-request`, {
        room_name: roomName,
        agent_id: 'agent-e7e1b7c2-2b6e-4e2a-9c1d-7f8e2a1b2c3d',
        payload: { request_type: 'transcript_control', action: 'enable' },
      });
      this.logger.log(`✅ Transcript enabled for room ${roomName}`);
    } catch (error) {
      this.logger.error(`❌ Failed to enable transcript for room ${roomName}:`, error);
      throw error;
    }
  }

  /**
   * NEW: Disable transcript stream for voice room
   */
  async disableTranscript(roomName: string): Promise<void> {
    try {
      const baseurl = this.configService.get<string>('AGENT_BASE_URL')!;
      const agentId = this.roomAgents.get(roomName);
      this.logger.log(`🔇 Disabling transcript for room ${roomName}...`);
      await this.axiosClient.getInstance().post(`${baseurl}/api/dispatch/agent-request`, {
        room_name: roomName,
        agent_id: 'agent-e7e1b7c2-2b6e-4e2a-9c1d-7f8e2a1b2c3d',
        payload: { request_type: 'transcript_control', action: 'disable' },
      });
      this.logger.log(`✅ Transcript disabled for room ${roomName}`);
    } catch (error) {
      this.logger.error(`❌ Failed to disable transcript for room ${roomName}:`, error);
      // Don't throw, as this is cleanup
    }
  }

  /**
 * UPDATED: Handle removing agent with correct payload format
 */
  async handleRemoveAgent(
    client: Nezon.Client,
    event: AgentEvent,
    account: Account,
    sessionId: string, // NEW: Optional sessionId
  ): Promise<void> {
    try {
      const channel = await client.channels.fetch(
        event.voice_channel_id ?? event.channel_id ?? ""
      );

      // if (!channel?.meeting_code) {
      //   this.logger.error("Channel or meeting_code not found");
      //   return;
      // }

      const meeting_code = event.voice_channel_id;

      // NEW: Disable transcript before removing agent
      try {
        await this.disableTranscript(meeting_code);
      } catch (error) {
        this.logger.warn(`Failed to disable transcript, continuing with removal...`);
      }

      // UPDATED: Payload with type and metadata
      const payload = {
        account,
        room_name: meeting_code,
        type: "interview",
        metadata: {
          interview_id: sessionId,
        },
      };

      this.logger.log(`Removing agent with payload: ${JSON.stringify(payload)}`);

      const response = await this.axiosClient
        .getInstance()
        .post(AGENT_ENDPOINTS.CANCEL_DISPATCH, payload);

      this.logger.log(
        `Agent removed, API response: ${JSON.stringify(response.data)}`
      );

      const sseKey = `${account.appid}-${meeting_code}`;
      const existingSSE = this.sseConnections.get(sseKey);
      if (existingSSE) {
        existingSSE.close();
        this.sseConnections.delete(sseKey);
        this.logger.log(`🔌 Closed SSE connection for room ${meeting_code}`);
      }

      // Clean up processed messages and debounce state for this room
      this.processedMessages.delete(meeting_code);
      this.pendingTranscripts.delete(meeting_code);
      const debounceTimer = this.answerDebounceTimers.get(meeting_code);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        this.answerDebounceTimers.delete(meeting_code);
      }

      if (this.roomSessions.has(meeting_code)) {
        const sessionId = this.roomSessions.get(meeting_code);
        this.roomSessions.delete(meeting_code);
        // Clear cache when removing session
        this.sessionCache.delete(sessionId!);
        this.logger.log(`🗑️ Cleared session ${sessionId} mapping for room ${meeting_code}`);
      }
    } catch (error) {
      this.logger.error(
        `Error removing agent: ${error}`,
        (error as Error)?.stack
      );
    }
  }

  async handleInviteAgent(
    client: Nezon.Client,
    event: AgentEvent,
    account: Account,
    sessionId: string, // NEW: Required sessionId
  ): Promise<void> {
    try {
      const channel = await client.channels.fetch(
        event.voice_channel_id ?? event.channel_id ?? ""
      );

      // if (!channel?.meeting_code) {
      //   this.logger.error("Channel or meeting_code not found");
      //   return;
      // }

      const meeting_code = event.voice_channel_id

      // UPDATED: Payload with type and metadata
      const payload = {
        account,
        room_name: meeting_code,
        type: "interview",
        metadata: {
          interview_id: sessionId,
        },
      };

      this.logger.log(`Inviting agent with payload: ${JSON.stringify(payload)}`);

      let data;

      try {
        const response = await this.axiosClient
          .getInstance()
          .post(AGENT_ENDPOINTS.CREATE_DISPATCH, payload);

        data = response.data;
        this.logger.log(`Agent invited, API response: ${JSON.stringify(data)}`);
      } catch (error) {
        if (axios.isAxiosError(error) && error.response) {
          this.logger.error(
            `Invalid response from API: ${error.response.status
            } - ${JSON.stringify(error.response.data)}`
          );
        } else {
          this.logger.error(`Error calling API: ${error}`);
        }
        data = null;
      }

      const baseurl = this.configService.get<string>("AGENT_BASE_URL")!;
      const sseUrl = buildStreamMessageUrl(
        baseurl,
        account.appid,
        account.token,
        meeting_code
      );

      this.createSSEConnection(sseUrl, meeting_code, account, client);

      // NEW: Enable transcript after bot joins
      try {
        this.logger.log(`⏳ Waiting 2 seconds for bot to fully join...`);
        await new Promise(resolve => setTimeout(resolve, 2000));

        await this.enableTranscript(meeting_code);
        this.logger.log(`✅ Transcript enabled for room ${meeting_code}`);
      } catch (error) {
        this.logger.error(
          `❌ Failed to enable transcript: ${error}`,
          (error as Error)?.stack
        );
        // Continue anyway, maybe manual retry later
      }

    } catch (error) {
      this.logger.error(
        `Error inviting agent: ${error}`,
        (error as Error)?.stack
      );
    }
  }

  /**
   * NEW: Clean up old processed messages
   */
  private cleanupProcessedMessages(): void {
    const now = Date.now();

    for (const [roomName, messages] of this.processedMessages.entries()) {
      const recentMessages = messages.filter(
        msg => (now - msg.timestamp) < this.MESSAGE_DEDUP_WINDOW_MS
      );

      if (recentMessages.length === 0) {
        this.processedMessages.delete(roomName);
      } else {
        this.processedMessages.set(roomName, recentMessages);
      }
    }
  }

  /**
   * OPTIMIZED: Get cached session hoặc load từ DB
   */
  private async getCachedSession(sessionId: string, forceRefresh = false): Promise<any> {
    const cached = this.sessionCache.get(sessionId);
    const now = Date.now();

    // Return cache nếu còn fresh và không force refresh
    if (!forceRefresh && cached && (now - cached.timestamp) < this.CACHE_TTL_MS) {
      this.logger.debug(`Cache hit for session ${sessionId}`);
      return cached.data;
    }

    // Load từ DB
    const session = await this.sessionService.getSessionById(sessionId);
    if (session) {
      this.sessionCache.set(sessionId, {
        data: session,
        timestamp: now
      });
      this.logger.debug(`Cache refreshed for session ${sessionId}`);
    }

    return session;
  }

  /**
   * OPTIMIZED: Clear cache sau khi update
   */
  private clearSessionCache(sessionId: string): void {
    this.sessionCache.delete(sessionId);
  }

  /**
   * Reset the debounce timer without accumulating text.
   * Used when PARTIAL arrives to prevent timer firing mid-speech.
   */
  private resetDebounceTimer(roomName: string, client: Nezon.Client): void {
    const existing = this.answerDebounceTimers.get(roomName);
    if (!existing) return; // No active timer = no answer in progress, nothing to reset

    clearTimeout(existing);

    const chunks = this.pendingTranscripts.get(roomName) || [];
    const timer = setTimeout(() => {
      this.answerDebounceTimers.delete(roomName);
      const fullText = (this.pendingTranscripts.get(roomName) || []).join(' ');
      this.pendingTranscripts.delete(roomName);
      if (fullText.trim()) {
        this.logger.log(`[Voice][Room ${roomName}] ⏱️ Debounce fired, processing: "${fullText}"`);
        this.processVoiceAnswer(roomName, fullText, client);
      }
    }, this.ANSWER_DEBOUNCE_MS);

    this.answerDebounceTimers.set(roomName, timer);
  }

  /**
   * Called for each FINAL transcript chunk from SSE.
   * Accumulates text and resets a 3s debounce timer.
   * When timer fires (user stopped speaking), processes the full answer.
   */
  private handleVoiceMessage(
    roomName: string,
    data: string,
    client: Nezon.Client,
  ): void {
    try {
      const voiceText = data.trim();

      if (!voiceText || voiceText.length < 2) {
        return;
      }

      this.logger.log(`[Voice][Room ${roomName}] FINAL chunk: "${voiceText}"`);

      // Accumulate transcript chunks for this room
      const chunks = this.pendingTranscripts.get(roomName) || [];
      chunks.push(voiceText);
      this.pendingTranscripts.set(roomName, chunks);

      // Reset debounce timer - every new chunk pushes the deadline 3s forward
      const existing = this.answerDebounceTimers.get(roomName);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        this.answerDebounceTimers.delete(roomName);
        const fullText = (this.pendingTranscripts.get(roomName) || []).join(' ');
        this.pendingTranscripts.delete(roomName);

        if (fullText.trim()) {
          this.logger.log(`[Voice][Room ${roomName}] ⏱️ Debounce fired, processing answer: "${fullText}"`);
          this.processVoiceAnswer(roomName, fullText, client);
        }
      }, this.ANSWER_DEBOUNCE_MS);

      this.answerDebounceTimers.set(roomName, timer);

    } catch (error) {
      this.logger.error(`[Voice] Error in handleVoiceMessage:`, error);
    }
  }

  /**
   * Process a complete voice answer after debounce fires.
   * Saves to DB, shows in text channel, then calls processUserAnswer.
   */
  private async processVoiceAnswer(
    roomName: string,
    fullText: string,
    client: Nezon.Client,
  ): Promise<void> {
    try {
      const sessionId = this.roomSessions.get(roomName);
      if (!sessionId) {
        this.logger.warn(`[Voice] No session for room ${roomName}`);
        return;
      }

      const session = await this.getCachedSession(sessionId);
      if (!session) {
        this.logger.warn(`[Voice] Session ${sessionId} not found`);
        return;
      }

      const userMessages = session.messages?.filter((m: any) => m.role === MessageRole.USER) || [];
      const isFirstMessage = userMessages.length === 0;

      // Save full accumulated answer to DB
      await this.sessionService.addMessage(
        session.id,
        MessageRole.USER,
        fullText,
        MessageType.AUDIO,
        isFirstMessage ? undefined : session.currentQuestionIndex,
      );
      this.clearSessionCache(sessionId);

      this.logger.log(`[Voice] Saved answer to session ${session.id}: "${fullText}"`);

      // Show in text channel
      const channel = client.channels.get(session.channelId);
      if (channel) {
        await channel.send({ t: `🎤 **Your answer:** ${fullText}` });
      }

      // Process answer and move to next question
      await this.processUserAnswer(sessionId, client, session.channelId);

    } catch (error) {
      this.logger.error(`[Voice] Error processing voice answer:`, error);
    }
  }

  /**
   * Common logic to process user's answer (from text or voice)
   */
  async processUserAnswer(
    sessionId: string,
    client: Nezon.Client,
    channelId: string,
  ): Promise<void> {

    // Load fresh session with cache
    const session = await this.getCachedSession(sessionId, true); // Force refresh

    const nextQuestionNumber = session.currentQuestionIndex + 1;
    const totalQuestions = session.template.numberOfQuestions;

    // Check if complete
    if (nextQuestionNumber > totalQuestions) {
      this.logger.log('Interview complete, generating feedback');

      const sessionForFeedback = await this.getCachedSession(sessionId, true);
      const overallFeedback = await this.interviewer.generateOverallFeedback(
        sessionForFeedback
      );

      await this.sessionService.completeSession(session.id, overallFeedback);
      this.clearSessionCache(sessionId);

      // Send TTS completion
      const spokenCompletion = `Congratulations! You have completed the interview. Thank you for your time joining this interview. You can click the button below to receive audio and end the interview session`;

      // Save bot's completion message
      await this.sessionService.addMessage(
        session.id,
        MessageRole.ASSISTANT,
        spokenCompletion,
        MessageType.TEXT,
      );

      this.clearSessionCache(sessionId);

      await this.sendTTS(session.roomName, spokenCompletion);

      const channel = client.channels.get(channelId);
      if (channel) {
        await channel.send(
          SmartMessage.build()
            .addEmbed(
              new EmbedBuilder()
                .setColor('#00cc66')
                .setTitle('🎉 Interview Complete!')
                .setDescription(
                  `Congratulations! You have completed the interview. Thank you for your time joining this interview. You can click the button below to receive audio and end the interview session\n\n` +
                  `📝 Template: ${session.template.name}\n` +
                  `❓ Questions Answered: ${session.template.numberOfQuestions}\n\n` +
                  `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                  `👇 Click **Finish & Get Recording** to end the session and receive your audio recording.`
                )
            )
            .addButton(
              new ButtonBuilder()
                .setCustomId(`/interview/finish/${session.id}`)
                .setLabel('✅ Finish & Get Recording')
                .setStyle(ButtonStyle.Success)
            )
            .toContent()
        );
      } else {
        this.logger.error(`Channel ${channelId} not found`);
      }
      return;
    }

    // Generate next question
    this.logger.log(`Generating question ${nextQuestionNumber}`);

    // OPTIMIZED: Load session một lần cho question generation
    const sessionForQuestion = await this.getCachedSession(sessionId, true);
    const nextQuestion = await this.interviewer.generateQuestion(
      sessionForQuestion,
      nextQuestionNumber,
    );

    // Save next question
    await this.sessionService.addMessage(
      session.id,
      MessageRole.ASSISTANT,
      nextQuestion,
      MessageType.TEXT,
      nextQuestionNumber,
    );

    this.clearSessionCache(sessionId);

    // Send TTS for next question
    await this.sendTTS(session.roomName, nextQuestion);

    const responseMessage = `✅ Answer recorded!

**Bot is speaking the next question via voice...**

If you want to see the text:

━━━━━━━━━━━━━━━━━━━━━━

**Question ${nextQuestionNumber}/${totalQuestions}:**

${nextQuestion}

━━━━━━━━━━━━━━━━━━━━━━

Type your answer or speak in the voice room...`;

    const channel = client.channels.get(channelId);
    if (channel) {
      await channel.send({ t: responseMessage });
    } else {
      this.logger.error(`Channel ${channelId} not found`);
    }
  }

  /**
   * NEW: Link existing session to room (bot already in room)
   */
  async linkSessionToRoom(roomName: string, sessionId: string): Promise<void> {
    this.roomSessions.set(roomName, sessionId);
    this.logger.log(`Linked session ${sessionId} to room ${roomName}`);
  }

  /**
   * NEW: Send TTS directly without going through queue
   */
  async sendTTS(roomName: string, text: string): Promise<void> {
    try {
      const agentId = this.roomAgents.get(roomName);
      await this.ttsService.callTTSAPI(roomName, text, 'agent-e7e1b7c2-2b6e-4e2a-9c1d-7f8e2a1b2c3d');
      this.logger.log(`[TTS SENT] Room ${roomName}: ${text.substring(0, 100)}...`);
    } catch (error) {
      this.logger.error(`Failed to send TTS for room ${roomName}:`, error);
      throw error;
    }
  }

  getSessionIdForRoom(roomName: string): string | undefined {
    return this.roomSessions.get(roomName);
  }

  getAgentIdForRoom(roomName: string): string | undefined {
    return this.roomAgents.get(roomName);
  }

  clearExpiredCache(): void {
    const now = Date.now();
    let cleared = 0;

    for (const [sessionId, cached] of this.sessionCache.entries()) {
      if (now - cached.timestamp > this.CACHE_TTL_MS) {
        this.sessionCache.delete(sessionId);
        cleared++;
      }
    }

    if (cleared > 0) {
      this.logger.debug(`Cleared ${cleared} expired cache entries`);
    }

    // Also cleanup processed messages
    this.cleanupProcessedMessages();
  }

  private createSSEConnection(
    sseUrl: string,
    meeting_code: string,
    account: Account,
    client: Nezon.Client,
    retry = 0,
  ) {
    const sseKey = `${account.appid}-${meeting_code}`;

    this.logger.log(`🔌 Creating SSE connection (retry=${retry}) for room ${meeting_code}`);
    const es = new EventSource(sseUrl);

    es.onopen = () => {
      this.logger.log(`✅ SSE connection OPENED for room ${meeting_code}`);
    };

    es.onmessage = (event) => {
      this.logger.log(`[SSE][Room ${meeting_code}] data: ${event.data}`);

      const sessionId = this.roomSessions.get(meeting_code);
      if (!sessionId) {
        this.logger.error(`❌ [SSE] No session mapped for room ${meeting_code}`);
        return;
      }

      // Parse SSE JSON payload
      let parsed: { message: string; type: string; participant_identity: string };
      try {
        parsed = JSON.parse(event.data);
      } catch {
        this.logger.warn(`[SSE] Failed to parse JSON, skipping: ${event.data}`);
        return;
      }

      if (parsed.type === 'PARTIAL') {
        // PARTIAL = user is still speaking → reset debounce timer to prevent early fire
        this.resetDebounceTimer(meeting_code, client);
        return;
      }

      // FINAL = one sentence complete → accumulate and reset timer
      this.handleVoiceMessage(meeting_code, parsed.message, client);
    };

    es.onerror = (err: any) => {
      this.logger.error(
        `[SSE][Room ${meeting_code}] error`,
        JSON.stringify(err),
      );

      es.close();
      this.sseConnections.delete(sseKey);

      if (retry < 5) {
        const delay = 2000 + retry * 1000;
        this.logger.warn(
          `🔄 Retry SSE for room ${meeting_code} after ${delay}ms (retry ${retry + 1})`
        );

        setTimeout(() => {
          this.createSSEConnection(
            sseUrl,
            meeting_code,
            account,
            client,
            retry + 1,
          );
        }, delay);
      } else {
        this.logger.error(`❌ SSE retry limit reached for room ${meeting_code}`);
      }
    };

    this.sseConnections.set(sseKey, es);
  }

  // ─────────────────────────────────────────────
  // External Meeting Methods (no Nezon client needed)
  // ─────────────────────────────────────────────

  /**
   * Invite agent to external meeting room.
   * Used by OrchestratorSSEService — no Nezon.Client available.
   */
  async handleInviteAgentExternal(roomName: string, sessionId: string): Promise<void> {
    const account: Account = {
      appid: this.configService.get<string>('MEZON_BOT_ID')!,
      token: this.configService.get<string>('MEZON_TOKEN')!,
    };
 
    const payload = {
      account,
      room_name: roomName,
      type: 'interview',
      metadata: { interview_id: sessionId },
    };
 
    this.logger.log(`[External] Inviting agent to room ${roomName}...`);
    try {
      const response = await this.axiosClient.getInstance().post(AGENT_ENDPOINTS.CREATE_DISPATCH, payload);
      this.logger.log(`[External] Agent invited: ${JSON.stringify(response.data)}`);
 
      const agentId = response.data?.agent_name;
      if (agentId) {
        this.roomAgents.set(roomName, agentId);
        this.logger.log(`[External] Stored agent_id ${agentId} for room ${roomName}`);
      }
    } catch (error) {
      this.logger.error(`[External] Failed to invite agent:`, error);
      throw error;
    }
 
    this.roomSessions.set(roomName, sessionId);
 
    this.logger.log(`[External] Waiting 2s for agent to join room ${roomName}...`);
    await new Promise(resolve => setTimeout(resolve, 2000));
 
    try {
      await this.enableTranscript(roomName);
      this.logger.log(`[External] ✅ Transcript enabled for room ${roomName}`);
    } catch (error) {
      this.logger.error(`[External] Failed to enable transcript:`, error);
    }
  }

  /**
   * Remove agent from external meeting room.
   * Used by OrchestratorSSEService.
   */
  async handleRemoveAgentExternal(roomName: string, sessionId: string): Promise<void> {
    const account: Account = {
      appid: this.configService.get<string>('MEZON_BOT_ID')!,
      token: this.configService.get<string>('MEZON_TOKEN')!,
    };
 
    try { await this.disableTranscript(roomName); } catch { /* ignore */ }
 
    const payload = {
      account,
      room_name: roomName,
      type: 'interview',
      metadata: { interview_id: sessionId },
    };
 
    try {
      const response = await this.axiosClient.getInstance().post(AGENT_ENDPOINTS.CANCEL_DISPATCH, payload);
      this.logger.log(`[External] Agent removed from room ${roomName}: ${JSON.stringify(response.data)}`);
    } catch (error) {
      this.logger.error(`[External] Failed to remove agent:`, error);
    }
 
    // Cleanup all room state including silence timer
    const sseKey = `${account.appid}-${roomName}`;
    this.sseConnections.get(sseKey)?.close();
    this.sseConnections.delete(sseKey);
    this.roomSessions.delete(roomName);
    this.roomAgents.delete(roomName);
    this.pendingTranscripts.delete(roomName);
    this.processedMessages.delete(roomName);
    const timer = this.answerDebounceTimers.get(roomName);
    if (timer) { clearTimeout(timer); this.answerDebounceTimers.delete(roomName); }
    this.logger.log(`[External] Cleaned up state for room ${roomName}`);
  }

  /**
   * Called by OrchestratorSSEService when room_record_done metadata event fires.
   * Emits to Bull queue for async processing (merge + upload).
   */
  handleRecordDone(
    sessionId: string,
    roomName: string,
    fileResults: {
      participant_identity: string;
      filename: string;
      started_at_ns: string;
      ended_at_ns: string;
    }[],
  ): void {
    this.logger.log(`[RecordDone] Queuing merge for session ${sessionId}, ${fileResults.length} tracks`);
    this.ttsQueue.add('record-done', { sessionId, roomName, fileResults });
  }

}
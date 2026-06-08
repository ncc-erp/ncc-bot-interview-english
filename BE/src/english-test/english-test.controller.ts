import {
  AutoContext,
  ButtonBuilder,
  ButtonStyle,
  ChannelMessagePayload,
  Client,
  Command,
  Component,
  ComponentParams,
  EmbedBuilder,
  EventPayload,
  Nezon,
  On,
  SmartMessage,
  FormData
} from "@n0xgg04/nezon";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Events } from "mezon-sdk";
import { AgentService } from "@/agent/agent.provider";
import { Account } from "@/agent/agent.type";
import { TemplateService } from '../interviewer/template.service';
import { InterviewSessionService } from '../interviewer/interview-session.service';
import { EnhancedInterviewerService } from '../interviewer/interview.service';
import { SessionMode, SessionStatus } from '../database-test/entities/interview-session-test.entity';
import { MessageRole, MessageType } from '../database-test/entities/session-message.entity';
import { ChatService } from '../interviewer/chat.service';

@Injectable()
export class EnglishTestController {
  private readonly logger = new Logger(EnglishTestController.name);
  private answerTimeouts = new Map<string, NodeJS.Timeout>();
  private nezonClient?: Nezon.Client; // Store client reference

  constructor(
    private readonly agentService: AgentService,
    private readonly configService: ConfigService,
    private readonly templateService: TemplateService,
    private readonly sessionService: InterviewSessionService,
    private readonly interviewerService: EnhancedInterviewerService,
    private readonly chatService: ChatService,
  ) {
    // Register voice message event handler
    this.agentService.onVoiceMessageProcessed((event) => {
      if (this.nezonClient) {
        this.startAnswerTimeout(
          event.sessionId,
          this.nezonClient,
          event.channelId,
          event.userId,
        );
        this.logger.log(`⏰ Started answer timeout for voice message in session ${event.sessionId}`);
      } else {
        this.logger.warn(`⚠️ Cannot start timeout - Nezon client not initialized`);
      }
    });
  }

  private getAccount(): Account {
    return {
      appid: this.configService.get<string>("MEZON_BOT_ID")!,
      token: this.configService.get<string>("MEZON_TOKEN")!,
    };
  }

  @Command("start")
  async start(
    @AutoContext() [message]: Nezon.AutoContext,
    @ChannelMessagePayload() payload?: Nezon.ChannelMessage
  ) {
    try {
      const channelId = payload?.channel_id || message.channelId;
      const userId = payload?.sender_id;

      if (!channelId || !userId) {
        await message.reply(
          SmartMessage.system("Cannot determine channel or user. Please try again.")
        );
        return;
      }

      const templates = await this.templateService.getActiveTemplates();

      await message.reply(
        SmartMessage.build()
          .addEmbed(
            new EmbedBuilder()
              .setColor('#0099ff')
              .setTitle('Interview Template Selection')
              .addSelectField(
                'Choose a template...',
                'template',
                (templates).map((template) => ({
                  label: template.name,
                  value: template.id,
                })),
              )
          )
          .addButton(
            new ButtonBuilder()
              .setCustomId(`/interview/start/${userId}`)
              .setLabel('Start')
              .setStyle(ButtonStyle.Success)
          )
          .addButton(
            new ButtonBuilder()
              .setCustomId(`/interview/cancel/${userId}`)
              .setLabel('Cancel')
              .setStyle(ButtonStyle.Danger)
          )
      );
      this.logger.log(`📋 Sent template selector to user ${userId}`);
    } catch (error) {
      this.logger.error("Error in start command:", error);
      await message.reply(
        SmartMessage.system("Failed to start. Please try again.")
      );
    }
  }

  async processUserAnswer(
    session: any,
    userMessage: string,
    client: Nezon.Client,
    channelId: string,
  ): Promise<void> {
    const nextQuestionNumber = session.currentQuestionIndex + 1;
    const totalQuestions = session.template.numberOfQuestions;

    if (nextQuestionNumber > totalQuestions) {
      this.logger.log('Interview complete, generating feedback');

      const overallFeedback = await this.interviewerService.generateOverallFeedback(
        await this.sessionService.getSessionById(session.id),
      );

      await this.sessionService.completeSession(session.id, overallFeedback);

      const spokenCompletion = 'Congratulations! You have completed the interview. Thank you for your time joining this interview';

      await this.sessionService.addMessage(
        session.id,
        MessageRole.ASSISTANT,
        spokenCompletion,
        MessageType.TEXT,
      );
      await this.agentService.sendTTS(session.roomName, spokenCompletion);

      const completionMessage = `🎉 **Interview Complete!**

"${spokenCompletion}"

**Session Summary:**
 Template: ${session.template.name}
 Questions Answered: ${session.template.numberOfQuestions}

━━━━━━━━━━━━━━━━━━━━━━

⏳ Your interview recording will be available shortly...`;
      const channel = client.channels.get(channelId);
      if (channel) {
        await channel.send({ t: completionMessage });
      }

      return;
    }
    await this.sendNextQuestion(session, nextQuestionNumber, client, channelId);
  }

  async sendNextQuestion(
    session: any,
    questionNumber: number,
    client: Nezon.Client,
    channelId: string,
  ): Promise<void> {
    this.logger.log(`Generating question ${questionNumber}`);

    const refreshedSession = await this.sessionService.getSessionById(session.id);

    const nextQuestion = await this.interviewerService.generateQuestion(
      refreshedSession,
      questionNumber,
    );

    await this.sessionService.addMessage(
      session.id,
      MessageRole.ASSISTANT,
      nextQuestion,
      MessageType.TEXT,
      questionNumber,
    );

    await this.agentService.sendTTS(session.roomName, nextQuestion);

    const totalQuestions = session.template.numberOfQuestions;
    const responseMessage = `✅ ${questionNumber > 1 ? 'Answer recorded!' : 'Interview started!'}

**Bot is speaking question ${questionNumber} via voice...**

━━━━━━━━━━━━━━━━━━━━━━

**Question ${questionNumber}/${totalQuestions}:**

${nextQuestion}

━━━━━━━━━━━━━━━━━━━━━━

💬 Speak in the voice room...`;

    const channel = client.channels.get(channelId);
    if (channel) {
      await channel.send({ t: responseMessage });
    }
    
  }

  @Component({ pattern: '/interview/start/:user_id' })
  async onStartInterview(
    @ComponentParams('user_id') userId: string | undefined,
    @ChannelMessagePayload() payload: Nezon.ChannelMessage,
    @FormData() formData: Nezon.FormData | undefined,
    @AutoContext() [message]: Nezon.AutoContext,
    @Client() client: Nezon.Client,
  ) {
    try {
      // Ensure ChatService has the client reference
      if (!this.nezonClient) {
        this.nezonClient = client;
        this.chatService.setNezonClient(client);
        this.logger.log('✅ Nezon client initialized from onStartInterview');
      }

      if (!userId) {
        await message.reply(SmartMessage.text('❌ Invalid request'));
        return;
      }

      const account = this.getAccount();
      const selectedTemplateId = formData?.template;

      if (!selectedTemplateId) {
        await message.reply(
          SmartMessage.text('Please select a template from the dropdown first!')
        );
        return;
      }

      const channelId = payload.channel_id;
      const username = payload.username || 'Candidate';

      const template = await this.templateService.getTemplateById(selectedTemplateId);

      const channel = await client.channels.fetch(channelId);

      // if (!channel?.meeting_code) {
      //   await message.reply(
      //     SmartMessage.text('Please join a voice channel first!')
      //   );
      //   return;
      // }

      const roomName = channel.meeting_code;

      this.logger.log(`Starting interview for user ${userId}, template: ${template.name}`);

      await message.update(
        SmartMessage.text('⏳ Creating interview session...')
      );

      const session = await this.sessionService.createSession(
        userId,
        username,
        channelId,
        channelId,
        template.id,
        SessionMode.VOICE,
      );

      if (!session || !session.id) {
        throw new Error('Failed to create session');
      }

      this.logger.log(`✅ Session ${session.id} created`);

      await this.sessionService.startSession(session.id);
      this.logger.log(`✅ Session ${session.id} started`);

      await message.update(
        SmartMessage.text('🤖 Bot is joining the voice room...')
      );

      await this.agentService.linkSessionToRoom(channelId, session.id);
      await this.interviewerService.setRoomTemplate(channelId, template);

      const existingSessionId = this.agentService.getSessionIdForRoom(channelId);
      const botAlreadyInRoom = existingSessionId !== undefined && existingSessionId !== session.id;

      if (!botAlreadyInRoom) {
        this.logger.log(`🤖 Inviting bot to room ${channelId}...`);

        await this.agentService.handleInviteAgent(
          client,
          {
            voice_channel_id: channelId,
            channel_id: channelId,
          },
          account,
          session.id, // NEW: Pass sessionId
        );

        this.logger.log(`✅ Bot ready - SSE connected and transcript enabled for room ${channelId}`);

      } else {
        this.logger.log(`✅ Bot already in room ${channelId}, enabling transcript...`);
        
        // If bot already in room, just enable transcript
        try {
          await this.agentService.enableTranscript(channelId);
        } catch (error) {
          this.logger.error('Failed to enable transcript for existing bot:', error);
        }
      }

      const greeting = await this.interviewerService.generateGreeting(template);

      await this.sessionService.addMessage(
        session.id,
        MessageRole.ASSISTANT,
        greeting,
        MessageType.TEXT,
      );
      this.logger.log(`✅ Greeting saved to DB`);

      try {
        await this.agentService.sendTTS(channelId, greeting);
        this.logger.log(`🔊 TTS sent successfully to room ${channelId}`);
      } catch (error) {
        this.logger.error(`❌ Failed to send TTS:`, error);
      }

      await message.update(
        SmartMessage.text(
          `✅ **Interview Started!**\n\n` +
          `🎤 **Bot has joined the voice room and is speaking:**\n\n` +
          `"${greeting}"\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `**Interview Details:**\n` +
          `📝 Template: **${template.name}**\n` +
          `🆔 Session ID: ${session.id}\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `**💬 Speak your first message to begin the interview!**\n` +
          `(e.g., "Hello", "I'm ready", etc.)`
        )
      );

      this.logger.log(`✅ Interview ready - waiting for user's first message`);

    } catch (error: any) {
      this.logger.error('Error starting interview:', error);
      await message.update(
        SmartMessage.text(`❌ **Failed to start interview**\n\n${error.message}\n\nPlease try again with *start`)
      );
    }
  }

  private startAnswerTimeout(
      sessionId: string,
      client: Nezon.Client,
      channelId: string,
      userId: string,
  ) {
    const existing = this.answerTimeouts.get(sessionId);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(async () => {
      const channel = client.channels.get(channelId);
      if (!channel) return;
      await channel.send(
          SmartMessage.build()
              .addEmbed(
                  new EmbedBuilder()
                      .setColor('#0099ff')
                      .setTitle('Did you finish your answer?')
              )
              .addButton(
                  new ButtonBuilder()
                      .setCustomId(`/interview/confirmCompleted/${userId}`)
                      .setLabel('Yes ')
                      .setStyle(ButtonStyle.Success)
              )
              .addButton(
                  new ButtonBuilder()
                      .setCustomId(`/interview/confirmNotCompleted/${userId}`)
                      .setLabel('No')
                      .setStyle(ButtonStyle.Danger)
              )
              .toContent()
      );
      this.answerTimeouts.delete(sessionId);
    }, 3_000);
    this.answerTimeouts.set(sessionId, timeout);
  }

  private async kickBotFromRoom(
    client: Nezon.Client,
    channelId: string,
    roomName: string,
    sessionId?: string,
  ): Promise<void> {
    try {
      this.logger.log(`🤖 Kicking bot from room ${roomName}...`);

      await this.agentService.handleRemoveAgent(
        client,
        {
          voice_channel_id: channelId,
          channel_id: channelId,
        },
        this.getAccount(),
        sessionId,
      );

      this.logger.log(`✅ Bot removed from room ${roomName}`);
    } catch (error) {
      this.logger.error(`❌ Failed to kick bot from room ${roomName}:`, error);
    }
  }

  @Component({ pattern: '/interview/cancel/:user_id' })
  async onCancelInterview(
    @ComponentParams('user_id') userId: string | undefined,
    @ChannelMessagePayload() payload: Nezon.ChannelMessage,
    @AutoContext() [message]: Nezon.AutoContext,
  ) {
    try {
      if (!userId) {
        await message.reply(SmartMessage.text('❌ Invalid request'));
        return;
      }

      // Update message để xóa form và hiển thị thông báo
      await message.update(
        SmartMessage.text('❌ **Interview selection cancelled.**\n\nUse `*start` to begin again.')
      );

      this.logger.log(`🚫 User ${userId} cancelled template selection`);

    } catch (error) {
      this.logger.error('Error cancelling interview selection:', error);
      await message.update(
        SmartMessage.text('❌ Failed to cancel selection.')
      );
    }
  }

  /**
   * User confirms they finished speaking - process their answer and send next question
   */
  @Component({ pattern: '/interview/confirmCompleted/:user_id' })
  async onConfirmCompleted(
    @ComponentParams('user_id') userId: string,
    @ChannelMessagePayload() payload: Nezon.ChannelMessage,
    @Client() client: Nezon.Client,
    @AutoContext() [message]: Nezon.AutoContext,
  ) {
    try {
      const session = await this.sessionService.getActiveSession(
        userId,
        payload.channel_id,
      );

      if (!session) {
        this.logger.log(`No active session found for user ${userId}`);
        await message.update(
          SmartMessage.text('❌ No active interview session found.')
        );
        return;
      }

      // Clear the timeout for this session
      const timeout = this.answerTimeouts.get(session.id);
      if (timeout) {
        clearTimeout(timeout);
        this.answerTimeouts.delete(session.id);
      }

      // Check if this is the first message (greeting response)
      const userMessages = session.messages?.filter(m => m.role === MessageRole.USER) || [];
      const isFirstMessage = userMessages.length === 1; // Just the greeting response

      if (isFirstMessage) {
        // User responded to greeting, start first question
        this.logger.log(`User responded to greeting, starting first question`);

        await message.update(
          SmartMessage.text('✅ Great! Let\'s begin the interview...')
        );

        await this.sendNextQuestion(
          session,
          1, // First question
          client,
          payload.channel_id,
        );
        return;
      }

      // Check if interview is complete
      const nextQuestionNumber = session.currentQuestionIndex + 1;
      const totalQuestions = session.template.numberOfQuestions;

      this.logger.log(
        `📊 Confirm completed - Current: ${session.currentQuestionIndex}, ` +
        `Next would be: ${nextQuestionNumber}, Total: ${totalQuestions}`
      );

      if (nextQuestionNumber > totalQuestions) {
        // All questions answered
        this.logger.log('✅ All questions answered, generating feedback');

        await message.update(
          SmartMessage.text('🎉 All questions answered! Generating your feedback...')
        );

        const overallFeedback = await this.interviewerService.generateOverallFeedback(
          await this.sessionService.getSessionById(session.id),
        );

        await this.sessionService.completeSession(session.id, overallFeedback);

        const spokenCompletion = 'Congratulations! You have completed the interview. Thank you for your time joining this interview. You can out voice room to end the interview session';

        await this.sessionService.addMessage(
          session.id,
          MessageRole.ASSISTANT,
          spokenCompletion,
          MessageType.TEXT,
        );
        await this.agentService.sendTTS(session.roomName, spokenCompletion);

        let completionMessage = `🎉 **Interview Complete!**

        "${spokenCompletion}"

        **Session Summary:**
        Template: ${session.template.name}
        Questions Answered: ${session.template.numberOfQuestions}

        ━━━━━━━━━━━━━━━━━━━━━━`;  

        const channel = client.channels.get(payload.channel_id);
        if (channel) {
          await channel.send({ t: completionMessage });
        }

        // Auto kick bot so agent starts generating audio
        this.logger.log(`🤖 Auto-kicking bot from room ${session.roomName} after interview complete...`);
        await this.kickBotFromRoom(client, payload.channel_id, session.roomName, session.id);
        return;
      }

      // Continue to next question
      await message.update(
        SmartMessage.text('✅ Answer recorded! Moving to the next question...')
      );

      await this.sendNextQuestion(
        session,
        nextQuestionNumber,
        client,
        payload.channel_id,
      );

    } catch (error) {
      this.logger.error('Error in confirmCompleted:', error);
      await message.update(
        SmartMessage.text('❌ An error occurred. Please try again.')
      );
    }
  }

  /**
   * User says they're still speaking - just acknowledge and wait
   */
  @Component({ pattern: '/interview/confirmNotCompleted/:user_id' })
  async onConfirmNotCompleted(
    @ComponentParams('user_id') userId: string,
    @AutoContext() [message]: Nezon.AutoContext,
  ) {
    try {
      const session = await this.sessionService.getActiveSession(
        userId,
        message.channelId,
      );

      if (session) {
        // Clear the timeout
        const timeout = this.answerTimeouts.get(session.id);
        if (timeout) {
          clearTimeout(timeout);
          this.answerTimeouts.delete(session.id);
        }
      }

      await message.update(
        SmartMessage.text('⏳ No problem. Please continue your answer.\n\nWe\'ll check again in a moment...')
      );

      this.logger.log(`User ${userId} indicated they're still speaking`);

    } catch (error) {
      this.logger.error('Error in confirmNotCompleted:', error);
    }
  }

  /**
   * User clicks "Finish & Get Recording" after interview complete
   * → kick bot → agent generates audio → POST /api/interview/audio → send links to chat
   */
  @Component({ pattern: '/interview/finish/:session_id' })
  async onFinishInterview(
    @ComponentParams('session_id') sessionId: string,
    @ChannelMessagePayload() payload: Nezon.ChannelMessage,
    @AutoContext() [message]: Nezon.AutoContext,
    @Client() client: Nezon.Client,
  ) {
    try {
      await message.update(
        SmartMessage.text('⏳ **Ending session...** Please wait while we process your recording.')
      );

      const session = await this.sessionService.getSessionById(sessionId);
      if (!session) {
        await message.update(SmartMessage.text('❌ Session not found.'));
        return;
      }

      this.logger.log(`🤖 User confirmed finish, kicking bot from room ${session.roomName}...`);
      await this.kickBotFromRoom(client, payload.channel_id, session.roomName, session.id);

      await message.update(
        SmartMessage.text(
          '✅ **Session ended!**\n\n' +
          '🎙️ Your recording is being processed...\n' +
          '📩 The audio link will be sent here automatically in a few minutes.'
        )
      );

      this.logger.log(`✅ Finish confirmed for session ${sessionId}`);
    } catch (error) {
      this.logger.error('Error in onFinishInterview:', error);
      await message.update(SmartMessage.text('❌ Something went wrong. Please try again.'));
    }
  }

  @Command("history")
  async history(
    @AutoContext() [message]: Nezon.AutoContext,
  ) {
    try {
      const sessions = await this.sessionService.getRecentSessions(10);
 
      if (sessions.length === 0) {
        await message.reply(SmartMessage.text('📭 No interview sessions found.'));
        return;
      }
 
      const statusEmoji: Record<string, string> = {
        pending:     '⏳',
        in_progress: '▶️',
        completed:   '✅',
        cancelled:   '❌',
      };
 
      const lines: string[] = ['📋 **Recent Interviews**\n'];
 
      sessions.forEach((session, index) => {
        const emoji  = statusEmoji[session.status] ?? '❓';
        const start  = session.startedAt
          ? new Date(session.startedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
          : '—';
        const end    = session.completedAt
          ? new Date(session.completedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
          : '—';
 
        let duration = '—';
        if (session.durationSeconds) {
          const m = Math.floor(session.durationSeconds / 60);
          const s = session.durationSeconds % 60;
          duration = m > 0 ? `${m}m ${s}s` : `${s}s`;
        }
 
        const audio = session.audioFile
          ? session.audioFile
          : session.audioFilePaths?.length
            ? `${session.audioFilePaths.length} track(s)`
            : '—';

        const totalScore = session.overallFeedback?.totalScore != null
          ? `${session.overallFeedback.totalScore}/10`
          : '—';
 
        lines.push(
          `**${index + 1}. ${emoji} ${session.template?.name ?? 'Unknown'}**`,
          `   👤 User: \`${session.userId}\``,
          `   🏠 Room: \`${session.roomName ?? '—'}\``,
          `   📅 Started: ${start}`,
          `   🏁 Completed: ${end}`,
          `   ⏱ Duration: ${duration}`,
          `   ⭐ Score: ${totalScore}`,
          `   🎧 Audio: ${audio}`,
          `   ━━━━━━━━━━━━━━━━━━━━━━`,
          '',
        );
      });
 
      await message.reply(SmartMessage.text(lines.join('\n')));
    } catch (error) {
      this.logger.error('Error in history command:', error);
      await message.reply(SmartMessage.text('❌ Failed to load interview history.'));
    }
  }
}
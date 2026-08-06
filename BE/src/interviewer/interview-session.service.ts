import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { InterviewSession, SessionStatus, SessionMode, SelectedSection, OverallFeedbackDto } from '../database-test/entities/interview-session-test.entity';
import { SessionMessage, MessageRole, MessageType } from '../database-test/entities/session-message.entity';
import { TemplateService } from './template.service';
import { UserService } from './user.service';
import { QuestionSection } from '../database-test/entities/interview-template.entity';

import { SystemSetting } from '../database-test/entities/system-setting.entity';

@Injectable()
export class InterviewSessionService {
  private readonly logger = new Logger(InterviewSessionService.name);

  constructor(
    @InjectRepository(InterviewSession)
    private readonly sessionRepo: Repository<InterviewSession>,
    @InjectRepository(SessionMessage)
    private readonly messageRepo: Repository<SessionMessage>,
    @InjectRepository(SystemSetting)
    private readonly settingRepo: Repository<SystemSetting>,
    private readonly templateService: TemplateService,
    private readonly userService: UserService,
  ) { }

  async shouldSendResultLink(): Promise<boolean> {
    const setting = await this.settingRepo.findOne({ where: { key: 'send_result_link_to_candidate' } });
    return !setting || setting.value === 'true';
  }

  /**
   * Create new interview session
   */
  async createSession(
    mezonUserId: string,
    username: string,
    channelId: string,
    roomName: string,
    templateId: string | null,
    mode: SessionMode = SessionMode.TEXT,
    isExternal = false,
    roomId: string = null,
  ): Promise<InterviewSession> {
    // Find or create user
    const user = await this.userService.findOrCreateUser(mezonUserId, username);

    // Get template with full info
    let template;
    if (templateId) {
      template = await this.templateService.getTemplateById(templateId);
    } else {
      // Default fallback if neither is provided
      template = await this.templateService.getDefaultTemplate();
    }

    // Check for active session
    const existingSession = await this.getActiveSession(user.id, channelId);
    if (existingSession) {
      throw new BadRequestException(
        'You already have an active interview session. Use *cancel to end it first.'
      );
    }

    let selectedQuestions: string[] | null = null;
    let selectedSections: SelectedSection[] | null = null;
    // if (template.name === 'Non-AI Generate Interview') {
    //   selectedQuestions = this.randomSelectQuestions(
    //     template.sampleQuestions,
    //     template.numberOfQuestions
    //   );
    //   this.logger.log(`Selected ${selectedQuestions.length} random questions for Non-AI template`);
    // }
    if (template.questionSections && template.questionSections.length > 0) {
      const result = this.selectQuestionsFromSections(template.questionSections);
      selectedQuestions = result.flatQuestions;
      selectedSections = result.sections;

      this.logger.log(
        `Selected questions from ${template.questionSections.length} sections:\n` +
        result.sections.map(s => `  • ${s.sectionName}: ${s.selectedQuestions.length} questions`).join('\n')
      );
    } else {
      // Fallback to old random selection
      selectedQuestions = this.randomSelectQuestions(
        template.sampleQuestions,
        template.numberOfQuestions
      );
      this.logger.log(`Selected ${selectedQuestions.length} random questions (legacy mode)`);
    }

    // Create session
    const session = this.sessionRepo.create({
      userId: user.mezonUserId,
      channelId,
      roomName,
      templateId: template.id,
      template, // Include template relation
      mode,
      status: SessionStatus.PENDING,
      currentQuestionIndex: 0,
      questionScores: [],
      audioFilePaths: [],
      selectedQuestions,
      selectedSections,
      isExternal,
      roomId,
      candidateToken: randomUUID(),
    });

    const savedSession = await this.sessionRepo.save(session);
    this.logger.log(`Created session ${savedSession.id} for user ${user.id}`);

    // Return with full relations
    return this.getSessionById(savedSession.id);
  }

  /**
   * NEW: Select questions from structured sections
   * IMPORTANT: First question is ALWAYS "Can you introduce yourself and your background?"
   */
  private selectQuestionsFromSections(sections: QuestionSection[]): {
    flatQuestions: string[];
    sections: SelectedSection[];
  } {
    const selectedSections: SelectedSection[] = [];
    const flatQuestions: string[] = [];
    const FIXED_FIRST_QUESTION = 'Can you introduce yourself and your background?';

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      let selected: string[];

      if (section.type === 'IELTS_PART2') {
        // Part 2 section contains a single Cue Card question
        selected = section.questions.filter(Boolean).slice(0, 1);
        if (selected.length === 0) {
          selected = ['Describe a topic of your choice and speak about it for 1 to 2 minutes.'];
        }
        this.logger.log(`📌 IELTS Part 2 Section added: "${section.name}"`);
      } else if (section.type === 'IELTS_PART1' || section.type === 'IELTS_PART3') {
        // IELTS Part 1 or Part 3: select questions directly from defined list
        selected = this.randomSelectFromArray(
          section.questions.filter(Boolean),
          section.questionsToSelect || 1
        );
      } else if (i === 0) {
        // For the FIRST standard section only: Always include fixed introduction question
        const otherQuestions = section.questions.filter(q => q !== FIXED_FIRST_QUESTION);
        const countToSelect = Math.max(0, (section.questionsToSelect || 1) - 1);

        const randomOthers = countToSelect > 0
          ? this.randomSelectFromArray(otherQuestions, countToSelect)
          : [];

        selected = [FIXED_FIRST_QUESTION, ...randomOthers];
        this.logger.log(`✅ First question locked: "${FIXED_FIRST_QUESTION}"`);
      } else {
        // For other sections, select randomly as usual
        selected = this.randomSelectFromArray(
          section.questions.filter(Boolean),
          section.questionsToSelect || 1
        );
      }

      selectedSections.push({
        sectionName: section.name,
        selectedQuestions: selected,
        type: section.type || 'STANDARD',
        prepTimeSeconds: section.prepTimeSeconds ?? 60,
        speakingTimeSeconds: section.speakingTimeSeconds ?? 120,
      });

      flatQuestions.push(...selected);
    }

    return { flatQuestions, sections: selectedSections };
  }

  /**
   * Helper: Randomly select N items from array
   */
  private randomSelectFromArray<T>(array: T[], count: number): T[] {
    if (array.length <= count) {
      return [...array];
    }

    const shuffled = [...array].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  private randomSelectQuestions(questionPool: string[], count: number): string[] {
    if (questionPool.length < count) {
      this.logger.warn(
        `Question pool size (${questionPool.length}) is less than required count (${count})`
      );
      return questionPool;
    }

    // First question is ALWAYS the introduction question (index 0)
    const selected: string[] = [questionPool[0]];

    // Create pool of remaining questions (excluding index 0)
    const remainingQuestions = questionPool.slice(1);

    // Randomly select (count - 1) questions from remaining pool
    const shuffled = [...remainingQuestions].sort(() => Math.random() - 0.5);
    selected.push(...shuffled.slice(0, count - 1));

    return selected;
  }

  /**
   * Get session by ID with all relations
   */
  async getSessionById(sessionId: string): Promise<InterviewSession | null> {
    return this.sessionRepo.findOne({
      where: { id: sessionId },
      relations: ['template', 'messages'],
    });
  }

  /**
   * Get active session for user in channel
   */
  async getActiveSession(userId: string, channelId: string): Promise<InterviewSession | null> {
    return this.sessionRepo.findOne({
      where: {
        userId,
        channelId,
        status: SessionStatus.IN_PROGRESS,
      },
      relations: ['template', 'user', 'messages'],
    });
  }

  /**
   * Start session
   */
  async startSession(sessionId: string): Promise<InterviewSession> {
    const session = await this.getSessionById(sessionId);
    if (!session) {
      throw new BadRequestException('Session not found');
    }

    session.status = SessionStatus.IN_PROGRESS;
    session.startedAt = new Date();
    await this.sessionRepo.save(session);

    return this.getSessionById(sessionId);
  }

  /**
   * Add message to session - FIX: Ensure session is loaded properly
   */
  async addMessage(
    sessionId: string,
    role: MessageRole,
    content: string,
    type: MessageType = MessageType.TEXT,
    questionNumber?: number,
    audioFilePath?: string,
  ): Promise<SessionMessage> {
    // Verify session exists first
    const session = await this.sessionRepo.exists({
      where: { id: sessionId },
    });

    if (!session) {
      throw new BadRequestException(`Session not found: ${sessionId}`);
    }

    // Create message with explicit sessionId
    const message = this.messageRepo.create({
      sessionId, // Explicitly set sessionId
      role,
      type,
      content,
      questionNumber,
      audioFilePath,
    });

    const savedMessage = await this.messageRepo.save(message);

    // Increment question index if assistant message with question number
    if (role === MessageRole.ASSISTANT && questionNumber) {
      await this.sessionRepo.update(
        { id: sessionId },
        { currentQuestionIndex: questionNumber }
      );
    }

    this.logger.log(`Added message to session ${sessionId}, role: ${role}`);
    return savedMessage;
  }

  /**
     * Complete session with overall feedback
     */
  async completeSession(
    sessionId: string,
    overallFeedback: InterviewSession['overallFeedback'],
  ): Promise<InterviewSession> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      select: ['id', 'startedAt'],
    });

    if (!session) {
      throw new BadRequestException('Session not found');
    }

    const duration = Math.floor(
      (new Date().getTime() - new Date(session.startedAt).getTime()) / 1000
    );

    await this.sessionRepo.update(
      { id: sessionId },
      {
        status: SessionStatus.COMPLETED,
        completedAt: new Date(),
        overallFeedback,
        durationSeconds: duration,
      }
    );
    this.logger.log(`Completed session ${sessionId}`);

    return this.getSessionById(sessionId);
  }

  async cancelSession(userId: string, channelId: string): Promise<void> {
    const result = await this.sessionRepo.update(
      {
        userId,
        channelId,
        status: SessionStatus.IN_PROGRESS,
      },
      {
        status: SessionStatus.CANCELLED,
      }
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Cancelled session for user ${userId} in channel ${channelId}`);
    }
  }

  /**
   * Get user session history
   */
  async getUserSessions(userId: string, limit: number = 10): Promise<InterviewSession[]> {
    return this.sessionRepo.find({
      where: { userId },
      relations: ['template'],
      order: { startedAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Format session history
   */
  formatSessionHistory(sessions: InterviewSession[]): string {
    if (sessions.length === 0) {
      return 'No interview history found.';
    }

    let message = '📊 **Your Interview History:**\n\n';

    sessions.forEach((session, index) => {
      const statusEmoji = {
        pending: '⏳',
        in_progress: '▶️',
        completed: '✅',
        cancelled: '❌',
      }[session.status];

      const modeEmoji = {
        text: '💬',
        voice: '🎤',
        mixed: '🎭',
      }[session.mode];

      message += `${index + 1}. ${statusEmoji} ${session.template.name} ${modeEmoji}\n`;
      message += `   Started: ${new Date(session.startedAt).toLocaleString()}\n`;
      message += `   Status: ${session.status}\n`;

      if (session.overallFeedback?.totalScore) {
        message += `   Score: ${session.overallFeedback.totalScore}/10\n`;
      }

      if (session.durationSeconds) {
        const minutes = Math.floor(session.durationSeconds / 60);
        message += `   Duration: ${minutes} minutes\n`;
      }

      message += '\n';
    });

    return message;
  }

  /**
   * Find active/completed session by room name (for external meeting mapping)
   */
  async getSessionByRoomName(roomName: string): Promise<InterviewSession | null> {
    return this.sessionRepo.findOne({
      where: {
        roomName,
        status: In([SessionStatus.IN_PROGRESS, SessionStatus.COMPLETED, SessionStatus.PENDING]),
      },
      relations: ['template'],
      order: { startedAt: 'DESC' },
    });
  }

  async findSessionByUserAndRoom(
    userId: string,
    roomName: string,
  ): Promise<InterviewSession | null> {
    return this.sessionRepo.findOne({
      where: {
        userId,
        roomName,
        status: In([SessionStatus.IN_PROGRESS, SessionStatus.COMPLETED, SessionStatus.PENDING]),
      },
      relations: ['template', 'messages'],
      order: {
        startedAt: 'DESC', // Get most recent session
      },
    });
  }

  async cancelSession2(sessionId: string): Promise<void> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      select: ['id', 'status', 'startedAt'],
    });

    if (session && session.status === SessionStatus.IN_PROGRESS) {
      session.status = SessionStatus.CANCELLED;
      session.completedAt = new Date();

      // Calculate duration
      if (session.startedAt) {
        const duration = Math.floor(
          (new Date().getTime() - new Date(session.startedAt).getTime()) / 1000
        );
        session.durationSeconds = duration;
      }

      await this.sessionRepo.save(session);
      this.logger.log(`Cancelled session ${session.id}`);
    }
  }
  /**
 * Add audio URLs to session
 */
  async addAudioUrls(
    sessionId: string,
    urls: string[],
  ): Promise<InterviewSession> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      select: ['id', 'audioFilePaths'],
    });

    if (!session) {
      throw new BadRequestException(`Session ${sessionId} not found`);
    }

    // Append new URLs to existing array
    const currentUrls = session.audioFilePaths || [];
    const updatedUrls = [...currentUrls, ...urls];

    // Update session
    await this.sessionRepo.update(
      { id: sessionId },
      { audioFilePaths: updatedUrls }
    );

    this.logger.log(
      `Added ${urls.length} audio URL(s) to session ${sessionId}. Total: ${updatedUrls.length}`
    );

    // Return updated session
    return this.getSessionById(sessionId);
  }

  async addMergedAudioUrl(
    sessionId: string,
    url: string,
  ): Promise<InterviewSession> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      select: ['id'],
    });
 
    if (!session) {
      throw new BadRequestException(`Session ${sessionId} not found`);
    }
 
    await this.sessionRepo.update(
      { id: sessionId },
      { audioFile: url },
    );
 
    this.logger.log(`Saved merged audio URL for session ${sessionId}: ${url}`);
 
    return this.getSessionById(sessionId);
  }

  /**
   * Get all audio URLs for a session
   */
  async getAudioUrls(sessionId: string): Promise<string[]> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      select: ['audioFilePaths'],
    });

    if (!session) {
      throw new BadRequestException(`Session ${sessionId} not found`);
    }

    return session.audioFilePaths || [];
  }

  /**
   * Clear all audio URLs from a session
   */
  async clearAudioUrls(sessionId: string): Promise<void> {
    await this.sessionRepo.update(
      { id: sessionId },
      { audioFilePaths: [] }
    );

    this.logger.log(`Cleared audio URLs for session ${sessionId}`);
  }

  async getRecentSessions(limit: number = 10): Promise<InterviewSession[]> {
    return this.sessionRepo.find({
      relations: ['template'],
      order: { startedAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Save per-question scores from AI scoring pipeline
   */
  async saveQuestionScores(sessionId: string, scores: {
    questionNumber: number;
    question: string;
    answer: string;
    criteria?: {
      relevance: number;
      contentDepth: number;
      fluency: number;
      grammarVocabulary: number;
      structure: number;
    };
    score: number;
    feedback: string;
  }[]): Promise<void> {
    await this.sessionRepo.update({ id: sessionId }, { questionScores: scores });
    this.logger.log(`Saved ${scores.length} question scores for session ${sessionId}`);
  }

  /**
   * Update totalScore inside overallFeedback after AI scoring completes
   * Merges with existing overallFeedback to preserve overall/strengths/improvements
   */
  async updateOverallScore(
    sessionId: string,
    totalScore: number,
    star?: number,
    starReason?: string,
    criteria?: {
      contentDepthAccuracy: string;
      fluencySpeakingFlow: string;
      pronunciationClarity: string;
      grammarVocabulary: string;
      confidence: string;
    },
    ieltsData?: {
      ieltsBandScore?: number;
      ieltsAverage?: number;
      ieltsCriteria?: {
        fluencyCoherence: number;
        lexicalResource: number;
        grammarRangeAccuracy: number;
        pronunciation: number;
      };
      ieltsCriterionFeedback?: {
        fluency?: string;
        vocabulary?: string;
        grammar?: string;
        pronunciation?: string;
      };
      ieltsWeaknesses?: string[];
      ieltsEstimatedBandReason?: string;
      strengths?: string[];
      overall_feedback?: string;
    },
  ): Promise<void> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      select: ['id', 'overallFeedback'],
    });

    if (!session) return;

    const updated: OverallFeedbackDto = {
      ...(session.overallFeedback || {}),
      totalScore,
      ...(star !== undefined ? { star } : {}),
      ...(starReason !== undefined ? { starReason } : {}),
      ...(criteria !== undefined ? { criteria } : {}),
      ...(ieltsData?.ieltsBandScore !== undefined ? { ieltsBandScore: ieltsData.ieltsBandScore } : {}),
      ...(ieltsData?.ieltsAverage !== undefined ? { ieltsAverage: ieltsData.ieltsAverage } : {}),
      ...(ieltsData?.ieltsCriteria !== undefined ? { ieltsCriteria: ieltsData.ieltsCriteria } : {}),
      ...(ieltsData?.ieltsCriterionFeedback !== undefined ? { ieltsCriterionFeedback: ieltsData.ieltsCriterionFeedback } : {}),
      ...(ieltsData?.ieltsWeaknesses !== undefined ? { ieltsWeaknesses: ieltsData.ieltsWeaknesses, improvements: ieltsData.ieltsWeaknesses } : {}),
      ...(ieltsData?.ieltsEstimatedBandReason !== undefined ? { ieltsEstimatedBandReason: ieltsData.ieltsEstimatedBandReason } : {}),
      ...(ieltsData?.strengths !== undefined ? { strengths: ieltsData.strengths } : {}),
      ...(ieltsData?.overall_feedback !== undefined ? { overall: ieltsData.overall_feedback } : {}),
    };

    await this.sessionRepo.update({ id: sessionId }, { overallFeedback: updated });
    this.logger.log(
      `Updated overall score for session ${sessionId}: score=${totalScore}` +
      (star !== undefined ? `, star=${star}` : '') +
      (ieltsData?.ieltsBandScore !== undefined ? `, ieltsBand=${ieltsData.ieltsBandScore}` : '')
    );
  }

  /**
   * Update the actual star rating given by HR
   */
  async updateHrStar(sessionId: string, hrStar: number): Promise<OverallFeedbackDto> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      select: ['id', 'overallFeedback'],
    });

    if (!session) {
      throw new BadRequestException(`Session ${sessionId} not found`);
    }

    const updated = {
      ...(session.overallFeedback || {}),
      hrStar,
    };

    await this.sessionRepo.update({ id: sessionId }, { overallFeedback: updated });
    this.logger.log(`Updated HR star rating to ${hrStar}/5 for session ${sessionId}`);

    return updated;
  }

  /**
   * End session by setting status to FINISHED_SESSION
   * @param sessionId 
   * @returns 
   */
  async endSession(sessionId: string): Promise<InterviewSession> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId },
      select: ['id'],
    });

    if (!session) {
      throw new BadRequestException('Session not found');
    }

    await this.sessionRepo.update(
      { id: sessionId },
      {
        status: SessionStatus.FINISHED_SESSION
      }
    );
    this.logger.log(`Finished session ${sessionId}`);

    return this.getSessionById(sessionId);
  }

  /**
   * Find sessions that need audio merging
   */
  async findSessionsNeedMergedAudio(): Promise<InterviewSession[]> {
    return this.sessionRepo
      .createQueryBuilder("s")
      .leftJoinAndSelect("s.template", "template")
      .where("s.status IN (:...statuses)", {
        statuses: [SessionStatus.FINISHED_SESSION],
      })
      .andWhere("s.audioFile IS NULL")
      .andWhere("s.audioFilePaths = '[]'::jsonb")
      .getMany();
  }
}
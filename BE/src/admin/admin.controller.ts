import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, FindManyOptions } from 'typeorm';
import { InterviewSession, OverallFeedbackDto } from '@/database-test/entities/interview-session-test.entity';
import { SessionMessage } from '@/database-test/entities/session-message.entity';
import { ScoringService } from '@/interviewer/scoring.service';
import { InterviewSessionService } from '@/interviewer/interview-session.service';

export interface AdminSessionListQuery {
  page?: number;
  limit?: number;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

export interface SessionListItemDto {
  id: string;
  status: string;
  currentQuestionIndex: number;
  startedAt: Date;
  completedAt: Date | null;
  durationSeconds: number | null;
  roomName: string | null;
  user: { id: string; username: string; mezonUserId: string } | null;
  template: { id: string; name: string; type: string; level: string; numberOfQuestions: number } | null;
  overallFeedback: { totalScore: number; star?: number } | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Controller('admin')
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    @InjectRepository(InterviewSession)
    private readonly sessionRepo: Repository<InterviewSession>,
    @InjectRepository(SessionMessage)
    private readonly messageRepo: Repository<SessionMessage>,
    private readonly scoringService: ScoringService,
    private readonly sessionService: InterviewSessionService,
  ) { }

  /**
   * GET /admin/sessions
   * List all sessions with pagination, filter by status and date range
   */
  @Get('sessions')
  @HttpCode(HttpStatus.OK)
  async getSessions(
    @Query() query: AdminSessionListQuery,
  ): Promise<PaginatedResponse<SessionListItemDto>> {
    const page = Number(query.page) || 1;
    const limit = Math.min(Number(query.limit) || 10, 100);
    const skip = (page - 1) * limit;

    const qb = this.sessionRepo
      .createQueryBuilder('session')
      .leftJoinAndSelect('session.template', 'template')
      .leftJoinAndSelect('session.user', 'user')
      .orderBy('session.startedAt', 'DESC')
      .skip(skip)
      .take(limit);

    // Filter by status
    if (query.status && query.status !== 'all') {
      qb.andWhere('session.status = :status', { status: query.status });
    }

    // Filter by date range
    if (query.dateFrom) {
      qb.andWhere('session.startedAt >= :dateFrom', {
        dateFrom: new Date(query.dateFrom),
      });
    }
    if (query.dateTo) {
      const dateTo = new Date(query.dateTo);
      dateTo.setHours(23, 59, 59, 999);
      qb.andWhere('session.startedAt <= :dateTo', { dateTo });
    }

    // Search by username or template name
    if (query.search) {
      qb.andWhere(
        '(user.username ILIKE :search OR template.name ILIKE :search OR CAST(session.id AS TEXT) ILIKE :search)',
        { search: `%${query.search}%` },
      );
    }

    const [sessions, total] = await qb.getManyAndCount();

    // Strip heavy fields from list view
    const data: SessionListItemDto[] = sessions.map((s) => ({
      id: s.id,
      status: s.status,
      currentQuestionIndex: s.currentQuestionIndex,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      durationSeconds: s.durationSeconds,
      roomName: s.roomName ?? null,
      user: s.user
        ? {
          id: s.user.id,
          username: s.user.username,
          mezonUserId: s.user.mezonUserId,
          avatarUrl: s.user.avatarUrl,
        }
        : null,
      template: s.template
        ? {
          id: s.template.id,
          name: s.template.name,
          type: s.template.type,
          level: s.template.level,
          numberOfQuestions: s.template.numberOfQuestions,
        }
        : null,
       overallFeedback: s.overallFeedback
        ? { totalScore: s.overallFeedback.totalScore, star: s.overallFeedback.star }
        : null,
    }));

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * GET /admin/sessions/:id
   * Get full session detail including messages and question scores
   */
  @Get('sessions/:id')
  @HttpCode(HttpStatus.OK)
  async getSessionDetail(
    @Param('id') id: string,
  ): Promise<InterviewSession> {
    const session = await this.sessionRepo.findOne({
      where: { id },
      relations: ['template', 'user'],
    });

    if (!session) {
      throw new NotFoundException(`Session ${id} not found`);
    }

    // Load messages separately (avoid N+1 with cascade)
    const messages = await this.messageRepo.find({
      where: { sessionId: id },
      order: { createdAt: 'ASC' },
    });

    session.messages = messages;
    return session;
  }

  /**
   * POST /admin/sessions/:id/re-evaluate
   * Triggers synchronous re-evaluation of the session audio via Gemini
   */
  @Post('sessions/:id/re-evaluate')
  @HttpCode(HttpStatus.OK)
  async reEvaluateSession(
    @Param('id') id: string,
  ): Promise<InterviewSession> {
    const session = await this.sessionRepo.findOne({
      where: { id },
      relations: ['template'],
    });

    if (!session) {
      throw new NotFoundException(`Session ${id} not found`);
    }

    if (!session.audioFile) {
      throw new BadRequestException(`Session ${id} does not have a merged audio URL for evaluation`);
    }

    const questions = session.selectedQuestions || [];
    if (questions.length === 0) {
      throw new BadRequestException(`Session ${id} does not have selected questions for evaluation`);
    }

    // 1. Run direct scoring (synchronously wait for API call)
    let evaluation;
    try {
      evaluation = await this.scoringService.scoreInterviewDirect(
        session.id,
        session.audioFile,
        questions,
      );
    } catch (err: any) {
      if (err.response) {
        const status = err.response.status;
        const msg = err.response.data?.error?.message || err.message || 'AI API Error';
        this.logger.error(`AI error during re-evaluation: ${status} - ${msg}`);
        if (status === 429) {
          throw new HttpException(`AI Rate Limit Exceeded: ${msg}`, HttpStatus.TOO_MANY_REQUESTS);
        } else if (status >= 500 && status < 600) {
          throw new HttpException(`AI Service Temporary Error: ${msg}`, HttpStatus.BAD_GATEWAY);
        }
      }
      this.logger.error(`Error during re-evaluation: ${err.message}`, err.stack);
      throw new HttpException(err.message || 'Error communicating with evaluation service', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // 2. Save scores per question
    await this.sessionService.saveQuestionScores(session.id, evaluation.questionScores);

    // 3. Compute overall score
    const validScores = evaluation.questionScores.filter(s => s.score > 0);
    let totalScore = 0;
    if (validScores.length > 0) {
      const avg = validScores.reduce((sum, s) => sum + s.score, 0) / validScores.length;
      totalScore = Math.round(avg * 10) / 10;
    }

    // 4. Update overall score and feedback
    await this.sessionService.updateOverallScore(
      session.id,
      totalScore,
      evaluation.star,
      evaluation.starReason,
      evaluation.criteria,
    );

    // 5. Fetch updated session to return
    const updatedSession = await this.sessionRepo.findOne({
      where: { id },
      relations: ['template', 'user'],
    });

    // Load messages separately
    const messages = await this.messageRepo.find({
      where: { sessionId: id },
      order: { createdAt: 'ASC' },
    });

    if (updatedSession) {
      updatedSession.messages = messages;
    }

    return updatedSession!;
  }

  /**
   * POST /admin/sessions/:id/hr-rating
   * Updates the HR evaluation star rating for a session
   */
  @Post('sessions/:id/hr-rating')
  @HttpCode(HttpStatus.OK)
  async updateHrRating(
    @Param('id') id: string,
    @Body('rating') rating: number,
  ): Promise<OverallFeedbackDto> {
    if (rating === undefined || rating < 1 || rating > 5 || (rating * 2) % 1 !== 0) {
      throw new BadRequestException('Rating must be a number between 1 and 5 in steps of 0.5');
    }

    return this.sessionService.updateHrStar(id, rating);
  }

  /**
   * GET /admin/stats
   * Aggregate stats for dashboard
   */
  @Get('stats')
  @HttpCode(HttpStatus.OK)
  async getStats() {
    const [total, completed, inProgress, cancelled] = await Promise.all([
      this.sessionRepo.count(),
      this.sessionRepo.count({ where: { status: 'completed' as any } }),
      this.sessionRepo.count({ where: { status: 'in_progress' as any } }),
      this.sessionRepo.count({ where: { status: 'cancelled' as any } }),
    ]);

    return { total, completed, inProgress, cancelled };
  }
}
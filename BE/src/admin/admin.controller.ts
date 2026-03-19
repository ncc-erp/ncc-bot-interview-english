import {
  Controller,
  Get,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, FindManyOptions } from 'typeorm';
import { InterviewSession } from '@/database-test/entities/interview-session-test.entity';
import { SessionMessage } from '@/database-test/entities/session-message.entity';

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
  user: { id: string; username: string; mezonUserId: string} | null;
  template: { id: string; name: string; type: string; level: string; numberOfQuestions: number } | null;
  overallFeedback: { totalScore: number } | null;
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
  constructor(
    @InjectRepository(InterviewSession)
    private readonly sessionRepo: Repository<InterviewSession>,
    @InjectRepository(SessionMessage)
    private readonly messageRepo: Repository<SessionMessage>,
  ) {}

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
        ? { totalScore: s.overallFeedback.totalScore }
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
import { Controller, Get, Param, NotFoundException, HttpCode, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InterviewSession } from '@/database-test/entities/interview-session-test.entity';
import { SessionMessage } from '@/database-test/entities/session-message.entity';

@Controller('candidate')
export class CandidateController {
  constructor(
    @InjectRepository(InterviewSession)
    private readonly sessionRepo: Repository<InterviewSession>,
    @InjectRepository(SessionMessage)
    private readonly messageRepo: Repository<SessionMessage>,
  ) {}

  @Get('sessions/:token')
  @HttpCode(HttpStatus.OK)
  async getSessionByToken(@Param('token') token: string): Promise<InterviewSession> {
    const session = await this.sessionRepo.findOne({
      where: { candidateToken: token },
      relations: ['template', 'user'],
    });

    if (!session) {
      throw new NotFoundException(`Session with token ${token} not found`);
    }

    const messages = await this.messageRepo.find({
      where: { sessionId: session.id },
      order: { createdAt: 'ASC' },
    });

    session.messages = messages;
    return session;
  }
}

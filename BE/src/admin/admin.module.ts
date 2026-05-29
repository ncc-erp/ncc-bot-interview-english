import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminTemplateController } from './admin-template.controller';
import { InterviewSession } from '@/database-test/entities/interview-session-test.entity';
import { SessionMessage } from '@/database-test/entities/session-message.entity';
import { InterviewTemplate } from '@/database-test/entities/interview-template.entity';
import { InterviewerModule } from '@/interviewer/interviewer.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([InterviewSession, SessionMessage, InterviewTemplate]),
    InterviewerModule,
  ],
  controllers: [AdminController, AdminTemplateController],
})
export class AdminModule {}
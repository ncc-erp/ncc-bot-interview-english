import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminTemplateController } from './admin-template.controller';
import { AdminAuthController } from './admin-auth.controller';
import { CandidateController } from './candidate.controller';
import { InterviewSession } from '@/database-test/entities/interview-session-test.entity';
import { SessionMessage } from '@/database-test/entities/session-message.entity';
import { InterviewTemplate } from '@/database-test/entities/interview-template.entity';
import { SystemSetting } from '@/database-test/entities/system-setting.entity';
import { Admin } from '@/database-test/entities/admin.entity';
import { InterviewerModule } from '@/interviewer/interviewer.module';
import { AdminAuthGuard } from './admin-auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InterviewSession,
      SessionMessage,
      InterviewTemplate,
      SystemSetting,
      Admin,
    ]),
    InterviewerModule,
  ],
  controllers: [
    AdminController,
    AdminTemplateController,
    AdminAuthController,
    CandidateController,
  ],
  providers: [AdminAuthGuard],
  exports: [AdminAuthGuard],
})
export class AdminModule {}
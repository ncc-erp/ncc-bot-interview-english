import { forwardRef, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { createAgent } from "langchain";
// import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { TemplateService } from "./template.service";
import { InterviewSessionService } from "./interview-session.service";
import { EnhancedInterviewerService } from "./interview.service";
import { EnglishTestController } from "@/english-test/english-test.controller";
import { TypeOrmModule } from "@nestjs/typeorm";
import { InterviewTemplate } from "@/database-test/entities/interview-template.entity";
import { InterviewSession } from "@/database-test/entities/interview-session-test.entity";
import { AgentModule } from "@/agent/agent.module";
import { User } from "@/database-test/entities/user-test.entity";
import { CustomPrompt } from "@/database-test/entities/custom-prompt.entity";
import { SessionMessage } from "@/database-test/entities/session-message.entity";
import { UserService } from "./user.service";
import { AIService } from "./ai.service";
import { ChatService } from "./chat.service";
import { AxiosClient } from "@/shared/lib/axios-client";
import { ScoringService } from "./scoring.service";
import { AudioMergeCronService } from "@/record-audio/audio-merge-cron.service";
import { MinioService } from "@/record-audio/minio.service";

import { SystemSetting } from "@/database-test/entities/system-setting.entity";

// const checkpointer = new MemorySaver();

@Module({
  imports: [ConfigModule,
    TypeOrmModule.forFeature([User,
      CustomPrompt,
      InterviewTemplate,
      InterviewSession,
      SessionMessage,
      SystemSetting,]),
  ],
  controllers: [],
  providers: [
    UserService,
    TemplateService,
    InterviewSessionService,
    EnhancedInterviewerService,
    AIService,
    ChatService,
    ScoringService,
    AxiosClient,
    AudioMergeCronService,
    MinioService,
  ],
  exports: [ TemplateService,
    InterviewSessionService,
    EnhancedInterviewerService,
    UserService,
    AIService,
    ChatService,
    ScoringService
],
})
export class InterviewerModule {}

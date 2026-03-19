import { Module } from '@nestjs/common';
import { OrchestratorSSEService } from './orchestrator-sse.service';
import { AgentModule } from '@/agent/agent.module';
import { InterviewerModule } from '@/interviewer/interviewer.module';
import { AxiosClient } from "@/shared/lib/axios-client";
import { RecordAudioModule } from '@/record-audio/record-audio.module';

@Module({
  imports: [AgentModule, InterviewerModule, RecordAudioModule],
  providers: [OrchestratorSSEService, AxiosClient],
  exports: [OrchestratorSSEService],
})
export class OrchestratorModule {}
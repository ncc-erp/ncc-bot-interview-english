import { Module } from "@nestjs/common";
import { InterviewAudioController } from "@/record-audio/record-audio.controller";
import { InterviewerModule } from "@/interviewer/interviewer.module";
import { MinioService } from "@/record-audio/minio.service";

@Module({
  imports: [InterviewerModule],
  controllers: [InterviewAudioController],
  providers: [MinioService],
  exports: [],
})
export class RecordAudioModule { }
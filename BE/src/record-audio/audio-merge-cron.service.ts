import { mergeRoomAudio, parseTracksWithOffset } from '@/record-audio/merged-audio.util';
import { BotAuthService } from '@/auth/bot-auth.service';
import { AxiosClient } from './../shared/lib/axios-client';
import { InterviewSessionService } from '@/interviewer/interview-session.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InterviewSession } from '@/database-test/entities/interview-session-test.entity';
import { MinioService } from './minio.service';
import { ScoringService } from '@/interviewer/scoring.service';

@Injectable()
export class AudioMergeCronService {
  private readonly logger = new Logger(AudioMergeCronService.name);

  constructor(
		private readonly configService: ConfigService,
		private readonly sessionService: InterviewSessionService,
		private readonly axiosClient: AxiosClient,
		private readonly botAuthService: BotAuthService,
		private readonly minioService: MinioService,
		private readonly scoringService: ScoringService,
	) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCron() {
    this.logger.debug("Checking for sessions requiring audio merge...");
		const authToken = await this.botAuthService.getValidAccessToken();

    var sessions = await this.sessionService.findSessionsNeedMergedAudio();
    if (sessions.length > 0) {
			this.logger.log(`Found ${sessions.length} session(s) to process.`);
			for (const session of sessions) {
				const baseUrl = this.configService.get<string>('AGENT_BASE_URL')!;
				const url = `${baseUrl}/api/v2/rooms/audio_info/${session.roomId}`;
				try {
					const response = await this.axiosClient.getInstance().get(url);
					const fileResults = response.data.file_results || [];
					await this.mergeRoomAudio(session, fileResults);
				} catch (error) {
					this.logger.error(`[AudioMergeCronService] Failed to fetch audio info for interview session ${session.id}:`, error);
				}
			}
    }
  }

	private async mergeRoomAudio(session: InterviewSession, fileResults: any[]) {
		if (!fileResults.length) {
      this.logger.warn(`[AudioMergeCronService] No file results for room ${session.roomName}`);
      return;
    }

		try {
			const minioEndpoint = this.configService.get<string>('MINIO_ENDPOINT')!;
      const minioBucket = this.configService.get<string>('MINIO_BUCKET')!;

			// Build tracks from file_results using started_at_ns as timestamp key
      const tracksRecord: Record<string, string> = {};
      for (const f of fileResults) {
        tracksRecord[f.started_at_ns] = f.filename;
      }

			// Save individual track URLs to DB
      const tracksWithOffset = parseTracksWithOffset(tracksRecord, minioEndpoint, minioBucket);
			const individualUrls = tracksWithOffset.map(t => t.url);
			await this.sessionService.addAudioUrls(session.id, individualUrls);
			this.logger.log(`✅ Saved ${individualUrls.length} track URL(s) to session ${session.id}`);

			// Merge tracks
      this.logger.log(`🎵 Merging ${tracksWithOffset.length} tracks...`);
      const mergedPath = await mergeRoomAudio(tracksWithOffset);
      this.logger.log(`✅ Merged at: ${mergedPath}`);

			// Upload merged to MinIO
      const mergedUrl = await this.minioService.uploadFile(mergedPath);
      this.logger.log(`📦 Merged uploaded: ${mergedUrl}`);

			await this.sessionService.addMergedAudioUrl(session.id, mergedUrl);
      this.logger.log(`✅ Saved ${mergedUrl} to session ${session.id}`);

			// Trigger scoring async — does not block audio delivery to user
      const questions = session.selectedQuestions || [];
      if (questions.length > 0) {
        this.scoringService.scoreInterview(
          session.id,
          mergedUrl,
          questions,
          async (evaluation) => {
            await this.sessionService.saveQuestionScores(session.id, evaluation.questionScores);

            // Overall score = average of questions that have answers (score > 0)
            const validScores = evaluation.questionScores.filter(s => s.score > 0);
            let totalScore = 0;
            if (validScores.length > 0) {
              const avg = validScores.reduce((sum, s) => sum + s.score, 0) / validScores.length;
              totalScore = Math.round(avg * 10) / 10;
            }
            await this.sessionService.updateOverallScore(
              session.id,
              totalScore,
              evaluation.star,
              evaluation.starReason,
            );
            this.logger.log(
              `[Scoring] Overall score: ${totalScore}/10, star: ${evaluation.star}/5 for session ${session.id}`
            );
          },
        ).catch(err => this.logger.error(`[Scoring] Async error:`, err.message));
      } else {
        this.logger.warn(`[Scoring] No questions found for session ${session.id}, skipping`);
      }
		} catch (error) {
			this.logger.error(`[AudioMergeCronService] Failed to process audio:`, error);
		}
	}
}
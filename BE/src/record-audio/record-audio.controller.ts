import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  Get,
  Param,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InterviewSessionService } from '../interviewer/interview-session.service';
import { UploadAudioDto } from '../record-audio/upload-audio.dto';
import { ChatService } from '../interviewer/chat.service';
import { mergeRoomAudio, parseTracksWithOffset } from '../record-audio/merged-audio.util';
import { MinioService } from '../record-audio/minio.service';

@Controller('api/interview')
export class InterviewAudioController {
  private readonly logger = new Logger(InterviewAudioController.name);

  constructor(
    private readonly sessionService: InterviewSessionService,
    private readonly chatService: ChatService,
    private readonly configService: ConfigService,
    private readonly minioService: MinioService,
  ) { }

  /**
   * POST /api/interview/audio
   * Agent uploads audio URLs with timestamps after interview completion
   * Then automatically sends audio links to chat room
   * 
   * Request body format:
   * {
   *   "interview_id": "123456789",
   *   "tracks": {
   *     "1707825600000000000": "https://storage.com/audio1.mp3",
   *     "1707825660000000000": "https://storage.com/audio2.mp3"
   *   }
   * }
   */
  @Post('audio')
  @HttpCode(HttpStatus.OK)
  async uploadAudio(@Body() dto: UploadAudioDto) {
    try {
      // Validate request
      if (!dto.interview_id) {
        throw new BadRequestException('interview_id is required');
      }

      if (!dto.tracks || typeof dto.tracks !== 'object') {
        throw new BadRequestException('tracks must be an object');
      }

      // Extract filenames from tracks object
      const trackEntries = Object.entries(dto.tracks);

      if (trackEntries.length === 0) {
        throw new BadRequestException('tracks object is empty');
      }

      // Get MinIO configuration
      const minioEndpoint = this.configService.get<string>('MINIO_ENDPOINT');
      const minioBucket = this.configService.get<string>('MINIO_BUCKET');

      // 1. Parse tracks with nanosecond offsets → TrackInput[]
      const tracksWithOffset = parseTracksWithOffset(
        dto.tracks,
        minioEndpoint,
        minioBucket,
      );

      const urls = tracksWithOffset.map((t) => t.url);

      this.logger.log(
        `Received ${urls.length} audio file(s) for session ${dto.interview_id}\n` +
        `Tracks: ${JSON.stringify(dto.tracks, null, 2)}\n` +
        `Parsed with offsets: ${JSON.stringify(tracksWithOffset, null, 2)}`
      );

      // 2. Get session info
      const session = await this.sessionService.getSessionById(dto.interview_id);
      if (!session) {
        return { success: false, message: `Session ${dto.interview_id} not found` };
      }

      // 3. Save individual track URLs to DB
      await this.sessionService.addAudioUrls(dto.interview_id, urls);
      this.logger.log(`✅ Saved ${urls.length} track URL(s) to session ${dto.interview_id}`);

      // 4. Merge tracks into single file
      let mergedUrl: string | null = null;
      try {
        this.logger.log(`🎵 Merging ${tracksWithOffset.length} tracks...`);
        const mergedPath = await mergeRoomAudio(tracksWithOffset);
        this.logger.log(`✅ Merged audio at: ${mergedPath}`);

        mergedUrl = await this.minioService.uploadFile(mergedPath);
        this.logger.log(`📦 Merged file uploaded: ${mergedUrl}`);
      } catch (mergeError) {
        this.logger.error(`❌ Failed to merge audio, falling back to individual tracks:`, mergeError);
      }

      // 5. Send to chat: merged URL if available, else individual tracks
      const urlsToSend = mergedUrl ? [mergedUrl] : urls;
      await this.chatService.sendAudioLinksToChat(
        session.channelId,
        session.template.name,
        urlsToSend,
      );
      this.logger.log(`📤 Sent audio link(s) to channel ${session.channelId}`);

      return {
        success: true,
        message: 'Audio processed and sent to chat successfully',
        data: {
          sessionId: session.id,
          tracksReceived: trackEntries.length,
          merged: !!mergedUrl,
          channelId: session.channelId,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to process audio: ${error.message}`, error.stack);

      return {
        success: false,
        message: error.message || 'Failed to process audio',
        error: error.message,
      };
    }
  }

  /**
   * GET /api/interview/:sessionId/audio
   * Get all audio URLs for a session
   */
  @Get(':sessionId/audio')
  async getSessionAudio(@Param('sessionId') sessionId: string) {
    try {
      const audioUrls = await this.sessionService.getAudioUrls(sessionId);

      return {
        success: true,
        data: {
          sessionId,
          totalFiles: audioUrls.length,
          audioUrls,
        },
      };
    } catch (error) {
      this.logger.error(`Failed to get audio URLs: ${error.message}`);

      return {
        success: false,
        message: error.message,
      };
    }
  }
}
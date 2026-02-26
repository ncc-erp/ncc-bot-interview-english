import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class MinioService {
  private readonly logger = new Logger(MinioService.name);
  private readonly client: Minio.Client;
  private readonly bucket: string;
  private readonly folder: string;
  private readonly cdnUrl: string;

  constructor(private readonly configService: ConfigService) {
    const endpointUrl = new URL(this.configService.get<string>('BOT_MINIO_ENDPOINT')!);

    this.bucket = this.configService.get<string>('BOT_MINIO_BUCKET')!;
    this.folder = this.configService.get<string>('MINIO_FOLDER', 'audio');
    this.cdnUrl = this.configService.get<string>('CDN_URL')!;

    this.client = new Minio.Client({
      endPoint: endpointUrl.hostname,
      port: parseInt(endpointUrl.port) || (endpointUrl.protocol === 'https:' ? 443 : 80),
      useSSL: endpointUrl.protocol === 'https:',
      accessKey: this.configService.get<string>('BOT_MINIO_ACCESS_KEY')!,
      secretKey: this.configService.get<string>('BOT_MINIO_SECRET_KEY')!,
    });
  }

  async uploadFile(localFilePath: string): Promise<string> {
    const filename = path.basename(localFilePath);
    const objectName = `${this.folder}/${filename}`;

    this.logger.log(`⬆️ Uploading ${filename} to MinIO...`);

    await this.client.fPutObject(this.bucket, objectName, localFilePath, {
      'Content-Type': 'audio/mp4',
    });

    fs.unlinkSync(localFilePath); // cleanup local temp file

    const publicUrl = `${this.cdnUrl}/${objectName}`;
    this.logger.log(`✅ Uploaded: ${publicUrl}`);

    return publicUrl;
  }
}
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegPath from 'ffmpeg-static';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';

ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);

export interface TrackInput {
  url: string;
  offsetMs: number;
}

export interface MergeOptions {
  outputDir?: string;
  outputFileName?: string;
}

/**
 * Merge multiple audio tracks with time offsets into a single file.
 * Tracks are aligned by offsetMs (converted from nanosecond timestamps by caller).
 * Returns local file path of merged output.
 */
export async function mergeRoomAudio(
  tracks: TrackInput[],
  options: MergeOptions = {},
): Promise<string> {
  if (!tracks.length) throw new Error('No tracks provided');

  const {
    outputDir = path.join(process.cwd(), 'tmp', 'merged-audio'),
    outputFileName = `${uuidv4()}.m4a`,
  } = options;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, outputFileName);

  return new Promise((resolve, reject) => {
    const command = ffmpeg();

    tracks.forEach((track) => {
      command.input(track.url);
    });

    // Each track gets delayed by its offset, then all mixed together
    const delayFilters = tracks.map((track, i) => {
      const delay = Math.max(0, Math.round(track.offsetMs));
      return `[${i}:a]adelay=${delay}|${delay}[a${i}]`;
    });

    const mixInputs = tracks.map((_, i) => `[a${i}]`).join('');

    const filterComplex =
      `${delayFilters.join(';')};` +
      `${mixInputs}amix=inputs=${tracks.length}:dropout_transition=0:normalize=0[aout]`;

    command
      .complexFilter(filterComplex)
      .outputOptions(['-map [aout]', '-c:a aac', '-b:a 128k'])
      .on('error', (err) => reject(err))
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

/**
 * Convert nanosecond timestamps to offsetMs relative to the earliest track.
 * Agent returns timestamps as nanosecond Unix epoch strings.
 *
 * Example input:
 *   { "1771916393526883930": "path/agent.ogg", "1771916417018591451": "path/user.ogg" }
 *
 * Returns tracks sorted by timestamp with offsetMs from the first track.
 */
export function parseTracksWithOffset(
  tracks: Record<string, string>,
  minioEndpoint: string,
  minioBucket: string,
): TrackInput[] {
  const entries = Object.entries(tracks).map(([timestampNs, filename]) => {
    const cleanFilename = filename.startsWith('/') ? filename.slice(1) : filename;
    const url = `${minioEndpoint}/${minioBucket}/${cleanFilename}`;
    // nanoseconds → milliseconds
    const timestampMs = Number(BigInt(timestampNs) / BigInt(1_000_000));
    return { url, timestampMs };
  });

  // Sort by timestamp ascending
  entries.sort((a, b) => a.timestampMs - b.timestampMs);

  const earliest = entries[0].timestampMs;

  return entries.map((entry) => ({
    url: entry.url,
    offsetMs: entry.timestampMs - earliest,
  }));
}
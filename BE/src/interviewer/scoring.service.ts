import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import axios from 'axios';

export interface ScoreCriteria {
  relevance: number;         // max 3.0
  contentDepth: number;      // max 2.5
  fluency: number;           // max 2.0
  grammarVocabulary: number; // max 1.5
  structure: number;         // max 1.0
}

export interface QuestionScore {
  questionNumber: number;
  question: string;
  answer: string;          // extracted from audio
  criteria: ScoreCriteria; // breakdown per criterion
  score: number;           // total 0-10
  feedback: string;        // 2-3 sentences
}

export interface InterviewEvaluationResult {
  star: number;
  starReason: string;
  questionScores: QuestionScore[];
}

// Gemini inline audio limit: 20MB
const GEMINI_INLINE_LIMIT_BYTES = 20 * 1024 * 1024;
const TMP_DIR = 'tmp/scoring';

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);

  constructor(private readonly configService: ConfigService) {
    if (!fs.existsSync(TMP_DIR)) {
      fs.mkdirSync(TMP_DIR, { recursive: true });
    }
  }

  /**
   * Main entry — fire-and-forget from OrchestratorSSEService
   * Sends audio directly to Gemini (no Whisper step needed)
   */
  async scoreInterview(
    sessionId: string,
    mergedAudioUrl: string,
    questions: string[],
    onComplete: (evaluation: InterviewEvaluationResult) => Promise<void>,
  ): Promise<void> {
    const tmpFile = path.join(TMP_DIR, `${sessionId}-${Date.now()}.m4a`);

    try {
      this.logger.log(`[Scoring] Starting for session ${sessionId}`);

      // 1. Download merged audio
      await this.downloadFile(mergedAudioUrl, tmpFile);
      const fileSize = fs.statSync(tmpFile).size;
      this.logger.log(`[Scoring] Downloaded: ${tmpFile} (${fileSize} bytes)`);

      // 2. Score directly from audio via Gemini (transcribe + score in 1 request)
      const evaluation = await this.scoreWithGemini(tmpFile, fileSize, questions);
      this.logger.log(`[Scoring] Scored ${evaluation.questionScores.length} questions. Star rating: ${evaluation.star}/5`);

      // 3. Save via callback
      await onComplete(evaluation);
      this.logger.log(`[Scoring] Completed for session ${sessionId}`);

    } catch (error) {
      this.logger.error(`[Scoring] Failed for session ${sessionId}:`, error.message);
    } finally {
      this.cleanup(tmpFile);
    }
  }

  // ─────────────────────────────────────────────
  // Download
  // ─────────────────────────────────────────────

  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      const protocol = url.startsWith('https') ? https : http;

      protocol.get(url, (res) => {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (err) => { fs.unlink(dest, () => { }); reject(err); });
      }).on('error', (err) => {
        fs.unlink(dest, () => { });
        reject(err);
      });
    });
  }

  // ─────────────────────────────────────────────
  // Score with Gemini (audio → score in 1 request)
  // ─────────────────────────────────────────────

  private async scoreWithGemini(
    filePath: string,
    fileSize: number,
    questions: string[],
  ): Promise<InterviewEvaluationResult> {
    const apiKey = this.configService.get<string>('GOOGLE_API_KEY')!;

    const questionList = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');

    const prompt = [
      'You are a professional English interview evaluator.',
      'Listen to this interview recording and evaluate the CANDIDATE\'s answers.',
      '',
      'INTERVIEW QUESTIONS (in order):',
      questionList,
      '',
      'SCORING RUBRIC (max 10 points total per question):',
      '1. RELEVANCE (max 3.0 pts)',
      '   3.0 = Fully on-topic | 2.0 = Mostly relevant | 1.0 = Partially | 0 = Off-topic/missing',
      '',
      '2. CONTENT DEPTH (max 2.5 pts)',
      '   2.5 = Rich details/examples | 1.5 = Some detail | 0.5 = Generic | 0 = Too vague',
      '',
      '3. FLUENCY (max 2.0 pts)',
      '   2.0 = Natural flow | 1.5 = Minor pauses | 1.0 = Noticeable hesitation | 0 = Very broken',
      '',
      '4. GRAMMAR & VOCABULARY (max 1.5 pts)',
      '   1.5 = Accurate, diverse | 1.0 = Minor errors | 0.5 = Frequent errors | 0 = Major errors',
      '',
      '5. STRUCTURE (max 1.0 pt)',
      '   1.0 = Well-organized | 0.5 = Some structure | 0 = Unstructured',
      '',
      'FINAL SCORE = sum of all criteria (rounded to 1 decimal, max 10)',
      '',
      'OVERALL CANDIDATE STAR RATING (from 1 to 5 stars):',
      'Evaluate the candidate\'s overall English proficiency and communication level for the ENTIRE interview based on these levels:',
      '- 1 Star (1*): Basic entry level. The candidate is only able to introduce themselves in English using approximately 5-7 sentences and struggles or fails to answer subsequent questions.',
      '- 2 Stars (2*): Elementary level. The candidate can perform a basic self-introduction in English and provide short answers (usually 1-2 sentences) to questions. They can discuss basic topics such as their background, experience, tech stack, and daily tasks (or for interns, self-study, learning new technologies, and career goals). Requires a recognizable accent/pronunciation.',
      '- 3 Stars (3*): Intermediate level. The candidate can introduce themselves and answer questions with 1-2 sentences. In addition to basic topics from Level 2, they can describe their projects, development processes, project challenges, and how they resolved them.',
      '- 4 Stars (4*): Upper-intermediate level. Either the candidate has a good accent but struggles to articulate/develop their ideas clearly (unclear phrasing rather than lack of vocabulary); OR their accent is weak/non-standard but their ideas are well-structured, detailed, and highly coherent.',
      '- 5 Stars (5*): Advanced/Fluent level. The candidate communicates highly fluently and confidently. They provide accurate, comprehensive, and persuasive answers with a natural US/UK accent and correct pronunciation.',
      '',
      'RULES:',
      '- Evaluate based on what you HEAR directly from the audio',
      '- Identify the interviewer (bot) questions and candidate answers correctly',
      '- Score 0 + feedback "No answer found in recording" if answer not found',
      '- Be consistent: same quality = same score across questions',
      '- Return ONLY a valid JSON object, no markdown fences, no extra text',
      '',
      'Return ONLY this JSON object format (do not wrap it in markdown block, do not output anything other than this JSON):',
      '{',
      '  "star": 4,',
      '  "starReason": "Short explanation in English explaining why the candidate received this star rating (1-2 sentences)",',
      '  "questionScores": [',
      '    {',
      '      "questionNumber": 1,',
      '      "question": "original question text",',
      '      "answer": "candidate answer transcribed from audio",',
      '      "criteria": {',
      '        "relevance": 2.5,',
      '        "contentDepth": 2.0,',
      '        "fluency": 1.5,',
      '        "grammarVocabulary": 1.0,',
      '        "structure": 0.5',
      '      },',
      '      "score": 7.5,',
      '      "feedback": "1 sentences on strengths and specific areas to improve"',
      '    }',
      '  ]',
      '}',
    ].join('\n');

    let raw: string;

    if (fileSize <= GEMINI_INLINE_LIMIT_BYTES) {
      // Inline: base64 encode and send directly
      raw = await this.geminiInlineRequest(apiKey, filePath, prompt);
    } else {
      // File API: upload first, then reference by URI
      this.logger.log(`[Scoring] File > 20MB, using Gemini File API...`);
      raw = await this.geminiFileApiRequest(apiKey, filePath, prompt);
    }

    return this.parseGeminiResponse(raw, questions);
  }

  private async geminiInlineRequest(
    apiKey: string,
    filePath: string,
    prompt: string,
  ): Promise<string> {
    const audioData = fs.readFileSync(filePath).toString('base64');

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        contents: [{
          parts: [
            {
              inline_data: {
                mime_type: 'audio/mp4',
                data: audioData,
              },
            },
            { text: prompt },
          ],
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
        },
      },
      { timeout: 180_000 },
    );

    return response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  private async geminiFileApiRequest(
    apiKey: string,
    filePath: string,
    prompt: string,
  ): Promise<string> {
    // Step 1: Upload file to Gemini File API
    const fileSize = fs.statSync(filePath).size;
    const fileName = path.basename(filePath);

    this.logger.log(`[Scoring] Uploading ${fileName} to Gemini File API...`);

    // Initiate resumable upload
    const initResponse = await axios.post(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
      { file: { display_name: fileName } },
      {
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': fileSize,
          'X-Goog-Upload-Header-Content-Type': 'audio/mp4',
          'Content-Type': 'application/json',
        },
      },
    );

    const uploadUrl = initResponse.headers['x-goog-upload-url'];
    if (!uploadUrl) throw new Error('No upload URL from Gemini File API');

    // Upload file bytes
    const fileBuffer = fs.readFileSync(filePath);
    await axios.post(uploadUrl, fileBuffer, {
      headers: {
        'Content-Length': fileSize,
        'X-Goog-Upload-Offset': 0,
        'X-Goog-Upload-Command': 'upload, finalize',
        'Content-Type': 'audio/mp4',
      },
      maxBodyLength: Infinity,
      timeout: 300_000,
    });

    // Step 2: Wait for file to be processed (ACTIVE state)
    const fileUri = initResponse.data?.file?.uri;
    if (!fileUri) throw new Error('No file URI from Gemini File API');

    this.logger.log(`[Scoring] File uploaded: ${fileUri}, waiting for processing...`);
    await this.waitForFileActive(apiKey, fileUri);

    // Step 3: Generate content with file reference
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        contents: [{
          parts: [
            { file_data: { mime_type: 'audio/mp4', file_uri: fileUri } },
            { text: prompt },
          ],
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
        },
      },
      { timeout: 180_000 },
    );

    // Cleanup uploaded file
    this.deleteGeminiFile(apiKey, fileUri).catch(() => { });

    return response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  private async waitForFileActive(apiKey: string, fileUri: string, maxWaitMs = 60_000): Promise<void> {
    const fileId = fileUri.split('/').pop();
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const res = await axios.get(
        `https://generativelanguage.googleapis.com/v1beta/files/${fileId}?key=${apiKey}`,
      );
      const state = res.data?.state;

      if (state === 'ACTIVE') return;
      if (state === 'FAILED') throw new Error(`Gemini file processing failed: ${fileUri}`);

      await new Promise(r => setTimeout(r, 2000));
    }

    throw new Error(`Gemini file processing timed out: ${fileUri}`);
  }

  private async deleteGeminiFile(apiKey: string, fileUri: string): Promise<void> {
    const fileId = fileUri.split('/').pop();
    await axios.delete(
      `https://generativelanguage.googleapis.com/v1beta/files/${fileId}?key=${apiKey}`,
    );
  }

  // ─────────────────────────────────────────────
  // Parse response
  // ─────────────────────────────────────────────

  private parseGeminiResponse(raw: string, questions: string[]): InterviewEvaluationResult {
    // Extract JSON object by finding first '{' and last '}',
    // bypassing any markdown fences or preamble text from Gemini.
    try {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');

      if (start === -1 || end === -1 || end < start) {
        throw new Error('No JSON object found in response');
      }

      const jsonStr = raw.slice(start, end + 1);
      const parsed = JSON.parse(jsonStr);

      const star = Math.max(1, Math.min(5, Number(parsed.star) || 1));
      const starReason = String(parsed.starReason || 'No reasoning provided.');
      const questionScores = Array.isArray(parsed.questionScores) ? parsed.questionScores : [];

      return {
        star,
        starReason,
        questionScores,
      };
    } catch (err) {
      this.logger.error(
        `[Scoring] Failed to parse Gemini response (${err.message}): ${raw}`,
      );
      return {
        star: 1,
        starReason: 'Scoring failed — AI response could not be parsed',
        questionScores: questions.map((q, i) => ({
          questionNumber: i + 1,
          question: q,
          answer: '',
          criteria: { relevance: 0, contentDepth: 0, fluency: 0, grammarVocabulary: 0, structure: 0 },
          score: 0,
          feedback: 'Scoring failed — AI response could not be parsed',
        })),
      };
    }
  }

  // ─────────────────────────────────────────────
  // Cleanup
  // ─────────────────────────────────────────────

  private cleanup(...files: string[]): void {
    for (const f of files) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch { /* ignore */ }
    }
  }
}
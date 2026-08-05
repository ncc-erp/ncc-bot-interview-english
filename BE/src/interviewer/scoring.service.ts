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
  criteria?: ScoreCriteria; // breakdown per criterion for Standard
  score: number;           // total 0-10 or band score 0-9
  feedback: string;        // 2-3 sentences
}

export interface IeltsEvaluationData {
  fluency_coherence: number;
  lexical_resource: number;
  grammatical_range_accuracy: number;
  pronunciation: number;
  average: number;
  overall_band: number;
  strengths: string[];
  weaknesses: string[];
  criterion_feedback: {
    fluency: string;
    vocabulary: string;
    grammar: string;
    pronunciation: string;
  };
  overall_feedback: string;
  estimated_band_reason: string;
}

export interface InterviewEvaluationResult {
  star: number;
  starReason: string;
  questionScores: QuestionScore[];
  criteria?: {
    contentDepthAccuracy: string;
    fluencySpeakingFlow: string;
    pronunciationClarity: string;
    grammarVocabulary: string;
    confidence: string;
  };
  // IELTS evaluation fields
  isIelts?: boolean;
  ieltsData?: IeltsEvaluationData;
}

/**
 * Official IELTS half-band rounding helper:
 * Average x.00–x.24 -> x.0
 * Average x.25–x.74 -> x.5
 * Average x.75–x.99 -> (x+1).0
 */
export function roundIeltsBandScore(avg: number): number {
  const floor = Math.floor(avg);
  const decimal = avg - floor;

  if (decimal < 0.25) {
    return floor;
  } else if (decimal < 0.75) {
    return floor + 0.5;
  } else {
    return floor + 1.0;
  }
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
    templateType: number = 1,
  ): Promise<void> {
    const tmpFile = path.join(TMP_DIR, `${sessionId}-${Date.now()}.m4a`);

    try {
      this.logger.log(`[Scoring] Starting for session ${sessionId} (templateType: ${templateType})`);

      // 1. Download merged audio
      await this.downloadFile(mergedAudioUrl, tmpFile);
      const fileSize = fs.statSync(tmpFile).size;
      this.logger.log(`[Scoring] Downloaded: ${tmpFile} (${fileSize} bytes)`);

      // 2. Score directly from audio via Gemini
      const evaluation = templateType === 2
        ? await this.scoreIeltsWithGemini(tmpFile, fileSize, questions)
        : await this.scoreWithGemini(tmpFile, fileSize, questions);

      if (evaluation.isIelts && evaluation.ieltsData) {
        this.logger.log(`[Scoring IELTS] Overall Band: ${evaluation.ieltsData.overall_band} (Average: ${evaluation.ieltsData.average})`);
      } else {
        this.logger.log(`[Scoring Standard] Scored ${evaluation.questionScores.length} questions. Star rating: ${evaluation.star}/5`);
      }

      // 3. Save via callback
      await onComplete(evaluation);
      this.logger.log(`[Scoring] Completed for session ${sessionId}`);

    } catch (error) {
      this.logger.error(`[Scoring] Failed for session ${sessionId}:`, error.message);
    } finally {
      this.cleanup(tmpFile);
    }
  }

  /**
   * Runs the audio grading synchronously, returning the parsed evaluation result.
   */
  async scoreInterviewDirect(
    sessionId: string,
    mergedAudioUrl: string,
    questions: string[],
    templateType: number = 1,
  ): Promise<InterviewEvaluationResult> {
    const tmpFile = path.join(TMP_DIR, `${sessionId}-${Date.now()}.m4a`);

    try {
      this.logger.log(`[Scoring Direct] Starting for session ${sessionId} (templateType: ${templateType})`);

      await this.downloadFile(mergedAudioUrl, tmpFile);
      const fileSize = fs.statSync(tmpFile).size;
      this.logger.log(`[Scoring Direct] Downloaded: ${tmpFile} (${fileSize} bytes)`);

      const evaluation = templateType === 2
        ? await this.scoreIeltsWithGemini(tmpFile, fileSize, questions)
        : await this.scoreWithGemini(tmpFile, fileSize, questions);

      return evaluation;
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
  // Score Standard with Gemini (0-10 score, 1-5 star)
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
      'OVERALL CANDIDATE STAR RATING (from 1 to 5 stars, in steps of 0.5 - e.g. 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0):',
      'Evaluate the candidate\'s overall English proficiency and communication level for the ENTIRE interview based on these levels (half stars are allowed and encouraged for candidates between categories):',
      '- 1 Star (1*): Basic entry level. The candidate is only able to introduce themselves in English using approximately 5-7 sentences and struggles or fails to answer subsequent questions.',
      '- 2 Stars (2*): Elementary level. The candidate can perform a basic self-introduction in English and provide short answers (usually 1-2 sentences) to questions. They can discuss basic topics such as their background, experience, tech stack, and daily tasks (or for interns, self-study, learning new technologies, and career goals). Requires a recognizable accent/pronunciation.',
      '- 3 Stars (3*): Intermediate level. The candidate can introduce themselves and answer questions with 1-2 sentences. In addition to basic topics from Level 2, they can describe their projects, development processes, project challenges, and how they resolved them.',
      '- 4 Stars (4*): Upper-intermediate level. Either the candidate has a good accent but struggles to articulate/develop their ideas clearly (unclear phrasing rather than lack of vocabulary); OR their accent is weak/non-standard but their ideas are well-structured, detailed, and highly coherent.',
      '- 5 Stars (5*): Advanced/Fluent level. The candidate communicates highly fluently and confidently. They provide accurate, comprehensive, and persuasive answers with clear, natural, and easily understandable pronunciation.',
      '',
      'OVERALL COMMUNICATION CRITERIA (adjectives: Excellent, Very Good, Good, Basic, Needs Improvement):',
      'Evaluate the candidate holistically for the entire interview on these 5 criteria based on their speaking flow, accent/pronunciation, and content depth:',
      '1. Content Depth & Accuracy: Relevance and detailed technical explanations',
      '2. Fluency & Speaking Flow: Pacing, pauses, hesitation, and flow',
      '3. Pronunciation & Clarity: Enunciation, accent, and clear speech clarity',
      '4. Grammar & Vocabulary: Accuracy, lexical variety, and correct sentence construction',
      '5. Confidence: Delivery tone, assertiveness, and speech confidence',
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
      '  "star": 3.5,',
      '  "starReason": "Short explanation in English (1-2 sentences)",',
      '  "criteria": {',
      '    "contentDepthAccuracy": "Excellent | Very Good | Good | Basic | Needs Improvement",',
      '    "fluencySpeakingFlow": "Excellent | Very Good | Good | Basic | Needs Improvement",',
      '    "pronunciationClarity": "Excellent | Very Good | Good | Basic | Needs Improvement",',
      '    "grammarVocabulary": "Excellent | Very Good | Good | Basic | Needs Improvement",',
      '    "confidence": "Excellent | Very Good | Good | Basic | Needs Improvement"',
      '  },',
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
      raw = await this.geminiInlineRequest(apiKey, filePath, prompt);
    } else {
      this.logger.log(`[Scoring] File > 20MB, using Gemini File API...`);
      raw = await this.geminiFileApiRequest(apiKey, filePath, prompt);
    }

    return this.parseGeminiResponse(raw, questions);
  }

  // ─────────────────────────────────────────────
  // Score IELTS Speaking with Gemini (Band 0.0 - 9.0)
  // ─────────────────────────────────────────────

  private async scoreIeltsWithGemini(
    filePath: string,
    fileSize: number,
  ): Promise<InterviewEvaluationResult> {
    const questionList = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');

    const prompt = [
      '# ROLE',
      'You are a certified IELTS Speaking Examiner.',
      'Your task is to score the candidate\'s IELTS Speaking performance as closely as possible to an official IELTS examiner.',
      'Do NOT be generous or harsh.',
      'Be objective, evidence-based, and consistent.',
      'Evaluate only what the candidate actually says.',
      'Never assume ability beyond the provided transcript or audio.',
      '',
      'INTERVIEW QUESTIONS (in order):',
      questionList,
      '',
      '--------------------------------------------------',
      'SCORING CRITERIA',
      '--------------------------------------------------',
      '1. Fluency and Coherence (FC)',
      '2. Lexical Resource (LR)',
      '3. Grammatical Range and Accuracy (GRA)',
      '4. Pronunciation (PR)',
      '',
      'Each criterion is scored independently using only half-band increments: 0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9.',
      '',
      'The overall score is (FC + LR + GRA + PR) / 4',
      'Then round using official IELTS rules:',
      'Average x.00–x.24 -> x.0',
      'Average x.25–x.74 -> x.5',
      'Average x.75–x.99 -> (x+1).0',
      'Examples: 6.125 -> 6.0 | 6.25 -> 6.5 | 6.74 -> 6.5 | 6.75 -> 7.0 | 7.88 -> 8.0',
      '',
      '--------------------------------------------------',
      'FLUENCY & COHERENCE (FC)',
      '--------------------------------------------------',
      'Evaluate: ability to keep speaking, hesitation, pauses, self-correction, repetition, logical organization, coherence, use of linking devices.',
      'Band 9: effortless speech, almost no hesitation, pauses only for ideas, ideas flow naturally, discourse markers are natural.',
      'Band 8: fluent, occasional hesitation, minor repetition, ideas connected naturally.',
      'Band 7: speaks at length, hesitation mostly when searching for vocabulary, ideas generally organized, some awkward linking.',
      'Band 6: willing to speak, noticeable hesitation, repetitive connectors, occasional loss of coherence.',
      'Band 5: frequent pauses, short answers, struggles to continue.',
      'Band 4 or below: speech frequently breaks down.',
      'DO NOT penalize natural thinking pauses. Only penalize pauses caused by language limitations.',
      '',
      '--------------------------------------------------',
      'LEXICAL RESOURCE (LR)',
      '--------------------------------------------------',
      'Evaluate: vocabulary range, precision, paraphrasing, collocations, natural word choice, repetition.',
      'A high score is NOT awarded simply because rare words are used. Vocabulary must be accurate, natural, appropriate, varied.',
      'Examples of good vocabulary: important -> essential/crucial/vital; good -> beneficial/worthwhile/valuable; problem -> issue/challenge/obstacle; improve -> enhance/strengthen/boost.',
      'Examples of good collocations: make a decision, have a positive impact, play an important role, raise awareness, gain experience, broaden my horizons, take responsibility, reach a conclusion, deal with a problem.',
      'Highly sophisticated words (juxtaposition, paradigm, exacerbate) should NOT automatically increase score. Reward only natural usage.',
      'Penalize: repeated vocabulary, incorrect collocations, unnatural word choice, misuse of advanced vocabulary.',
      '',
      '--------------------------------------------------',
      'GRAMMATICAL RANGE & ACCURACY (GRA)',
      '--------------------------------------------------',
      'Evaluate: sentence variety, complexity, accuracy, error frequency.',
      'Examples of complex grammar: Relative clauses (People who...), Passive voice, Conditional sentences (If I had...), Although..., Even though..., Whereas..., Not only...but also..., The reason why..., Participle clauses, Cleft sentences, Inversion.',
      'Band 9: almost entirely error free.',
      'Band 8: wide range, few mistakes.',
      'Band 7: good range, frequent error-free complex sentences.',
      'Band 6: mix of simple and complex, errors present but meaning clear.',
      'Band 5: mostly simple sentences, limited complexity.',
      'Do NOT reward complexity if it produces many mistakes. Accuracy is more important than complexity.',
      '',
      '--------------------------------------------------',
      'PRONUNCIATION (PR)',
      '--------------------------------------------------',
      'Accent does NOT affect score.',
      'Evaluate only: intelligibility, stress, rhythm, connected speech, word stress, sentence stress.',
      'A strong Vietnamese accent can still receive Band 8 or 9 if easily understood.',
      'Penalize only pronunciation errors that reduce intelligibility (e.g. rice -> lice, ship -> sheep, tree -> three when meaning becomes unclear).',
      '',
      '--------------------------------------------------',
      'PART-SPECIFIC EXPECTATIONS',
      '--------------------------------------------------',
      'Part 1: Expected 2-4 sentences per answer.',
      'Part 2 (Cue Card): Expected 1.5-2 minutes long turn. Candidate should introduce topic, describe details, give examples, express opinions, provide conclusion.',
      'Part 3: Expected 5-8 sentences. Candidate should explain, justify, compare, analyze, discuss causes, discuss consequences, give examples. Abstract thinking is expected.',
      '',
      '--------------------------------------------------',
      'GENERAL SCORING PRINCIPLES',
      '--------------------------------------------------',
      '- Never reward memorized answers unless they sound natural.',
      '- Never reward difficult vocabulary used incorrectly.',
      '- Do not penalize minor grammar mistakes if communication remains clear.',
      '- Natural communication is more important than perfection.',
      '- Consistency is more important than isolated impressive sentences.',
      '- Always score according to observable evidence only.',
      '',
      '--------------------------------------------------',
      'OUTPUT FORMAT',
      '--------------------------------------------------',
      'Return ONLY a valid JSON object matching this exact schema (do NOT wrap in markdown block, output ONLY this JSON):',
      '{',
      '  "fluency_coherence": 7.0,',
      '  "lexical_resource": 7.5,',
      '  "grammatical_range_accuracy": 6.5,',
      '  "pronunciation": 7.5,',
      '  "average": 7.125,',
      '  "overall_band": 7.0,',
      '  "strengths": ["...", "...", "..."],',
      '  "weaknesses": ["...", "...", "..."],',
      '  "criterion_feedback": {',
      '    "fluency": "...",',
      '    "vocabulary": "...",',
      '    "grammar": "...",',
      '    "pronunciation": "..."',
      '  },',
      '  "overall_feedback": "...",',
      '  "estimated_band_reason": "Explain why the candidate deserves this overall band using evidence from the performance.",',
      '  "questionScores": [',
      '    {',
      '      "questionNumber": 1,',
      '      "question": "question text",',
      '      "answer": "candidate answer transcribed from audio",',
      '      "score": 7.0,',
      '      "feedback": "Feedback for this specific answer"',
      '    }',
      '  ]',
      '}'
    ].join('\n');

    let raw: string;
    if (fileSize <= GEMINI_INLINE_LIMIT_BYTES) {
      raw = await this.geminiInlineRequest(apiKey, filePath, prompt);
    } else {
      this.logger.log(`[Scoring IELTS] File > 20MB, using Gemini File API...`);
      raw = await this.geminiFileApiRequest(apiKey, filePath, prompt);
    }

    return this.parseIeltsGeminiResponse(raw, questions);
  }

  private async geminiInlineRequest(
    apiKey: string,
    filePath: string,
    prompt: string,
  ): Promise<string> {
    const audioData = fs.readFileSync(filePath).toString('base64');

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
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
    const fileSize = fs.statSync(filePath).size;
    const fileName = path.basename(filePath);

    this.logger.log(`[Scoring] Uploading ${fileName} to Gemini File API...`);

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

    const fileUri = initResponse.data?.file?.uri;
    if (!fileUri) throw new Error('No file URI from Gemini File API');

    this.logger.log(`[Scoring] File uploaded: ${fileUri}, waiting for processing...`);
    await this.waitForFileActive(apiKey, fileUri);

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
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
  // Parse response (Standard)
  // ─────────────────────────────────────────────

  private parseGeminiResponse(raw: string, questions: string[]): InterviewEvaluationResult {
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

      const criteria = parsed.criteria ? {
        contentDepthAccuracy: String(parsed.criteria.contentDepthAccuracy || 'Basic'),
        fluencySpeakingFlow: String(parsed.criteria.fluencySpeakingFlow || 'Basic'),
        pronunciationClarity: String(parsed.criteria.pronunciationClarity || 'Basic'),
        grammarVocabulary: String(parsed.criteria.grammarVocabulary || 'Basic'),
        confidence: String(parsed.criteria.confidence || 'Basic'),
      } : {
        contentDepthAccuracy: 'Basic',
        fluencySpeakingFlow: 'Basic',
        pronunciationClarity: 'Basic',
        grammarVocabulary: 'Basic',
        confidence: 'Basic',
      };

      return {
        star,
        starReason,
        questionScores,
        criteria,
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
        criteria: {
          contentDepthAccuracy: 'Basic',
          fluencySpeakingFlow: 'Basic',
          pronunciationClarity: 'Basic',
          grammarVocabulary: 'Basic',
          confidence: 'Basic',
        },
      };
    }
  }

  // ─────────────────────────────────────────────
  // Parse response (IELTS)
  // ─────────────────────────────────────────────

  private parseIeltsGeminiResponse(raw: string, questions: string[]): InterviewEvaluationResult {
    try {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');

      if (start === -1 || end === -1 || end < start) {
        throw new Error('No JSON object found in response');
      }

      const jsonStr = raw.slice(start, end + 1);
      const parsed = JSON.parse(jsonStr);

      const fc = Math.max(0, Math.min(9, Number(parsed.fluency_coherence) || 0));
      const lr = Math.max(0, Math.min(9, Number(parsed.lexical_resource) || 0));
      const gra = Math.max(0, Math.min(9, Number(parsed.grammatical_range_accuracy) || 0));
      const pr = Math.max(0, Math.min(9, Number(parsed.pronunciation) || 0));

      const rawAvg = (fc + lr + gra + pr) / 4;
      const roundedAvg = Math.round(rawAvg * 1000) / 1000;
      const overallBand = roundIeltsBandScore(rawAvg);

      const ieltsData: IeltsEvaluationData = {
        fluency_coherence: fc,
        lexical_resource: lr,
        grammatical_range_accuracy: gra,
        pronunciation: pr,
        average: Number(parsed.average) || roundedAvg,
        overall_band: Number(parsed.overall_band) || overallBand,
        strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
        weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses : [],
        criterion_feedback: {
          fluency: String(parsed.criterion_feedback?.fluency || ''),
          vocabulary: String(parsed.criterion_feedback?.vocabulary || ''),
          grammar: String(parsed.criterion_feedback?.grammar || ''),
          pronunciation: String(parsed.criterion_feedback?.pronunciation || ''),
        },
        overall_feedback: String(parsed.overall_feedback || ''),
        estimated_band_reason: String(parsed.estimated_band_reason || ''),
      };

      const questionScores: QuestionScore[] = Array.isArray(parsed.questionScores)
        ? parsed.questionScores.map((q: any, i: number) => ({
            questionNumber: q.questionNumber || (i + 1),
            question: q.question || questions[i] || `Question ${i + 1}`,
            answer: q.answer || '',
            score: Number(q.score) || overallBand,
            feedback: q.feedback || '',
          }))
        : questions.map((q, i) => ({
            questionNumber: i + 1,
            question: q,
            answer: '',
            score: overallBand,
            feedback: 'Evaluated as part of full IELTS test performance.',
          }));

      // Equivalent star rating mapping for standard components: 9 -> 5, 7-8 -> 4, 5-6 -> 3, 3-4 -> 2, 1-2 -> 1
      const starEquivalent = Math.max(1, Math.min(5, Math.round((overallBand / 9) * 4 + 1)));

      return {
        star: starEquivalent,
        starReason: ieltsData.estimated_band_reason || `IELTS Overall Band: ${overallBand}`,
        questionScores,
        isIelts: true,
        ieltsData,
      };
    } catch (err) {
      this.logger.error(`[Scoring IELTS] Failed to parse Gemini response (${err.message}): ${raw}`);
      return {
        star: 1,
        starReason: 'IELTS Scoring failed — AI response could not be parsed',
        questionScores: questions.map((q, i) => ({
          questionNumber: i + 1,
          question: q,
          answer: '',
          score: 0,
          feedback: 'Scoring failed — AI response could not be parsed',
        })),
        isIelts: true,
        ieltsData: {
          fluency_coherence: 0,
          lexical_resource: 0,
          grammatical_range_accuracy: 0,
          pronunciation: 0,
          average: 0,
          overall_band: 0,
          strengths: [],
          weaknesses: ['Scoring failed — AI response could not be parsed'],
          criterion_feedback: { fluency: '', vocabulary: '', grammar: '', pronunciation: '' },
          overall_feedback: 'Scoring failed — AI response could not be parsed',
          estimated_band_reason: 'Scoring failed — AI response could not be parsed',
        },
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
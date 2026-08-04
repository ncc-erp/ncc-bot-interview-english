import { apiFetch } from "@/lib/apiClient";

export enum TemplateType {
  STANDARD = 1,
  IELTS = 2,
}

export type SectionType = 'STANDARD' | 'IELTS_PART1' | 'IELTS_PART2' | 'IELTS_PART3';

export interface QuestionSection {
  name: string;
  description?: string;
  type?: SectionType;
  questions: string[];
  questionsToSelect: number;
  prepTimeSeconds?: number;
  speakingTimeSeconds?: number;
}

export interface InterviewTemplate {
  id: string;
  name: string;
  type: number; // 1 = STANDARD, 2 = IELTS
  description: string;
  isAiGenerated: boolean;
  systemPrompt: string;
  sampleQuestions: string[];
  numberOfQuestions: number;
  questionSections: QuestionSection[] | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateFormData {
  name: string;
  type: number; // 1 = STANDARD, 2 = IELTS
  description: string;
  isAiGenerated: boolean;
  systemPrompt: string;
  sampleQuestions: string[];
  numberOfQuestions: number;
  questionSections: QuestionSection[] | null;
  isActive: boolean;
}

// ─── API ─────────────────────────────────────────────────────────────────────

export const getTemplates = (): Promise<InterviewTemplate[]> =>
  apiFetch("/admin/templates");

export const getTemplate = (id: string): Promise<InterviewTemplate> =>
  apiFetch(`/admin/templates/${id}`);

export const createTemplate = (data: TemplateFormData): Promise<InterviewTemplate> =>
  apiFetch("/admin/templates", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateTemplate = (id: string, data: Partial<TemplateFormData>): Promise<InterviewTemplate> =>
  apiFetch(`/admin/templates/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });

export const deleteTemplate = (id: string): Promise<{ message: string }> =>
  apiFetch(`/admin/templates/${id}`, { method: "DELETE" });
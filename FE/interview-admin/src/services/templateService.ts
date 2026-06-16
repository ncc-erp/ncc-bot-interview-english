import { apiFetch } from "@/lib/apiClient";

// ─── Types ────────────────────────────────────────────────────────────────────

export type InterviewLevel = "intern" | "fresher" | "junior" | "middle" | "senior" | "lead" | "manager" | "staff";
export type InterviewType = "general" | "technical" | "behavioral" | "situational";

export interface QuestionSection {
  name: string;
  description?: string;
  questions: string[];
  questionsToSelect: number;
}

export interface InterviewTemplate {
  id: string;
  name: string;
  description: string;
  type: InterviewType;
  level: InterviewLevel;
  position: string;
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
  description: string;
  type: InterviewType;
  level: InterviewLevel;
  position: string;
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
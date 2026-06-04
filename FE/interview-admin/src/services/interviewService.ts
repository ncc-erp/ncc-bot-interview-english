// ─── Types (khớp với BE entity) ──────────────────────────────────────────────

export interface SessionUser {
  id: string;
  username: string;
  mezonUserId: string;
  avatarUrl: string | null;
}

export interface SessionTemplate {
  id: string;
  name: string;
  type: string;
  level: string;
  numberOfQuestions: number;
}

export interface OverallFeedback {
  overall: string;
  strengths: string[];
  improvements: string[];
  totalScore: number;
  star?: number;
  starReason?: string;
  criteria?: {
    contentDepthAccuracy: string;
    fluencySpeakingFlow: string;
    pronunciationClarity: string;
    grammarVocabulary: string;
    confidence: string;
  };
  hrStar?: number;
}

export interface QuestionScore {
  questionNumber: number;
  question: string;
  answer: string;
  criteria: {
    relevance: number;
    contentDepth: number;
    fluency: number;
    grammarVocabulary: number;
    structure: number;
  };
  score: number;
  feedback: string;
}

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system";
  type: string;
  content: string;
  questionNumber: number | null;
  audioFilePath: string | null;
  createdAt: string;
}

// Dùng cho danh sách (lightweight)
export interface InterviewListItem {
  id: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  currentQuestionIndex: number;
  startedAt: string;
  completedAt: string | null;
  durationSeconds: number | null;
  roomName: string | null;
  user: SessionUser | null;
  template: SessionTemplate | null;
  overallFeedback: { totalScore: number; star?: number; hrStar?: number } | null;
}

// Dùng cho chi tiết (đầy đủ)
export interface InterviewDetail extends Omit<InterviewListItem, "overallFeedback"> {
  overallFeedback: OverallFeedback | null;
  questionScores: QuestionScore[];
  messages: SessionMessage[];
  audioFile: string | null;
  audioFilePaths: string[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AdminStats {
  total: number;
  completed: number;
  inProgress: number;
  cancelled: number;
}

export interface GetInterviewsParams {
  page?: number;
  limit?: number;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

// ─── API Base ─────────────────────────────────────────────────────────────────

import { apiFetch } from "@/lib/apiClient";

// ─── Exported API functions ───────────────────────────────────────────────────

export const getInterviews = async (
  params: GetInterviewsParams = {}
): Promise<PaginatedResponse<InterviewListItem>> => {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== "" && v !== "all") qs.set(k, String(v));
  });
  const query = qs.toString();
  return apiFetch(`/admin/sessions${query ? `?${query}` : ""}`);
};

export const getInterviewDetail = async (id: string): Promise<InterviewDetail> => {
  return apiFetch(`/admin/sessions/${id}`);
};

export const reEvaluateInterview = async (id: string): Promise<InterviewDetail> => {
  return apiFetch(`/admin/sessions/${id}/re-evaluate`, {
    method: "POST",
  });
};

export const updateHrStar = async (id: string, rating: number): Promise<OverallFeedback> => {
  return apiFetch(`/admin/sessions/${id}/hr-rating`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating }),
  });
};

export const getStats = async (): Promise<AdminStats> => {
  return apiFetch("/admin/stats");
};
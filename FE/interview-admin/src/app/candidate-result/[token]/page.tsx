"use client";

import { useEffect, useState } from "react";
import {
  Card, Descriptions, Tag, Typography, Divider, Space, Tabs, Spin, Alert, Rate
} from "antd";
import { useParams } from "next/navigation";
import { getCandidateResult, type InterviewDetail } from "@/services/interviewService";

const { Text, Title } = Typography;

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  finished_session: { label: "Finished", color: "green" },
  completed: { label: "Completed", color: "green" },
  in_progress: { label: "In Progress", color: "orange" },
  pending: { label: "Pending", color: "blue" },
  cancelled: { label: "Cancelled", color: "red" },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleString("vi-VN", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtDuration(seconds: number | null): string {
  if (!seconds) return "--";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function getCriteriaColor(val: string): string {
  const clean = val.toLowerCase().trim();
  if (clean.includes("excellent")) return "green";
  if (clean.includes("very good")) return "cyan";
  if (clean.includes("good")) return "blue";
  if (clean.includes("satisfactory")) return "orange";
  if (clean.includes("needs improvement") || clean.includes("improvement")) return "red";
  return "default";
}

export default function CandidateResultPage() {
  const params = useParams();
  const token = params.token as string;

  const [data, setData] = useState<InterviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    getCandidateResult(token)
      .then(setData)
      .catch((e: any) => setError(e.message || "Failed to load interview results"))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 100 }}>
        <Spin size="large" tip="Loading results..." />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ maxWidth: 800, margin: "40px auto", padding: "0 16px" }}>
        <Alert type="error" message={error || "Interview results not found"} showIcon />
      </div>
    );
  }

  const statusCfg = STATUS_MAP[data.status] ?? { label: data.status, color: "default" };

  return (
    <div style={{ maxWidth: 900, margin: "30px auto", padding: "0 16px" }}>
      {/* Banner / Header */}
      <div style={{ marginBottom: 24, textAlign: "center" }}>
        <Title level={2} style={{ margin: 0 }}>English Interview Result</Title>
        <Text type="secondary">Thank you for completing your English interview session</Text>
      </div>

      {/* General Info */}
      <Card style={{ marginBottom: 16 }} title="Session Overview">
        <Descriptions column={2} size="small" bordered>
          <Descriptions.Item label="Candidate">
            <strong>{data.user?.username ?? "--"}</strong>
          </Descriptions.Item>
          <Descriptions.Item label="Status">
            <Tag color={statusCfg.color}>{statusCfg.label}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Template">
            {data.template?.name ?? "--"}
          </Descriptions.Item>
          <Descriptions.Item label="Started At">
            {fmtDate(data.startedAt)}
          </Descriptions.Item>
          <Descriptions.Item label="Ended At">
            {fmtDate(data.completedAt)}
          </Descriptions.Item>
          <Descriptions.Item label="Duration">
            {fmtDuration(data.durationSeconds)}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* Overall Feedback */}
      {data.overallFeedback && (
        <Card style={{ marginBottom: 16 }} title="Evaluation & Feedback">
          <div style={{ marginBottom: 16, display: "flex", flexFlow: "row wrap", gap: "16px 24px", alignItems: "flex-start" }}>
            <div style={{ flex: "0 0 auto", minWidth: 140 }}>
              <Text strong>Rating Score: </Text>
              <Text
                strong
                style={{
                  fontSize: 22,
                  color: (data.overallFeedback.star ?? 0) >= 4
                    ? "#52c41a"
                    : (data.overallFeedback.star ?? 0) >= 3
                      ? "#faad14"
                      : "#ff4d4f",
                }}
              >
                {data.overallFeedback.star ?? "Pending"}
              </Text>
              {(data.overallFeedback.star !== undefined && data.overallFeedback.star !== null) && (
                <Text style={{ fontSize: 14, color: "#888" }}>/5</Text>
              )}
            </div>

            {data.overallFeedback.star !== undefined && data.overallFeedback.star !== null && (
              <div style={{ flex: "1 1 300px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Text strong>Star Rating: </Text>
                  <Rate disabled allowHalf value={data.overallFeedback.star} />
                </div>
                {data.overallFeedback.starReason && (
                  <div style={{ marginTop: 4 }}>
                    <Text type="secondary" style={{ fontSize: 13, fontStyle: "italic" }}>
                      {data.overallFeedback.starReason}
                    </Text>
                  </div>
                )}
              </div>
            )}
          </div>

          {data.overallFeedback.criteria && (
            <div style={{ marginBottom: 16, padding: "12px 16px", border: "1px solid #f0f0f0", borderRadius: 8, background: "#fafafa" }}>
              <Text strong style={{ display: "block", marginBottom: 10, fontSize: 13 }}>Overall Communication Criteria:</Text>
              <Space wrap size={[8, 12]}>
                <Tag color={getCriteriaColor(data.overallFeedback.criteria.contentDepthAccuracy)}>
                  Content Depth & Accuracy: <strong>{data.overallFeedback.criteria.contentDepthAccuracy}</strong>
                </Tag>
                <Tag color={getCriteriaColor(data.overallFeedback.criteria.fluencySpeakingFlow)}>
                  Fluency & Speaking Flow: <strong>{data.overallFeedback.criteria.fluencySpeakingFlow}</strong>
                </Tag>
                <Tag color={getCriteriaColor(data.overallFeedback.criteria.pronunciationClarity)}>
                  Pronunciation & Clarity: <strong>{data.overallFeedback.criteria.pronunciationClarity}</strong>
                </Tag>
                <Tag color={getCriteriaColor(data.overallFeedback.criteria.grammarVocabulary)}>
                  Grammar & Vocabulary: <strong>{data.overallFeedback.criteria.grammarVocabulary}</strong>
                </Tag>
                <Tag color={getCriteriaColor(data.overallFeedback.criteria.confidence)}>
                  Confidence: <strong>{data.overallFeedback.criteria.confidence}</strong>
                </Tag>
              </Space>
            </div>
          )}

          {data.overallFeedback.overall && (
            <div style={{ marginBottom: 16, padding: "10px 12px", background: "#f0f8ff", borderRadius: 6, fontSize: 13 }}>
              {data.overallFeedback.overall}
            </div>
          )}

          <div style={{ display: "flex", gap: 24 }}>
            {data.overallFeedback.strengths && data.overallFeedback.strengths.length > 0 && (
              <div style={{ flex: 1 }}>
                <Text strong style={{ color: "#52c41a" }}>💪 Strengths</Text>
                <ul style={{ paddingLeft: 18, marginTop: 8, fontSize: 13 }}>
                  {data.overallFeedback.strengths.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            {data.overallFeedback.improvements && data.overallFeedback.improvements.length > 0 && (
              <div style={{ flex: 1 }}>
                <Text strong style={{ color: "#fa8c16" }}>🎯 Areas to Improve</Text>
                <ul style={{ paddingLeft: 18, marginTop: 8, fontSize: 13 }}>
                  {data.overallFeedback.improvements.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Audio */}
      {data.audioFile && data.audioFile !== "_Failed_" && (
        <Card style={{ marginBottom: 16 }} title="🎧 Recorded Audio">
          <audio controls src={data.audioFile} style={{ width: "100%" }} />
        </Card>
      )}

      {/* Transcript & Scores */}
      <Card title="Detailed Evaluation">
        <Tabs
          size="small"
          items={[
            {
              key: "transcript",
              label: `💬 Transcript (${data.messages?.length ?? 0})`,
              children: (
                <div style={{ maxHeight: 500, overflowY: "auto", padding: "4px 0" }}>
                  {!data.messages?.length ? (
                    <Text type="secondary">No conversation content yet</Text>
                  ) : (
                    data.messages.map((msg, i) => {
                      const isUser = msg.role === "user";
                      return (
                        <div
                          key={i}
                          style={{
                            display: "flex",
                            justifyContent: isUser ? "flex-end" : "flex-start",
                            marginBottom: 12,
                          }}
                        >
                          <div
                            style={{
                              maxWidth: "75%",
                              background: isUser ? "#1677ff" : "#f5f5f5",
                              color: isUser ? "#fff" : "#000",
                              padding: "8px 12px",
                              borderRadius: 8,
                              fontSize: 13,
                              lineHeight: 1.6,
                            }}
                          >
                            {msg.questionNumber && (
                              <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 4 }}>
                                Question {msg.questionNumber}
                              </div>
                            )}
                            <div>{msg.content}</div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              ),
            },
            {
              key: "questions",
              label: `📝 Question-by-Question Scores (${data.questionScores?.length ?? 0})`,
              children: (
                <div>
                  {!data.questionScores?.length ? (
                    <Text type="secondary">Evaluation is in progress or not available</Text>
                  ) : (
                    data.questionScores.map((qs, i) => (
                      <Card
                        key={i}
                        size="small"
                        style={{ marginBottom: 12, border: "1px solid #f0f0f0" }}
                        title={
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span>Question {qs.questionNumber}</span>
                            <Tag color={qs.score >= 8 ? "green" : qs.score >= 5 ? "orange" : "red"}>
                              Score: {qs.score}/10
                            </Tag>
                          </div>
                        }
                      >
                        <div style={{ marginBottom: 8 }}>
                          <strong>Q:</strong> {qs.question}
                        </div>
                        <div style={{ marginBottom: 12, padding: "6px 10px", background: "#f9f9f9", borderRadius: 4 }}>
                          <strong>A:</strong> {qs.answer}
                        </div>
                        {qs.criteria && (
                          <div style={{ marginBottom: 8 }}>
                            <Space wrap size={[4, 8]}>
                              <Tag color="blue">Relevance: {qs.criteria.relevance}/3</Tag>
                              <Tag color="cyan">Content Depth: {qs.criteria.contentDepth}/2.5</Tag>
                              <Tag color="purple">Fluency: {qs.criteria.fluency}/2</Tag>
                              <Tag color="geekblue">Grammar/Vocab: {qs.criteria.grammarVocabulary}/1.5</Tag>
                              <Tag color="magenta">Structure: {qs.criteria.structure}/1</Tag>
                            </Space>
                          </div>
                        )}
                        <div>
                          <strong>Feedback:</strong> {qs.feedback}
                        </div>
                      </Card>
                    ))
                  )}
                </div>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}

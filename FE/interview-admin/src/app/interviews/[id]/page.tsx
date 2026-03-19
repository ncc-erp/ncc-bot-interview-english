"use client";

import { useEffect, useState } from "react";
import {
  Card, Descriptions, Tag, Progress, Collapse, Typography,
  Divider, Space, Tabs, Button, Spin, Alert,
} from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { useRouter, useParams } from "next/navigation";
import { getInterviewDetail, type InterviewDetail } from "@/services/interviewService";

const { Text } = Typography;
const { Panel } = Collapse;

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  completed:   { label: "Completed",   color: "green" },
  in_progress: { label: "In Progress", color: "orange" },
  pending:     { label: "Pending",     color: "blue" },
  cancelled:   { label: "Cancelled",   color: "red" },
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

export default function InterviewDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [data, setData] = useState<InterviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    getInterviewDetail(id)
      .then(setData)
      .catch((e: any) => setError(e.message || "Failed to load interview detail"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.back()} style={{ marginBottom: 20 }}>
          Back
        </Button>
        <Alert type="error" message={error || "Interview not found"} />
      </div>
    );
  }

  const statusCfg = STATUS_MAP[data.status] ?? { label: data.status, color: "default" };

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => router.back()} style={{ marginBottom: 16 }}>
          Back to List
        </Button>
        <h1 style={{ fontSize: 24, margin: 0 }}>Interview Detail</h1>
      </div>

      {/* General Info */}
      <Card style={{ marginBottom: 16 }}>
        <Descriptions column={2} size="small" bordered>
          <Descriptions.Item label="Candidate">
            <strong>{data.user?.username ?? "--"}</strong>
            <div style={{ fontSize: 12, color: "#888" }}>{data.user?.mezonUserId}</div>
          </Descriptions.Item>
          <Descriptions.Item label="Room Name">
            {(data as any).roomName || "--"}
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
        <Card style={{ marginBottom: 16 }}>
          <Divider plain style={{ marginTop: 0 }}>Results</Divider>

          <div style={{ marginBottom: 16 }}>
            <Text strong>Total Score: </Text>
            <Text
              strong
              style={{
                fontSize: 22,
                color: data.overallFeedback.totalScore >= 8
                  ? "#52c41a"
                  : data.overallFeedback.totalScore >= 6
                  ? "#faad14"
                  : "#ff4d4f",
              }}
            >
              {data.overallFeedback.totalScore}
            </Text>
            <Text style={{ fontSize: 14, color: "#888" }}>/10</Text>
          </div>

          {data.overallFeedback.overall && (
            <div style={{ marginBottom: 16, padding: "10px 12px", background: "#f0f8ff", borderRadius: 6, fontSize: 13 }}>
              {data.overallFeedback.overall}
            </div>
          )}

          <div style={{ display: "flex", gap: 24 }}>
            {data.overallFeedback.strengths?.length > 0 && (
              <div style={{ flex: 1 }}>
                <Text strong style={{ color: "#52c41a" }}>💪 Strengths</Text>
                <ul style={{ paddingLeft: 18, marginTop: 8, fontSize: 13 }}>
                  {data.overallFeedback.strengths.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            {data.overallFeedback.improvements?.length > 0 && (
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
      {data.audioFile && (
        <Card style={{ marginBottom: 16 }}>
          <Divider plain style={{ marginTop: 0 }}>🎧 Recording</Divider>
          <audio controls src={data.audioFile} style={{ width: "100%" }} />
        </Card>
      )}

      {/* Transcript & Scores */}
      <Card>
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
                              <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>
                                Question {msg.questionNumber}
                              </div>
                            )}
                            {msg.content}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              ),
            },
            {
              key: "scores",
              label: `📊 Question Scores (${data.questionScores?.length ?? 0})`,
              children: (
                <div>
                  {!data.questionScores?.length ? (
                    <Text type="secondary">No scoring data available</Text>
                  ) : (
                    <Collapse size="small" ghost>
                      {data.questionScores.map((q) => (
                        <Panel
                          key={q.questionNumber}
                          header={
                            <Space>
                              <Tag color="blue">Q{q.questionNumber}</Tag>
                              <span style={{ fontSize: 13 }}>{q.question}</span>
                              <Tag color={q.score >= 8 ? "green" : q.score >= 6 ? "orange" : "red"}>
                                {q.score}/10
                              </Tag>
                            </Space>
                          }
                        >
                          <Descriptions column={1} size="small" bordered>
                            <Descriptions.Item label="Answer">
                              {q.answer || <Text type="secondary">N/A</Text>}
                            </Descriptions.Item>
                            <Descriptions.Item label="Feedback">{q.feedback}</Descriptions.Item>
                            {q.criteria && (
                              <Descriptions.Item label="Score Breakdown">
                                <Space direction="vertical" style={{ width: "100%" }}>
                                  {(
                                    [
                                      ["Relevance", q.criteria.relevance, 3],
                                      ["Content Depth", q.criteria.contentDepth, 2.5],
                                      ["Fluency", q.criteria.fluency, 2],
                                      ["Grammar & Vocabulary", q.criteria.grammarVocabulary, 1.5],
                                      ["Structure", q.criteria.structure, 1],
                                    ] as [string, number, number][]
                                  ).map(([label, val, max]) => (
                                    <div key={label}>
                                      <div style={{ fontSize: 12, color: "#888", marginBottom: 2 }}>
                                        {label}: {val}/{max}
                                      </div>
                                      <Progress
                                        percent={Math.round((val / max) * 100)}
                                        size="small"
                                        showInfo={false}
                                      />
                                    </div>
                                  ))}
                                </Space>
                              </Descriptions.Item>
                            )}
                          </Descriptions>
                        </Panel>
                      ))}
                    </Collapse>
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
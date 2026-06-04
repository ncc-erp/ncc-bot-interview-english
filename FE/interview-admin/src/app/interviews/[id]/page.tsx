"use client";

import { useEffect, useState } from "react";
import {
  Card, Descriptions, Tag, Progress, Collapse, Typography,
  Divider, Space, Tabs, Button, Spin, Alert, Rate, Popconfirm, message,
} from "antd";
import { ArrowLeftOutlined, ReloadOutlined } from "@ant-design/icons";
import { useRouter, useParams } from "next/navigation";
import { getInterviewDetail, reEvaluateInterview, updateHrStar, type InterviewDetail } from "@/services/interviewService";

const { Text } = Typography;
const { Panel } = Collapse;

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  finished_session: { label: "Finished Session", color: "green" },
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

export default function InterviewDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;

  const [data, setData] = useState<InterviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reEvaluating, setReEvaluating] = useState(false);
  const [updatingHrStar, setUpdatingHrStar] = useState(false);

  const handleReEvaluate = async () => {
    if (!id) return;
    setReEvaluating(true);
    try {
      const updated = await reEvaluateInterview(id);
      setData(updated);
      message.success("Interview re-evaluation completed successfully!");
    } catch (e: any) {
      message.error((e.message || "Failed to re-evaluate interview") + ". Please try again later.");
    } finally {
      setReEvaluating(false);
    }
  };

  const handleHrStarChange = async (rating: number) => {
    if (!id) return;
    const currentRating = data?.overallFeedback?.hrStar || 0;
    if (rating === currentRating || rating === 0) {
      return;
    }
    setUpdatingHrStar(true);
    try {
      const updatedFeedback = await updateHrStar(id, rating);
      setData(prev => prev ? {
        ...prev,
        overallFeedback: updatedFeedback
      } : null);
      message.success("HR Rating updated successfully!");
    } catch (e: any) {
      message.error(e.message || "Failed to update HR rating");
    } finally {
      setUpdatingHrStar(false);
    }
  };

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
        <a
          onClick={() => router.back()}
          style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 16 }}
        >
          ← Back to List
        </a>
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
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontWeight: 600, fontSize: 16 }}>Results</span>
            {data.audioFile && (
              <Popconfirm
                title="Re-evaluate Session"
                description="Are you sure you want to re-evaluate this session? This will call AI and overwrite the existing scores."
                onConfirm={handleReEvaluate}
                okText="Yes, Re-evaluate"
                cancelText="No"
                disabled={reEvaluating}
              >
                <Button
                  size="small"
                  type="primary"
                  danger
                  ghost
                  icon={<ReloadOutlined />}
                  loading={reEvaluating}
                >
                  Re-evaluate
                </Button>
              </Popconfirm>
            )}
          </div>
          <Divider style={{ marginTop: 8, marginBottom: 16 }} />

          <div style={{ marginBottom: 16, display: "flex", flexFlow: "row wrap", gap: "16px 24px", alignItems: "flex-start" }}>
            <div style={{ flex: "0 0 auto", minWidth: 140 }}>
              <Text strong>Total Score: </Text>
              <Text
                strong
                style={{
                  fontSize: 22,
                  color: (data.overallFeedback.star ?? data.overallFeedback.hrStar ?? 0) >= 4
                    ? "#52c41a"
                    : (data.overallFeedback.star ?? data.overallFeedback.hrStar ?? 0) >= 3
                      ? "#faad14"
                      : "#ff4d4f",
                }}
              >
                {data.overallFeedback.star ?? data.overallFeedback.hrStar ?? "Pending"}
              </Text>
              {data.overallFeedback.star !== undefined && data.overallFeedback.star !== null
                || data.overallFeedback.hrStar !== undefined && data.overallFeedback.hrStar !== null && (
                  <Text style={{ fontSize: 14, color: "#888" }}>/5</Text>
                )}
            </div>

            <div style={{ display: "flex", flexFlow: "row wrap", gap: "16px 24px", flex: "1 1 300px" }}>
              {data.overallFeedback.star !== undefined && data.overallFeedback.star !== null && (
                <div style={{ flex: "1 1 65%", minWidth: 240 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Text strong>Bot Star Rating: </Text>
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

              <div style={{ flex: "1 1 30%", minWidth: 200, marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Text strong>HR Star Rating: </Text>
                  <Rate
                    allowClear={false}
                    allowHalf
                    disabled={updatingHrStar}
                    value={data.overallFeedback.hrStar || 0}
                    onChange={handleHrStarChange}
                  />
                  {updatingHrStar && <Spin size="small" />}
                </div>
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary" style={{ fontSize: 13, fontStyle: "italic" }}>
                    Recorded HR evaluation rating
                  </Text>
                </div>
              </div>
            </div>
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
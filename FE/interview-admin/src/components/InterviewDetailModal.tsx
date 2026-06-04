"use client";

import { Modal, Descriptions, Tag, Progress, Collapse, Typography, Divider, Space, Tabs } from "antd";
import type { InterviewDetail } from "@/services/interviewService";

const { Text } = Typography;
const { Panel } = Collapse;

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  finished_session: { label: "Finished Session", color: "green" },
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

interface Props {
  open: boolean;
  data: InterviewDetail | null;
  loading: boolean;
  onClose: () => void;
}

export default function InterviewDetailModal({ open, data, loading, onClose }: Props) {
  const statusCfg = data ? (STATUS_MAP[data.status] ?? { label: data.status, color: "default" }) : null;

  const transcriptTab = (
    <div style={{ maxHeight: 360, overflowY: "auto", padding: "4px 0" }}>
      {!data?.messages?.length ? (
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
  );

  const scoresTab = (
    <div>
      {!data?.questionScores?.length ? (
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
                      {[
                        ["Relevance",  q.criteria.relevance,         3],
                        ["Content Depth", q.criteria.contentDepth,   2.5],
                        ["Fluency",    q.criteria.fluency,           2],
                        ["Grammar & Vocabulary", q.criteria.grammarVocabulary, 1.5],
                        ["Structure",  q.criteria.structure,         1],
                      ].map(([label, val, max]) => (
                        <div key={label as string}>
                          <div style={{ fontSize: 12, color: "#888", marginBottom: 2 }}>
                            {label as string}: {val as number}/{max as number}
                          </div>
                          <Progress
                            percent={Math.round(((val as number) / (max as number)) * 100)}
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
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title="Interview Detail"
      width={760}
      loading={loading}
    >
      {data && (
        <>
          {/* Thông tin chung */}
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="Candidate">
              <strong>{data.user?.username ?? "--"}</strong>
              <div style={{ fontSize: 12, color: "#888" }}>{data.user?.mezonUserId}</div>
            </Descriptions.Item>
            <Descriptions.Item label="Room">
              {data.roomName ?? "--"}
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              {statusCfg && <Tag color={statusCfg.color}>{statusCfg.label}</Tag>}
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

          {/* Điểm tổng */}
          {data.overallFeedback && (
            <>
              <Divider plain style={{ marginTop: 16, marginBottom: 12 }}>
                Results
              </Divider>
              <div style={{ marginBottom: 12 }}>
                <div style={{ marginBottom: 6 }}>
                  <Text strong>Total Score: </Text>
                  <Text strong style={{ fontSize: 22, color: (data.overallFeedback.star ?? 0) >= 4 ? "#52c41a" : (data.overallFeedback.star ?? 0) >= 3 ? "#faad14" : "#ff4d4f" }}>
                    {data.overallFeedback.star ?? "Pending"}
                  </Text>
                  <Text style={{ fontSize: 14, color: "#888" }}>/5</Text>
                </div>
              </div>
              {data.overallFeedback.overall && (
                <div style={{ marginBottom: 10, padding: "10px 12px", background: "#f0f8ff", borderRadius: 6, fontSize: 13 }}>
                  {data.overallFeedback.overall}
                </div>
              )}
              <div style={{ display: "flex", gap: 16 }}>
                {data.overallFeedback.strengths?.length > 0 && (
                  <div style={{ flex: 1 }}>
                    <Text strong style={{ color: "#52c41a" }}>💪 Strengths</Text>
                    <ul style={{ paddingLeft: 18, marginTop: 6, fontSize: 13 }}>
                      {data.overallFeedback.strengths.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                )}
                {data.overallFeedback.improvements?.length > 0 && (
                  <div style={{ flex: 1 }}>
                    <Text strong style={{ color: "#fa8c16" }}>🎯 Areas to Improve</Text>
                    <ul style={{ paddingLeft: 18, marginTop: 6, fontSize: 13 }}>
                      {data.overallFeedback.improvements.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Audio */}
          {data.audioFile && data.audioFile !== "_Failed_" && (
            <>
              <Divider plain style={{ marginTop: 16, marginBottom: 12 }}>
                🎧 Recording
              </Divider>
              <audio controls src={data.audioFile} style={{ width: "100%" }} />
            </>
          )}

          {/* Transcript & Scores tabs */}
          <Divider plain style={{ marginTop: 16, marginBottom: 0 }} />
          <Tabs
            size="small"
            style={{ marginTop: 4 }}
            items={[
              {
                key: "transcript",
                label: `💬 Transcript (${data.messages?.length ?? 0})`,
                children: transcriptTab,
              },
              {
                key: "scores",
                label: `📊 Question Scores (${data.questionScores?.length ?? 0})`,
                children: scoresTab,
              },
            ]}
          />
        </>
      )}
    </Modal>
  );
}
"use client";

import { Table, Button, Tag } from "antd";
import type { InterviewListItem } from "@/services/interviewService";

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  finished_session: { label: "Finished Session", color: "green" },
  completed: { label: "Completed", color: "green" },
  in_progress: { label: "In Progress", color: "orange" },
  pending: { label: "Pending", color: "blue" },
  cancelled: { label: "Cancelled", color: "red" },
};

function fmtDuration(seconds: number | null): string {
  if (!seconds) return "--";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleString("vi-VN", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

interface Props {
  data: InterviewListItem[];
  loading: boolean;
  onView: (record: InterviewListItem) => void;
  pagination: {
    current: number;
    pageSize: number;
    total: number;
    onChange: (page: number) => void;
  };
}

export default function InterviewTable({ data, loading, onView, pagination }: Props) {
  const columns = [
    {
      title: "Room Name",
      dataIndex: "roomName",
      render: (_: any, record: InterviewListItem) => (
        <span style={{ fontSize: 13 }}>{record.roomName || "--"}</span>
      ),
    },
    {
      title: "Candidate",
      dataIndex: "user",
      render: (_: any, record: InterviewListItem) => (
        <div>
          <div style={{ fontWeight: 600 }}>{record.user?.username ?? "--"}</div>
          <div style={{ fontSize: 12, color: "#888" }}>{record.user?.mezonUserId ?? ""}</div>
        </div>
      ),
    },
    {
      title: "Template",
      dataIndex: "template",
      render: (_: any, record: InterviewListItem) => (
        <div>
          <div style={{ fontWeight: 500 }}>{record.template?.name ?? "--"}</div>
        </div>
      ),
    },
    {
      title: "Status",
      dataIndex: "status",
      render: (status: string) => {
        const cfg = STATUS_MAP[status] ?? { label: status, color: "default" };
        return <Tag color={cfg.color}>{cfg.label}</Tag>;
      },
    },
    {
      title: "Total Score",
      dataIndex: "overallFeedback",
      render: (_: any, record: InterviewListItem) => {
        const score = record.overallFeedback?.star ?? record.overallFeedback?.hrStar ?? "--";
        if (score == null) return <span style={{ color: "#bbb" }}>--</span>;
        const color = score >= 4 ? "#52c41a" : score >= 3 ? "#faad14" : "#ff4d4f";
        return (
          <span style={{ fontWeight: 700, fontSize: 15, color }}>
            {score}<span style={{ fontWeight: 400, fontSize: 12, color: "#888" }}>/5</span>
          </span>
        );
      },
    },
    {
      title: "Started At",
      dataIndex: "startedAt",
      render: (v: string) => fmtDate(v),
    },
    {
      title: "Duration",
      dataIndex: "durationSeconds",
      render: (v: number | null) => fmtDuration(v),
    },
    {
      title: "Action",
      render: (_: any, record: InterviewListItem) => (
        <a onClick={() => onView(record)} style={{ cursor: "pointer" }}>
          View Details
        </a>
      ),
    },
  ];

  return (
    <Table
      rowKey="id"
      columns={columns}
      dataSource={data}
      loading={loading}
      pagination={{
        current: pagination.current,
        pageSize: pagination.pageSize,
        total: pagination.total,
        onChange: pagination.onChange,
        showSizeChanger: false,
        showTotal: (total) => `Total ${total} interviews`,
      }}
    />
  );
}
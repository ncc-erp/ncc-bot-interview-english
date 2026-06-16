"use client";

import { useEffect, useState } from "react";
import {
  Card, Table, Tag, Button, Space, Switch, Popconfirm,
  Alert, Tooltip, Badge,
} from "antd";
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import {
  getTemplates, deleteTemplate,
  type InterviewTemplate,
} from "@/services/templateService";

const LEVEL_COLOR: Record<string, string> = {
  intern:       "blue",
  fresher:      "cyan",
  junior:       "green",
  middle:       "geekblue",
  senior:       "purple",
  lead:         "magenta",
  manager:      "red",
  staff:        "orange",
};

const TYPE_COLOR: Record<string, string> = {
  general:     "default",
  technical:   "cyan",
  behavioral:  "green",
  situational: "volcano",
};

export default function TemplateListPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<InterviewTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchTemplates = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getTemplates();
      setTemplates(data);
    } catch (e: any) {
      setError(e.message || "Failed to load templates");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTemplates(); }, []);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteTemplate(id);
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (e: any) {
      setError(e.message || "Failed to delete template");
    } finally {
      setDeletingId(null);
    }
  };

  const columns = [
    {
      title: "Name",
      dataIndex: "name",
      render: (name: string, record: InterviewTemplate) => (
        <div>
          <div style={{ fontWeight: 600 }}>{name}</div>
          <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>
            {record.description?.slice(0, 60)}{record.description?.length > 60 ? "…" : ""}
          </div>
        </div>
      ),
    },
    {
      title: "Position",
      dataIndex: "position",
      width: 120,
      render: (position: string) => (
        <Tag color="blue" style={{ fontWeight: 500 }}>{position || "General"}</Tag>
      ),
      filters: Array.from(new Set(templates.map(t => t.position || "General"))).map(p => ({ text: p, value: p })),
      onFilter: (value: any, record: InterviewTemplate) => (record.position || "General") === value,
    },
    {
      title: "Type",
      dataIndex: "type",
      width: 120,
      render: (type: string) => (
        <Tag color={TYPE_COLOR[type] ?? "default"} style={{ textTransform: "capitalize" }}>
          {type}
        </Tag>
      ),
      filters: [
        { text: "General", value: "general" },
        { text: "Technical", value: "technical" },
        { text: "Behavioral", value: "behavioral" },
        { text: "Situational", value: "situational" },
      ],
      onFilter: (value: any, record: InterviewTemplate) => record.type === value,
    },
    {
      title: "Level",
      dataIndex: "level",
      width: 120,
      render: (level: string) => (
        <Tag color={LEVEL_COLOR[level] ?? "default"} style={{ textTransform: "capitalize" }}>
          {level}
        </Tag>
      ),
      filters: [
        { text: "Intern", value: "intern" },
        { text: "Fresher", value: "fresher" },
        { text: "Junior", value: "junior" },
        { text: "Middle", value: "middle" },
        { text: "Senior", value: "senior" },
        { text: "Lead", value: "lead" },
        { text: "Manager", value: "manager" },
        { text: "Staff", value: "staff" },
      ],
      onFilter: (value: any, record: InterviewTemplate) => record.level === value,
    },
    {
      title: "Mode",
      dataIndex: "isAiGenerated",
      width: 120,
      align: "center" as const,
      render: (isAiGenerated: boolean) => (
        <Tag color={isAiGenerated !== false ? "purple" : "default"}>
          {isAiGenerated !== false ? "AI Generated" : "Predefined"}
        </Tag>
      ),
      filters: [
        { text: "AI Generated", value: true },
        { text: "Predefined", value: false },
      ],
      onFilter: (value: any, record: InterviewTemplate) => (record.isAiGenerated !== false) === value,
    },
    {
      title: "Questions",
      dataIndex: "numberOfQuestions",
      width: 100,
      align: "center" as const,
      render: (n: number, record: InterviewTemplate) => (
        <Tooltip title={record.questionSections ? `${record.questionSections.length} sections` : "Sample questions"}>
          <Badge
            count={n}
            style={{ backgroundColor: record.questionSections ? "#722ed1" : "#1677ff" }}
            showZero
          />
        </Tooltip>
      ),
    },
    {
      title: "Sections",
      width: 90,
      align: "center" as const,
      render: (_: any, record: InterviewTemplate) =>
        record.questionSections?.length
          ? <Tag color="purple">{record.questionSections.length} sections</Tag>
          : <span style={{ color: "#bbb", fontSize: 12 }}>—</span>,
    },
    {
      title: "Status",
      dataIndex: "isActive",
      width: 90,
      align: "center" as const,
      render: (isActive: boolean) => (
        <Tag color={isActive ? "green" : "red"}>{isActive ? "Active" : "Inactive"}</Tag>
      ),
    },
    {
      title: "Action",
      width: 120,
      render: (_: any, record: InterviewTemplate) => (
        <Space>
          <Tooltip title="Edit">
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => router.push(`/templates/${record.id}/edit`)}
            />
          </Tooltip>
          <Popconfirm
            title="Delete this template?"
            description="This action cannot be undone."
            okText="Delete"
            okButtonProps={{ danger: true }}
            cancelText="Cancel"
            onConfirm={() => handleDelete(record.id)}
          >
            <Tooltip title="Delete">
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                loading={deletingId === record.id}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 26, margin: 0 }}>Interview Templates</h1>
          <div style={{ color: "#888", marginTop: 4 }}>Manage interview templates</div>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => router.push("/templates/create")}
        >
          New Template
        </Button>
      </div>

      {error && (
        <Alert
          type="error"
          message={error}
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 16 }}
        />
      )}

      <Card>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={templates}
          loading={loading}
          pagination={{ pageSize: 10, showTotal: (t) => `Total ${t} templates` }}
        />
      </Card>
    </div>
  );
}
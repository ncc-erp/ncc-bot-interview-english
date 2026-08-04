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
      title: "Type",
      dataIndex: "type",
      width: 130,
      align: "center" as const,
      render: (type: number) => (
        <Tag color={type === 2 ? "gold" : "blue"}>
          {type === 2 ? "IELTS Speaking" : "Standard"}
        </Tag>
      ),
      filters: [
        { text: "Standard", value: 1 },
        { text: "IELTS Speaking", value: 2 },
      ],
      onFilter: (value: any, record: InterviewTemplate) => (record.type ?? 1) === value,
    },
    {
      title: "Mode",
      dataIndex: "isAiGenerated",
      width: 120,
      align: "center" as const,
      render: (isAiGenerated: boolean) => (
        <Tag color={isAiGenerated !== false ? "purple" : "orange"}>
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
"use client";

import { useEffect, useState } from "react";
import {
  Card, Form, Input, Select, InputNumber, Button, Space,
  Divider, Collapse, Tag, Alert, Spin, Tooltip, Switch,
  Tabs,
} from "antd";
import {
  ArrowLeftOutlined, PlusOutlined, DeleteOutlined,
  HolderOutlined, QuestionCircleOutlined,
} from "@ant-design/icons";
import { useRouter, useParams } from "next/navigation";
import {
  getTemplate, createTemplate, updateTemplate,
  type TemplateFormData, type QuestionSection,
} from "@/services/templateService";

const { TextArea } = Input;
const { Option } = Select;
const { Panel } = Collapse;

// ─── Question Section Editor ──────────────────────────────────────────────────

function SectionEditor({
  section,
  index,
  onChange,
  onRemove,
}: {
  section: QuestionSection;
  index: number;
  onChange: (updated: QuestionSection) => void;
  onRemove: () => void;
}) {
  const update = (patch: Partial<QuestionSection>) =>
    onChange({ ...section, ...patch });

  const addQuestion = () =>
    update({ questions: [...section.questions, ""] });

  const updateQuestion = (qi: number, val: string) => {
    const questions = [...section.questions];
    questions[qi] = val;
    update({ questions });
  };

  const removeQuestion = (qi: number) =>
    update({ questions: section.questions.filter((_, i) => i !== qi) });

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
      <span style={{ fontWeight: 600, color: "#1677ff" }}>
        Section {index + 1}
      </span>
      {section.name && (
        <span style={{ color: "#333", fontWeight: 500 }}>{section.name}</span>
      )}
      <Tag color="purple" style={{ marginLeft: "auto" }}>
        {section.questions.length} questions · Select {section.questionsToSelect}
      </Tag>
    </div>
  );

  return (
    <Card
      size="small"
      style={{ marginBottom: 12, border: "1px solid #d9d9d9" }}
      styles={{ body: { padding: "12px 16px" } }}
      title={header}
      extra={
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
        >
          Remove
        </Button>
      }
    >
      {/* Section meta */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, marginBottom: 12 }}>
        <Form.Item label="Section Name" style={{ margin: 0 }} required>
          <Input
            value={section.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="e.g. I. Personal Information"
          />
        </Form.Item>
        <Form.Item label="Description" style={{ margin: 0 }}>
          <Input
            value={section.description ?? ""}
            onChange={(e) => update({ description: e.target.value })}
            placeholder="Short description of this section"
          />
        </Form.Item>
        <Form.Item
          label={
            <span>
              Questions to select&nbsp;
              <Tooltip title="How many questions will be randomly picked from this section during an interview">
                <QuestionCircleOutlined style={{ color: "#888" }} />
              </Tooltip>
            </span>
          }
          style={{ margin: 0 }}
        >
          <InputNumber
            min={1}
            max={section.questions.length || 1}
            value={section.questionsToSelect}
            onChange={(v) => update({ questionsToSelect: v ?? 1 })}
            style={{ width: 80 }}
          />
        </Form.Item>
      </div>

      {/* Questions */}
      <div style={{ marginBottom: 8, fontWeight: 500, fontSize: 13, color: "#555" }}>
        Questions ({section.questions.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {section.questions.map((q, qi) => (
          <div key={qi} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            <span style={{ paddingTop: 6, color: "#888", fontSize: 12, minWidth: 20 }}>
              {qi + 1}.
            </span>
            <Input
              value={q}
              onChange={(e) => updateQuestion(qi, e.target.value)}
              placeholder={`Question ${qi + 1}`}
              style={{ flex: 1 }}
            />
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => removeQuestion(qi)}
              style={{ marginTop: 2, flexShrink: 0 }}
            />
          </div>
        ))}
      </div>
      <Button
        size="small"
        type="dashed"
        icon={<PlusOutlined />}
        onClick={addQuestion}
        style={{ marginTop: 8, width: "100%" }}
      >
        Add Question
      </Button>
    </Card>
  );
}

// ─── Main Form ────────────────────────────────────────────────────────────────

interface Props {
  mode: "create" | "edit";
}

export default function TemplateFormPage({ mode }: Props) {
  const router = useRouter();
  const params = useParams();
  const id = params?.id as string | undefined;

  const [form] = Form.useForm();
  const isAiGenerated = Form.useWatch("isAiGenerated", form) !== false;
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // questionSections managed separately (complex nested state)
  const [sections, setSections] = useState<QuestionSection[]>([]);
  const [useSections, setUseSections] = useState(false);

  // Fetch existing template when editing
  useEffect(() => {
    if (mode !== "edit" || !id) return;
    setLoading(true);
    getTemplate(id)
      .then((t) => {
        form.setFieldsValue({
          name: t.name,
          description: t.description,
          isAiGenerated: t.isAiGenerated !== false,
          systemPrompt: t.systemPrompt,
          sampleQuestions: (t.sampleQuestions ?? []).join("\n"),
          numberOfQuestions: t.numberOfQuestions,
          isActive: t.isActive,
        });
        if (t.questionSections?.length) {
          setSections(t.questionSections);
          setUseSections(true);
        }
      })
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false));
  }, [mode, id, form]);

  const addSection = () => {
    setSections((prev) => [
      ...prev,
      { name: "", description: "", questions: [""], questionsToSelect: 1 },
    ]);
  };

  const updateSection = (i: number, updated: QuestionSection) => {
    setSections((prev) => prev.map((s, idx) => (idx === i ? updated : s)));
  };

  const removeSection = (i: number) => {
    setSections((prev) => prev.filter((_, idx) => idx !== i));
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      setError(null);

      // Parse sampleQuestions from textarea (one per line)
      const sampleQuestions = ((values.sampleQuestions as string) ?? "")
        .split("\n")
        .map((q: string) => q.trim())
        .filter(Boolean);

      const payload: TemplateFormData = {
        name: values.name,
        description: values.description ?? "",
        isAiGenerated: !!values.isAiGenerated,
        systemPrompt: values.isAiGenerated ? values.systemPrompt : "",
        sampleQuestions,
        numberOfQuestions: values.numberOfQuestions,
        questionSections: useSections && sections.length > 0 ? sections : null,
        isActive: values.isActive ?? true,
      };

      if (mode === "create") {
        await createTemplate(payload);
      } else {
        await updateTemplate(id!, payload);
      }

      router.push("/templates");
    } catch (e: any) {
      if (e?.errorFields) return; // form validation error, already shown inline
      setError(e.message || "Failed to save template");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 80 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900 }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <a
          onClick={() => router.back()}
          style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 16, color: "#1677ff" }}
        >
          ← Back
        </a>
        <h1 style={{ fontSize: 24, margin: 0 }}>
          {mode === "create" ? "New Template" : "Edit Template"}
        </h1>
      </div>

      {error && (
        <Alert type="error" message={error} closable onClose={() => setError(null)} style={{ marginBottom: 16 }} />
      )}

      <Form form={form} layout="vertical" initialValues={{ isAiGenerated: false, numberOfQuestions: 5, isActive: true }}>
        <Tabs
          items={[
            {
              key: "basic",
              label: "Basic Info",
              children: (
                <Card>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 20px" }}>
                    <Form.Item label="Template Name" name="name" rules={[{ required: true, message: "Name is required" }]}>
                      <Input placeholder="e.g. HR Interview Simulation" />
                    </Form.Item>

                    <Form.Item label="Number of Questions" name="numberOfQuestions" rules={[{ required: true }]}>
                      <InputNumber min={1} max={50} style={{ width: "100%" }} />
                    </Form.Item>

                    <Form.Item
                      label={
                        <span>
                          AI Generated
                          <span style={{ color: "#fa8c16", fontSize: "12px", fontWeight: "normal", marginLeft: "8px" }}>
                            (Feature updating...)
                          </span>
                        </span>
                      }
                      name="isAiGenerated"
                      valuePropName="checked"
                    >
                      <Switch checkedChildren="Yes" unCheckedChildren="No" disabled />
                    </Form.Item>
                  </div>

                  <Form.Item label="Description" name="description">
                    <TextArea rows={2} placeholder="Brief description of this template" />
                  </Form.Item>

                  <Form.Item label="Status" name="isActive" valuePropName="checked">
                    <Switch checkedChildren="Active" unCheckedChildren="Inactive" />
                  </Form.Item>
                </Card>
              ),
            },
            ...(isAiGenerated ? [
              {
                key: "prompt",
                label: "System Prompt",
                children: (
                  <Card>
                    <Form.Item
                      label="System Prompt"
                      name="systemPrompt"
                      rules={[{ required: true, message: "System prompt is required" }]}
                      extra="Instructions that guide the AI interviewer's behavior."
                    >
                      <TextArea rows={16} placeholder="You are an experienced HR interviewer..." style={{ fontFamily: "monospace", fontSize: 13 }} />
                    </Form.Item>
                  </Card>
                ),
              }
            ] : []),
            {
              key: "questions",
              label: isAiGenerated ? "Sample Questions" : "Predefined Questions Pool",
              children: (
                <Card>
                  <Form.Item
                    label={isAiGenerated ? "Sample Questions" : "Predefined Questions"}
                    name="sampleQuestions"
                    extra={isAiGenerated ? "One question per line. These are used as reference or fallback questions." : "One question per line. The bot will present these exact questions during the interview."}
                  >
                    <TextArea
                      rows={12}
                      placeholder={"Tell me about yourself.\nWhat are your strengths?\nWhere do you see yourself in 5 years?"}
                      style={{ fontFamily: "monospace", fontSize: 13 }}
                    />
                  </Form.Item>
                </Card>
              ),
            },
            {
              key: "sections",
              label: (
                <span>
                  Question Sections
                  {sections.length > 0 && (
                    <Tag color="purple" style={{ marginLeft: 6 }}>{sections.length}</Tag>
                  )}
                </span>
              ),
              children: (
                <Card>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                    <Switch
                      checked={useSections}
                      onChange={(v) => { setUseSections(v); if (!v) setSections([]); }}
                      checkedChildren="Enabled"
                      unCheckedChildren="Disabled"
                    />
                    <span style={{ color: "#555", fontSize: 13 }}>
                      Use structured question sections (overrides sample questions during interviews)
                    </span>
                  </div>

                  {useSections && (
                    <>
                      {sections.length === 0 && (
                        <div style={{ textAlign: "center", padding: "32px 0", color: "#aaa", border: "1px dashed #d9d9d9", borderRadius: 8, marginBottom: 12 }}>
                          No sections yet. Click below to add your first section.
                        </div>
                      )}

                      {sections.map((section, i) => (
                        <SectionEditor
                          key={i}
                          index={i}
                          section={section}
                          onChange={(updated) => updateSection(i, updated)}
                          onRemove={() => removeSection(i)}
                        />
                      ))}

                      <Button
                        type="dashed"
                        icon={<PlusOutlined />}
                        onClick={addSection}
                        style={{ width: "100%" }}
                      >
                        Add Section
                      </Button>

                      {sections.length > 0 && (
                        <div style={{ marginTop: 16, padding: "10px 14px", background: "#f6f0ff", borderRadius: 8, fontSize: 13, color: "#6b21a8" }}>
                          <strong>Summary:</strong>&nbsp;
                          {sections.length} sections ·&nbsp;
                          {sections.reduce((a, s) => a + s.questions.length, 0)} total questions ·&nbsp;
                          {sections.reduce((a, s) => a + s.questionsToSelect, 0)} will be selected per interview
                        </div>
                      )}
                    </>
                  )}
                </Card>
              ),
            },
          ]}
        />

        {/* Footer actions */}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
          <Button onClick={() => router.back()}>Cancel</Button>
          <Button type="primary" loading={saving} onClick={handleSubmit}>
            {mode === "create" ? "Create Template" : "Save Changes"}
          </Button>
        </div>
      </Form>
    </div>
  );
}
"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, Input, Statistic, Row, Col, Select, DatePicker, Space, Alert, Button, Switch, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import dayjs, { Dayjs } from "dayjs";
import InterviewTable from "@/components/InterviewTable";
import {
  getInterviews,
  getStats,
  getSystemSettings,
  updateSystemSettings,
  type InterviewListItem,
  type AdminStats,
  type GetInterviewsParams,
} from "@/services/interviewService";

import { getTemplates, type InterviewTemplate } from "@/services/templateService";

const { RangePicker } = DatePicker;
const { Option } = Select;

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export default function InterviewListPage() {
  const router = useRouter();

  // ── Config state ────────────────────────────────────────────────────────────
  const [sendLinkEnabled, setSendLinkEnabled] = useState(true);
  const [settingsLoading, setSettingsLoading] = useState(false);

  // ── List state ──────────────────────────────────────────────────────────────
  const [interviews, setInterviews] = useState<InterviewListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // ── Filter state ────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [templateFilter, setTemplateFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [templates, setTemplates] = useState<InterviewTemplate[]>([]);

  const debouncedSearch = useDebounce(search, 400);

  // ── Stats state ─────────────────────────────────────────────────────────────
  const [stats, setStats] = useState<AdminStats | null>(null);

  // ── Fetch templates list ────────────────────────────────────────────────────
  useEffect(() => {
    getTemplates()
      .then(setTemplates)
      .catch(() => {});
  }, []);

  // ── Fetch list ───────────────────────────────────────────────────────────────
  const fetchList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const params: GetInterviewsParams = {
        page,
        limit: 10,
        search: debouncedSearch || undefined,
        status: statusFilter !== "all" ? statusFilter : undefined,
        templateId: templateFilter !== "all" ? templateFilter : undefined,
        dateFrom: dateRange?.[0]?.format("YYYY-MM-DD") ?? undefined,
        dateTo: dateRange?.[1]?.format("YYYY-MM-DD") ?? undefined,
      };
      const res = await getInterviews(params);
      setInterviews(res.data);
      setTotal(res.total);
    } catch (e: any) {
      setListError(e.message || "Failed to load interview list");
    } finally {
      setListLoading(false);
    }
  }, [page, debouncedSearch, statusFilter, templateFilter, dateRange]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [debouncedSearch, statusFilter, templateFilter, dateRange]);
  useEffect(() => { fetchList(); }, [fetchList]);

  // ── Fetch settings ───────────────────────────────────────────────────────────
  useEffect(() => {
    getSystemSettings()
      .then((settings) => {
        if (settings && settings.send_result_link_to_candidate !== undefined) {
          setSendLinkEnabled(settings.send_result_link_to_candidate);
        }
      })
      .catch(() => {});
  }, []);

  const handleToggleSendLink = async (checked: boolean) => {
    setSettingsLoading(true);
    try {
      await updateSystemSettings({ send_result_link_to_candidate: checked });
      setSendLinkEnabled(checked);
      message.success(`Auto-sending results link is now ${checked ? "enabled" : "disabled"}`);
    } catch (e: any) {
      message.error(e.message || "Failed to update configuration");
    } finally {
      setSettingsLoading(false);
    }
  };

  // ── Fetch stats ──────────────────────────────────────────────────────────────
  useEffect(() => {
    getStats()
      .then(setStats)
      .catch(() => {});
  }, []);

  // ── Navigate to detail page ──────────────────────────────────────────────────
  const handleView = (record: InterviewListItem) => {
    router.push(`/interviews/${record.id}`);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 26, margin: 0 }}>Interview List</h1>
          <div style={{ color: "#888", marginTop: 4 }}>
            Manage and track AI interview results
          </div>
        </div>
        <Card size="small" style={{ minWidth: 260, border: "1px solid #1677ff", background: "#f0f8ff" }}>
          <Space align="center" style={{ width: "100%", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Auto-send Results Link:</span>
            <Switch
              checked={sendLinkEnabled}
              loading={settingsLoading}
              onChange={handleToggleSendLink}
              checkedChildren="ON"
              unCheckedChildren="OFF"
            />
          </Space>
        </Card>
      </div>

      {/* Stats */}
      {stats && (
        <Row gutter={16} style={{ marginBottom: 20 }}>
          <Col span={8}>
            <Card size="small">
              <Statistic title="Total Interviews" value={stats.total} />
            </Card>
          </Col>
          <Col span={8}>
            <Card size="small">
              <Statistic title="Completed" value={stats.completed} styles={{ content: { color: "#52c41a" } }} />
            </Card>
          </Col>
          <Col span={8}>
            <Card size="small">
              <Statistic title="In Progress" value={stats.inProgress} styles={{ content: { color: "#faad14" } }} />
            </Card>
          </Col>
        </Row>
      )}

      <Card>
        {/* Filter bar */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 8 }}>
          <Space style={{ flexWrap: "wrap" }}>
            <Input
              placeholder="Search interviews..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              allowClear
              style={{ width: 260 }}
            />
            <Select
              value={statusFilter}
              onChange={setStatusFilter}
              style={{ width: 160 }}
            >
              <Option value="all">All statuses</Option>
              <Option value="finished_session">Finished Session</Option>
              <Option value="completed">Completed</Option>
              <Option value="in_progress">In Progress</Option>
              <Option value="pending">Pending</Option>
              <Option value="cancelled">Cancelled</Option>
            </Select>
            <Select
              value={templateFilter}
              onChange={setTemplateFilter}
              style={{ minWidth: 200 }}
              placeholder="All templates"
            >
              <Option value="all">All templates</Option>
              {templates.map((t) => (
                <Option key={t.id} value={t.id}>
                  {t.name}
                </Option>
              ))}
            </Select>
            <RangePicker
              value={dateRange}
              onChange={(dates) => setDateRange(dates as [Dayjs | null, Dayjs | null] | null)}
              format="DD/MM/YYYY"
              placeholder={["From date", "To date"]}
            />
          </Space>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={fetchList}
            loading={listLoading}
          >
            Refresh
          </Button>
        </div>

        {/* Error */}
        {listError && (
          <Alert
            type="error"
            message={listError}
            action={<a onClick={fetchList}>Retry</a>}
            style={{ marginBottom: 16 }}
            closable
            onClose={() => setListError(null)}
          />
        )}

        {/* Table */}
        <InterviewTable
          data={interviews}
          loading={listLoading}
          onView={handleView}
          pagination={{
            current: page,
            pageSize: 10,
            total,
            onChange: setPage,
          }}
        />
      </Card>
    </div>
  );
}
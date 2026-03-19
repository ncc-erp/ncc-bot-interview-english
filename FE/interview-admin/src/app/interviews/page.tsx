"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, Input, Statistic, Row, Col, Select, DatePicker, Space, Alert } from "antd";
import { useRouter } from "next/navigation";
import dayjs, { Dayjs } from "dayjs";
import InterviewTable from "@/components/InterviewTable";
import {
  getInterviews,
  getStats,
  type InterviewListItem,
  type AdminStats,
  type GetInterviewsParams,
} from "@/services/interviewService";

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

  // ── List state ──────────────────────────────────────────────────────────────
  const [interviews, setInterviews] = useState<InterviewListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // ── Filter state ────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  const debouncedSearch = useDebounce(search, 400);

  // ── Stats state ─────────────────────────────────────────────────────────────
  const [stats, setStats] = useState<AdminStats | null>(null);

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
  }, [page, debouncedSearch, statusFilter, dateRange]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [debouncedSearch, statusFilter, dateRange]);
  useEffect(() => { fetchList(); }, [fetchList]);

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
      <h1 style={{ fontSize: 26, marginBottom: 10 }}>Interview List</h1>
      <div style={{ color: "#888", marginBottom: 20 }}>
        Manage and track AI interview results
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
        <Space style={{ marginBottom: 20, flexWrap: "wrap" }}>
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
            <Option value="completed">Completed</Option>
            <Option value="in_progress">In Progress</Option>
            <Option value="pending">Pending</Option>
            <Option value="cancelled">Cancelled</Option>
          </Select>
          <RangePicker
            value={dateRange}
            onChange={(dates) => setDateRange(dates as [Dayjs | null, Dayjs | null] | null)}
            format="DD/MM/YYYY"
            placeholder={["From date", "To date"]}
          />
        </Space>

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
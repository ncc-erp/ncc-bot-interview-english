"use client";

import { useEffect, useState } from "react";
import { Card, Descriptions, Spin, Alert, Typography, Avatar } from "antd";
import { UserOutlined, CalendarOutlined, IdcardOutlined, LockOutlined } from "@ant-design/icons";
import { getAdminProfile } from "@/services/interviewService";
import dayjs from "dayjs";

const { Title, Paragraph } = Typography;

export default function ProfilePage() {
  const [profile, setProfile] = useState<{ id: string; username: string; createdAt: string } | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAdminProfile()
      .then((data) => {
        setProfile(data);
      })
      .catch((err) => {
        setError(err.message || "Failed to load admin profile");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "60vh" }}>
        <Spin size="large" tip="Loading profile..." />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "20px 0" }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={2} style={{ margin: 0 }}>My Profile</Title>
        <Paragraph type="secondary">View and manage your administrator account information</Paragraph>
      </div>

      {error && (
        <Alert
          message="Error"
          description={error}
          type="error"
          showIcon
          style={{ marginBottom: 24 }}
        />
      )}

      {profile && (
        <Card
          style={{
            borderRadius: 12,
            boxShadow: "0 4px 20px rgba(0,0,0,0.05)",
            border: "1px solid rgba(0,0,0,0.06)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 24, marginBottom: 32, flexWrap: "wrap" }}>
            <Avatar
              size={80}
              icon={<UserOutlined />}
              style={{
                backgroundColor: "#1677ff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 4px 10px rgba(22, 119, 255, 0.3)",
              }}
            />
            <div>
              <Title level={3} style={{ margin: 0, fontWeight: 600 }}>{profile.username}</Title>
              <Paragraph type="secondary" style={{ margin: 0 }}>System Administrator</Paragraph>
            </div>
          </div>

          <Descriptions
            bordered
            column={1}
            size="middle"
            labelStyle={{ width: "200px", fontWeight: 500, backgroundColor: "#fafafa" }}
          >
            <Descriptions.Item label={<span><IdcardOutlined style={{ marginRight: 8, color: "#1677ff" }} /> ID</span>}>
              {profile.id}
            </Descriptions.Item>
            <Descriptions.Item label={<span><UserOutlined style={{ marginRight: 8, color: "#1677ff" }} /> Username</span>}>
              {profile.username}
            </Descriptions.Item>
            <Descriptions.Item label={<span><LockOutlined style={{ marginRight: 8, color: "#1677ff" }} /> Role</span>}>
              Administrator (Full Access)
            </Descriptions.Item>
            <Descriptions.Item label={<span><CalendarOutlined style={{ marginRight: 8, color: "#1677ff" }} /> Account Created</span>}>
              {dayjs(profile.createdAt).format("DD/MM/YYYY HH:mm:ss")}
            </Descriptions.Item>
          </Descriptions>
        </Card>
      )}
    </div>
  );
}

"use client";

import { useState, useEffect } from "react";
import { Card, Form, Input, Button, Typography, message, Alert } from "antd";
import { UserOutlined, LockOutlined, LoginOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { login } from "@/services/interviewService";
import { setAccessToken } from "@/lib/apiClient";

const { Title, Text } = Typography;

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const router = useRouter();

  // If already logged in, redirect to dashboard
  useEffect(() => {
    const username = localStorage.getItem("admin_username");
    if (username) {
      router.push("/interviews");
    }
  }, [router]);

  const onFinish = async (values: any) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await login({
        username: values.username,
        password: values.password,
      });

      localStorage.setItem("admin_username", res.username);
      localStorage.setItem("admin_refresh_token", res.refreshToken);
      setAccessToken(res.accessToken);
      
      message.success("Logged in successfully!");
      
      // Delay slightly for smooth transition
      setTimeout(() => {
        router.push("/interviews");
      }, 500);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to login. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        background: "linear-gradient(135deg, #141e30 0%, #243b55 100%)",
        padding: "20px",
      }}
    >
      <Card
        style={{
          width: "100%",
          maxWidth: 420,
          boxShadow: "0 8px 32px 0 rgba(0, 0, 0, 0.37)",
          borderRadius: 12,
          border: "1px solid rgba(255, 255, 255, 0.1)",
          background: "rgba(255, 255, 255, 0.95)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <Title level={2} style={{ margin: 0, fontWeight: 700, color: "#141e30" }}>
            Admin Portal
          </Title>
          <Text type="secondary" style={{ fontSize: 14 }}>
            Sign in to manage English Interviews
          </Text>
        </div>

        {errorMsg && (
          <Alert
            message={errorMsg}
            type="error"
            showIcon
            closable
            onClose={() => setErrorMsg(null)}
            style={{ marginBottom: 20 }}
          />
        )}

        <Form
          name="login_form"
          initialValues={{ remember: true }}
          onFinish={onFinish}
          layout="vertical"
          size="large"
        >
          <Form.Item
            name="username"
            rules={[{ required: true, message: "Please input your username!" }]}
          >
            <Input
              prefix={<UserOutlined style={{ color: "rgba(0,0,0,.25)" }} />}
              placeholder="Username"
            />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[{ required: true, message: "Please input your password!" }]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: "rgba(0,0,0,.25)" }} />}
              placeholder="Password"
            />
          </Form.Item>

          <Form.Item style={{ marginTop: 24, marginBottom: 0 }}>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              icon={<LoginOutlined />}
              style={{
                width: "100%",
                background: "linear-gradient(135deg, #141e30 0%, #243b55 100%)",
                border: "none",
                height: 44,
                borderRadius: 6,
                fontWeight: 600,
              }}
            >
              Sign In
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}

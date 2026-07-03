"use client";

import { useState } from "react";
import { Card, Form, Input, Button, Typography, message, Alert } from "antd";
import { LockOutlined, SaveOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { changeAdminPassword } from "@/services/interviewService";
import { setAccessToken } from "@/lib/apiClient";

const { Title, Paragraph } = Typography;

export default function ChangePasswordPage() {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [form] = Form.useForm();
  const router = useRouter();

  const onFinish = async (values: any) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      await changeAdminPassword({
        oldPassword: values.oldPassword,
        newPassword: values.newPassword,
      });

      message.success("Password changed successfully! Please log in again with your new password.");
      
      // Clear session and redirect to login
      setTimeout(() => {
        localStorage.removeItem("admin_username");
        localStorage.removeItem("admin_refresh_token");
        setAccessToken(null);
        router.push("/login");
      }, 2000);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to change password. Please check your credentials.");
    } finally {
      setLoading(false);
    }
  };

  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: "20px 0" }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={2} style={{ margin: 0 }}>Change Password</Title>
        <Paragraph type="secondary">Update your administrator account password. You will be logged out upon success.</Paragraph>
      </div>

      {errorMsg && (
        <Alert
          message="Error"
          description={errorMsg}
          type="error"
          showIcon
          closable
          onClose={() => setErrorMsg(null)}
          style={{ marginBottom: 24 }}
        />
      )}

      <Card
        style={{
          borderRadius: 12,
          boxShadow: "0 4px 20px rgba(0,0,0,0.05)",
          border: "1px solid rgba(0,0,0,0.06)",
        }}
      >
        <Form
          form={form}
          name="change_password_form"
          layout="vertical"
          onFinish={onFinish}
          size="large"
          requiredMark="optional"
        >
          <Form.Item
            label="Current Password"
            name="oldPassword"
            rules={[{ required: true, message: "Please input your current password!" }]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: "rgba(0,0,0,.25)" }} />}
              placeholder="Enter current password"
            />
          </Form.Item>

          <Form.Item
            label="New Password"
            name="newPassword"
            rules={[
              { required: true, message: "Please input your new password!" },
              {
                validator: (_, value) => {
                  if (!value) {
                    return Promise.resolve();
                  }
                  if (!passwordRegex.test(value)) {
                    return Promise.reject(
                      new Error(
                        "Password must be at least 8 characters, include at least one uppercase letter, one number, and one special character."
                      )
                    );
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: "rgba(0,0,0,.25)" }} />}
              placeholder="Enter new password"
            />
          </Form.Item>

          <Form.Item
            label="Confirm New Password"
            name="confirmPassword"
            dependencies={["newPassword"]}
            rules={[
              { required: true, message: "Please confirm your new password!" },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue("newPassword") === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error("The two passwords that you entered do not match!"));
                },
              }),
            ]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: "rgba(0,0,0,.25)" }} />}
              placeholder="Confirm new password"
            />
          </Form.Item>

          <Form.Item style={{ marginTop: 32, marginBottom: 0 }}>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              icon={<SaveOutlined />}
              style={{
                width: "100%",
                height: 46,
                borderRadius: 6,
                fontWeight: 600,
              }}
            >
              Update Password
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}

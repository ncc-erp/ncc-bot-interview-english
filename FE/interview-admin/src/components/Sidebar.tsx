"use client";

import { Layout, Menu, message } from "antd";
import { FileTextOutlined, MessageOutlined, LogoutOutlined, UserOutlined } from "@ant-design/icons";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useState, useEffect } from "react";
import { logout } from "@/services/interviewService";
import { setAccessToken } from "@/lib/apiClient";

const { Sider } = Layout;

export default function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const [username, setUsername] = useState<string>("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      setUsername(localStorage.getItem("admin_username") || "Admin");
    }
  }, []);

  let selectedKey = "interviews";
  if (pathname.startsWith("/templates")) {
    selectedKey = "templates";
  } else if (pathname.startsWith("/profile")) {
    selectedKey = "profile";
  } else if (pathname.startsWith("/change-password")) {
    selectedKey = "change-password";
  }

  const isAccountPath = pathname.startsWith("/profile") || pathname.startsWith("/change-password");

  return (
    <Sider width={220} style={{ background: "#fff" }}>
      <h2 style={{ padding: "16px" }}>
        <Link href="/interviews" style={{ color: "black", textDecoration: "none" }}>
          AI Interview
        </Link>
      </h2>

      <Menu
        mode="inline"
        selectedKeys={[selectedKey]}
        defaultOpenKeys={isAccountPath ? ["account"] : []}
        items={[
          {
            key: "account",
            icon: <UserOutlined />,
            label: username ? username.charAt(0).toUpperCase() + username.slice(1) : "Account",
            children: [
              {
                key: "profile",
                label: "My Profile",
                onClick: () => router.push("/profile"),
              },
              {
                key: "change-password",
                label: "Change Password",
                onClick: () => router.push("/change-password"),
              },
            ],
          },
          {
            key: "interviews",
            icon: <MessageOutlined />,
            label: "Interview List",
            onClick: () => router.push("/interviews"),
          },
          {
            key: "templates",
            icon: <FileTextOutlined />,
            label: "Template List",
            onClick: () => router.push("/templates"),
          },
          {
            key: "logout",
            icon: <LogoutOutlined style={{ color: "#ff4d4f" }} />,
            label: <span style={{ color: "#ff4d4f" }}>Logout</span>,
            onClick: async () => {
              try {
                await logout();
              } catch (e) {
                // Ignore API logout error, clear locally anyway
              }
              localStorage.removeItem("admin_username");
              localStorage.removeItem("admin_refresh_token");
              setAccessToken(null);
              message.success("Logged out successfully");
              router.push("/login");
            },
          },
        ]}
      />
    </Sider>
  );
}
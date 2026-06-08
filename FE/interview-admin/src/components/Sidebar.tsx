"use client";

import { Layout, Menu, message } from "antd";
import { FileTextOutlined, MessageOutlined, LogoutOutlined } from "@ant-design/icons";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { logout } from "@/services/interviewService";

const { Sider } = Layout;

export default function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();

  const selectedKey = pathname.startsWith("/templates") ? "templates" : "interviews";

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
        items={[
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
              message.success("Logged out successfully");
              router.push("/login");
            },
          },
        ]}
      />
    </Sider>
  );
}
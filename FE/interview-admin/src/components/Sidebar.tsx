"use client";

import { Layout, Menu } from "antd";
import { FileTextOutlined, MessageOutlined } from "@ant-design/icons";
import { useRouter, usePathname } from "next/navigation";

const { Sider } = Layout;

export default function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();

  const selectedKey = pathname.startsWith("/templates") ? "templates" : "interviews";

  return (
    <Sider width={220} style={{ background: "#fff" }}>
      <div style={{ padding: 20, fontWeight: 700, fontSize: 18 }}>
        AI Interview
      </div>

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
        ]}
      />
    </Sider>
  );
}
"use client";

import { Layout } from "antd";
import Sidebar from "@/components/Sidebar";
import { usePathname } from "next/navigation";
import "antd/dist/reset.css";

const { Content } = Layout;

export default function LayoutClient({ children }: any) {
  const pathname = usePathname();
  const isCandidatePage = pathname?.startsWith("/candidate-result");

  if (isCandidatePage) {
    return (
      <Layout style={{ minHeight: "100vh", background: "#f5f7fb" }}>
        <Content style={{ padding: "30px 16px", background: "#f5f7fb" }}>
          {children}
        </Content>
      </Layout>
    );
  }

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sidebar />

      <Layout>
        <Content style={{ padding: 30, background: "#f5f7fb" }}>
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}
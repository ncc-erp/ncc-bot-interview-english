"use client";

import { Layout } from "antd";
import Sidebar from "@/components/Sidebar";
import "antd/dist/reset.css";

const { Content } = Layout;

export default function LayoutClient({ children }: any) {
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
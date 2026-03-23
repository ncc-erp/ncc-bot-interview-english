"use client";

import { Layout } from "antd";
import Sidebar from "@/components/Sidebar";
import "antd/dist/reset.css";

const { Content } = Layout;

export default function RootLayout({ children }: any) {
  return (
    <html>
      <body>
        <Layout style={{ minHeight: "100vh" }}>
          <Sidebar />

          <Layout>
            <Content style={{ padding: 30, background: "#f5f7fb" }}>
              {children}
            </Content>
          </Layout>
        </Layout>
      </body>
    </html>
  );
}
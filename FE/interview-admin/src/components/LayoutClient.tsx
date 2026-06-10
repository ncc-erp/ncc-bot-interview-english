"use client";

import { Layout, Spin } from "antd";
import Sidebar from "@/components/Sidebar";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import "antd/dist/reset.css";

const { Content } = Layout;

export default function LayoutClient({ children }: any) {
  const pathname = usePathname();
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);

  const isCandidatePage = pathname?.startsWith("/candidate-result");
  const isLoginPage = pathname === "/login";

  useEffect(() => {
    if (typeof window !== "undefined") {
      let username = localStorage.getItem("admin_username");
      const isPublicPath = isCandidatePage || isLoginPage;

      // Temporarily bypass login check
      if (!username) {
        username = "admin";
        localStorage.setItem("admin_username", "admin");
      }

      if (username && isLoginPage) {
        router.push("/interviews");
      } else {
        setCheckingAuth(false);
      }
    }
  }, [pathname, isCandidatePage, isLoginPage, router]);

  if (checkingAuth && !isCandidatePage && !isLoginPage) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", background: "#f5f7fb" }}>
        <Spin size="large" tip="Loading Admin Portal..." />
      </div>
    );
  }

  if (isCandidatePage || isLoginPage) {
    return (
      <Layout style={{ minHeight: "100vh", background: "#f5f7fb" }}>
        <Content style={{ padding: isLoginPage ? 0 : "30px 16px", background: "#f5f7fb" }}>
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
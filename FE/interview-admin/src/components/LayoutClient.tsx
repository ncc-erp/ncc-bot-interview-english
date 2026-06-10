"use client";

import { Layout, Spin } from "antd";
import Sidebar from "@/components/Sidebar";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getAccessToken, setAccessToken } from "@/lib/apiClient";
import { refreshAccessToken } from "@/services/interviewService";
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
      const isPublicPath = isCandidatePage || isLoginPage;
      const token = getAccessToken();

      if (token) {
        if (isLoginPage) {
          router.push("/interviews");
        } else {
          setCheckingAuth(false);
        }
      } else {
        const refreshToken = localStorage.getItem("admin_refresh_token");
        if (refreshToken) {
          // Perform silent refresh on mount/F5
          refreshAccessToken(refreshToken)
            .then((res) => {
              setAccessToken(res.accessToken);
              setCheckingAuth(false);
              if (isLoginPage) {
                router.push("/interviews");
              }
            })
            .catch(() => {
              // Token expired or invalid
              localStorage.removeItem("admin_username");
              localStorage.removeItem("admin_refresh_token");
              setAccessToken(null);
              router.push("/login");
            });
        } else {
          // No active tokens
          if (!isPublicPath) {
            router.push("/login");
          } else {
            setCheckingAuth(false);
          }
        }
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
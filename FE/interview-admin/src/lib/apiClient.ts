const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

let isRefreshing: Promise<any> | null = null;

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "include",
    cache: "no-store",
  });

  if (!res.ok) {
    const isPublicRoute =
      typeof window !== "undefined" &&
      (window.location.pathname.startsWith("/login") ||
        window.location.pathname.startsWith("/candidate-result"));

    // Handle 401 Unauthorized for non-public routes by attempting a token refresh
    if (res.status === 401 && !isPublicRoute && path !== "/admin/auth/refresh") {
      if (typeof window !== "undefined") {
        try {
          if (!isRefreshing) {
            // Trigger token refresh call and save it as a shared promise
            isRefreshing = fetch(`${BASE_URL}/admin/auth/refresh`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
            })
              .then(async (refreshRes) => {
                if (!refreshRes.ok) {
                  throw new Error("Refresh token expired");
                }
                return refreshRes.json();
              })
              .finally(() => {
                isRefreshing = null;
              });
          }

          await isRefreshing;

          // Retry original request
          return apiFetch(path, init);
        } catch (refreshErr) {
          // Refresh token is expired or invalid - clear credentials and redirect to login
          localStorage.removeItem("admin_username");
          window.location.href = "/login";
          throw refreshErr;
        }
      }
    }

    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `HTTP ${res.status}`);
  }

  return res.json();
}
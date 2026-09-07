const API_BASE = "/api";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("accessToken");
}

function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("refreshToken");
}

export function setTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem("accessToken", accessToken);
  localStorage.setItem("refreshToken", refreshToken);
}

export function clearTokens() {
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      clearTokens();
      return null;
    }

    const data = await res.json();
    localStorage.setItem("accessToken", data.accessToken);
    return data.accessToken;
  } catch {
    clearTokens();
    return null;
  }
}

export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  // If 401, try refreshing the token
  if (res.status === 401 && token) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers["Authorization"] = `Bearer ${newToken}`;
      res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    } else {
      // Redirect to login
      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
      throw new Error("Session expired");
    }
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || `API error: ${res.status}`);
  }

  return res.json();
}

// 2026-06-11: достаёт человекочитаемое сообщение из ответа сломанного fetch.
// Покрывает три кейса которые попадались в проде:
//   1) NestJS Zod/UnauthorizedException → { message: "Неверный логин или пароль" }
//   2) class-validator → { message: ["email must be email", ...] } (array)
//   3) nginx 502/504 → HTML (res.json() кидает SyntaxError)
// Если ни один не сработал — возвращает fallback.
export async function parseApiError(
  res: Response,
  fallback: string,
): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    return fallback;
  }
  if (!raw.trim()) return fallback;
  try {
    const data = JSON.parse(raw);
    const msg = data?.message;
    if (Array.isArray(msg)) return msg.filter(Boolean).join("; ") || fallback;
    if (typeof msg === "string" && msg.trim()) return msg;
    if (typeof data?.error === "string" && data.error.trim()) return data.error;
  } catch {
    // HTML или другой не-JSON — fallback
  }
  return fallback;
}

// Convenience methods
export const apiGet = <T = any>(path: string) => api<T>(path);

export const apiPost = <T = any>(path: string, body: any) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });

export const apiPatch = <T = any>(path: string, body: any) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });

export const apiDelete = <T = any>(path: string) =>
  api<T>(path, { method: "DELETE" });

/**
 * Download an authenticated response without ever putting bearer tokens or
 * search text in the URL. The caller owns the returned Blob.
 */
export async function apiDownload(
  path: string,
  body: unknown,
): Promise<{ blob: Blob; filename: string }> {
  const request = async (token: string | null) =>
    fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const initialToken = getToken();
  let response = await request(initialToken);
  if (response.status === 401 && initialToken) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      if (typeof window !== "undefined") window.location.href = "/login";
      throw new Error("Session expired");
    }
    response = await request(refreshed);
  }
  if (!response.ok) {
    throw new Error(
      await parseApiError(response, `API error: ${response.status}`),
    );
  }

  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
  return {
    blob: await response.blob(),
    filename: encoded
      ? decodeURIComponent(encoded)
      : quoted || "loyalty-base.csv",
  };
}

export async function apiUpload<T = any>(
  path: string,
  formData: FormData,
): Promise<T> {
  const request = (token: string | null) =>
    fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
  const initialToken = getToken();
  let res = await request(initialToken);
  if (res.status === 401 && initialToken) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw new Error("Session expired");
    res = await request(refreshed);
  }
  if (!res.ok) {
    throw new Error(await parseApiError(res, `Upload failed: ${res.status}`));
  }
  return res.json();
}

/** Download a protected GET resource with bearer refresh and no token in URL. */
export async function apiGetDownload(
  path: string,
): Promise<{ blob: Blob; filename: string }> {
  const request = (token: string | null) =>
    fetch(`${API_BASE}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
    });
  const initialToken = getToken();
  let response = await request(initialToken);
  if (response.status === 401 && initialToken) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw new Error("Session expired");
    response = await request(refreshed);
  }
  if (!response.ok) {
    throw new Error(
      await parseApiError(response, `API error: ${response.status}`),
    );
  }
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
  return {
    blob: await response.blob(),
    filename: encoded ? decodeURIComponent(encoded) : quoted || "attachment",
  };
}

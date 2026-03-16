export const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8080";
export const WS_BASE = import.meta.env.VITE_WS_BASE || "ws://localhost:8080";

export type AuthResponse = {
  token: string;
  username: string;
  recoveryCode?: string;
};

export type SessionInfo = {
  kind?: "session_update";
  ts?: number;
  peer: string;
  status: "none" | "pending" | "active" | "ended";
  requestedBy: string | null;
  createdAt?: number;
  updatedAt?: number;
};

export async function apiRegister(username: string, password: string): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `Register failed (${response.status})`);
  return json as AuthResponse;
}

export async function apiLogin(username: string, password: string): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || "Login failed");
  return json as AuthResponse;
}

export async function apiResetPassword(username: string, recoveryCode: string, newPassword: string) {
  const response = await fetch(`${API_BASE}/api/password/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, recoveryCode, newPassword }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || "Password reset failed");
  return json as { ok: true };
}

export async function apiSearchUsers(q: string) {
  const response = await fetch(`${API_BASE}/api/users/search?q=${encodeURIComponent(q)}`);
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Search failed");
  return json.users as Array<{ username: string; lastSeenAt: number }>;
}

export async function apiGetUserStatus(username: string) {
  const response = await fetch(`${API_BASE}/api/users/status?u=${encodeURIComponent(username)}`);
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "User status failed");
  return json as { username: string; online: boolean; lastSeenAt?: number };
}

export async function apiSetKey(token: string, publicKeyJwk: unknown) {
  const response = await fetch(`${API_BASE}/api/keys/set`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ publicKeyJwk }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || "Key set failed");
  return json;
}

export async function apiGetKey(username: string) {
  const response = await fetch(`${API_BASE}/api/keys/get?u=${encodeURIComponent(username)}`);
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Key get failed");
  return json as { username: string; publicKeyJwk: JsonWebKey | null; keyUpdatedAt?: number };
}

export async function apiGetMessages(token: string, username: string) {
  const response = await fetch(`${API_BASE}/api/messages?u=${encodeURIComponent(username)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Message history failed");
  return json.messages as Array<{
    id: string;
    from: string;
    to: string;
    body: string;
    ts: number;
    readAt?: number;
  }>;
}

export async function apiGetSession(token: string, peer: string) {
  const response = await fetch(`${API_BASE}/api/sessions?u=${encodeURIComponent(peer)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Session lookup failed");
  return json as SessionInfo;
}

export async function apiGetIncomingSessions(token: string) {
  const response = await fetch(`${API_BASE}/api/sessions/incoming`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Incoming session lookup failed");
  return json.sessions as SessionInfo[];
}

export async function apiRequestSession(token: string, peer: string) {
  const response = await fetch(`${API_BASE}/api/sessions/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ peer }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || "Session request failed");
  return json as SessionInfo;
}

export async function apiRespondSession(token: string, peer: string, action: "accept" | "decline") {
  const response = await fetch(`${API_BASE}/api/sessions/respond`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ peer, action }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || "Session response failed");
  return json as SessionInfo;
}

export async function apiEndSession(token: string, peer: string) {
  const response = await fetch(`${API_BASE}/api/sessions/end`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ peer }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || "Session end failed");
  return json as SessionInfo;
}

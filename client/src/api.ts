// client/src/api.ts
export const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8080";
export const WS_BASE = import.meta.env.VITE_WS_BASE || "ws://localhost:8080";

export type AuthResponse = { token: string; username: string };

export async function apiRegister(username: string, password: string): Promise<AuthResponse> {
  const r = await fetch(`${API_BASE}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
  console.log("REGISTER FAIL", r.status, j);
  throw new Error(j.error || `Register failed (${r.status})`);
}

  return j as AuthResponse;
}

export async function apiLogin(username: string, password: string): Promise<AuthResponse> {
  const r = await fetch(`${API_BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Login failed");
  return j as AuthResponse;
}
export async function apiSearchUsers(q: string) {
  const r = await fetch(`${API_BASE}/api/users/search?q=${encodeURIComponent(q)}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Search failed");
  return j.users as Array<{ username: string; lastSeenAt: number }>;
}

export async function apiSetKey(token: string, publicKeyJwk: any) {
  const r = await fetch(`${API_BASE}/api/keys/set`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ publicKeyJwk })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "Key set failed");
  return j;
}

export async function apiGetKey(username: string) {
  const r = await fetch(`${API_BASE}/api/keys/get?u=${encodeURIComponent(username)}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Key get failed");
  return j as { username: string; publicKeyJwk: any | null; keyUpdatedAt?: number };
}

export async function apiGetMessages(token: string, username: string) {
  const r = await fetch(`${API_BASE}/api/messages?u=${encodeURIComponent(username)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Message history failed");
  return j.messages as Array<{
    id: string;
    from: string;
    to: string;
    body: string;
    ts: number;
    readAt?: number;
  }>;
}

export async function apiGetUserStatus(username: string) {
  const r = await fetch(`${API_BASE}/api/users/status?u=${encodeURIComponent(username)}`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "User status failed");
  return j as { username: string; online: boolean; lastSeenAt?: number };
}

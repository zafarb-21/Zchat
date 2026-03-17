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

export type DeviceInfo = {
  deviceId: string;
  deviceLabel: string;
  publicKeyJwk: JsonWebKey | null;
  notificationsEnabled: boolean;
  online: boolean;
  lastSeenAt: number;
  updatedAt: number;
  createdAt: number;
};

function authHeaders(token?: string, deviceId?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (deviceId) headers["x-zchat-device-id"] = deviceId;
  return headers;
}

async function parseJson<T>(response: Response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((json as { error?: string }).error || `Request failed (${response.status})`);
  }
  return json as T;
}

export async function apiRegister(username: string, password: string): Promise<AuthResponse> {
  return parseJson<AuthResponse>(await fetch(`${API_BASE}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }));
}

export async function apiLogin(username: string, password: string): Promise<AuthResponse> {
  return parseJson<AuthResponse>(await fetch(`${API_BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  }));
}

export async function apiResetPassword(username: string, recoveryCode: string, newPassword: string) {
  return parseJson<{ ok: true }>(await fetch(`${API_BASE}/api/password/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, recoveryCode, newPassword }),
  }));
}

export async function apiSearchUsers(q: string) {
  const response = await fetch(`${API_BASE}/api/users/search?q=${encodeURIComponent(q)}`);
  const json = await parseJson<{ users: Array<{ username: string; lastSeenAt: number }> }>(response);
  return json.users;
}

export async function apiGetUserStatus(username: string) {
  return parseJson<{ username: string; online: boolean; lastSeenAt?: number }>(
    await fetch(`${API_BASE}/api/users/status?u=${encodeURIComponent(username)}`)
  );
}

export async function apiSetKey(
  token: string,
  deviceId: string,
  deviceLabel: string,
  publicKeyJwk: unknown,
  notificationsEnabled: boolean
) {
  return parseJson<{ ok: true }>(await fetch(`${API_BASE}/api/keys/set`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token, deviceId),
    },
    body: JSON.stringify({ publicKeyJwk, deviceLabel, notificationsEnabled }),
  }));
}

export async function apiUpsertDevice(
  token: string,
  deviceId: string,
  deviceLabel: string,
  publicKeyJwk: unknown,
  notificationsEnabled: boolean
) {
  return parseJson<{ ok: true; device: DeviceInfo }>(await fetch(`${API_BASE}/api/devices/upsert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify({ deviceId, deviceLabel, publicKeyJwk, notificationsEnabled }),
  }));
}

export async function apiUpdateDeviceNotifications(token: string, deviceId: string, notificationsEnabled: boolean) {
  return parseJson<{ ok: true }>(await fetch(`${API_BASE}/api/devices/notifications`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify({ deviceId, notificationsEnabled }),
  }));
}

export async function apiGetDevices(token: string, username: string) {
  const json = await parseJson<{ username: string; devices: DeviceInfo[] }>(
    await fetch(`${API_BASE}/api/devices?u=${encodeURIComponent(username)}`, {
      headers: authHeaders(token),
    })
  );
  return json.devices;
}

export async function apiGetMyDevices(token: string, deviceId: string) {
  return parseJson<{ username: string; currentDeviceId: string | null; devices: DeviceInfo[] }>(
    await fetch(`${API_BASE}/api/devices/me`, {
      headers: authHeaders(token, deviceId),
    })
  );
}

export async function apiGetKey(token: string, username: string) {
  const response = await fetch(`${API_BASE}/api/keys/get?u=${encodeURIComponent(username)}`, {
    headers: authHeaders(token),
  });
  return parseJson<{ username: string; devices: DeviceInfo[]; publicKeyJwk: JsonWebKey | null; keyUpdatedAt?: number }>(response);
}

export async function apiGetMessages(token: string, username: string, deviceId: string) {
  const json = await parseJson<{
    messages: Array<{
      id: string;
      from: string;
      fromDeviceId: string;
      to: string;
      body: string;
      ts: number;
      readAt?: number;
    }>;
  }>(await fetch(`${API_BASE}/api/messages?u=${encodeURIComponent(username)}`, {
    headers: authHeaders(token, deviceId),
  }));
  return json.messages;
}

export async function apiGetSession(token: string, peer: string) {
  return parseJson<SessionInfo>(await fetch(`${API_BASE}/api/sessions?u=${encodeURIComponent(peer)}`, {
    headers: authHeaders(token),
  }));
}

export async function apiGetIncomingSessions(token: string) {
  const json = await parseJson<{ sessions: SessionInfo[] }>(await fetch(`${API_BASE}/api/sessions/incoming`, {
    headers: authHeaders(token),
  }));
  return json.sessions;
}

export async function apiRequestSession(token: string, peer: string) {
  return parseJson<SessionInfo>(await fetch(`${API_BASE}/api/sessions/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify({ peer }),
  }));
}

export async function apiRespondSession(token: string, peer: string, action: "accept" | "decline") {
  return parseJson<SessionInfo>(await fetch(`${API_BASE}/api/sessions/respond`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify({ peer, action }),
  }));
}

export async function apiEndSession(token: string, peer: string) {
  return parseJson<SessionInfo>(await fetch(`${API_BASE}/api/sessions/end`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify({ peer }),
  }));
}

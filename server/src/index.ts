import "dotenv/config";
import http from "http";
import { randomBytes, randomUUID } from "crypto";
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import { z } from "zod";
import { WebSocketServer, WebSocket } from "ws";

import prisma from "./db";
import { signToken, verifyToken } from "./jwt";
import { log, replyError, requestLogger } from "./logger";
import { metricsSnapshot } from "./monitoring";
import { ClientMsg, DeviceEnvelope, MsgDeliverEvent, ServerMsg, SessionStatus, SessionUpdateEvent } from "./types";

type PeerSessionRow = {
  id: string;
  peerKey: string;
  userA: string;
  userB: string;
  requestedBy: string;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
};

type UserDeviceRow = {
  id: string;
  userUsername: string;
  deviceId: string;
  deviceLabel: string;
  publicKeyJwk: unknown | null;
  notificationsEnabled: boolean;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type MessageEnvelopeRow = {
  id: string;
  msgId: string;
  ownerUsername: string;
  deviceId: string;
  bodyCiphertext: string;
  deliveredAt: Date | null;
  createdAt: Date;
  messageId: string;
  fromUser: string;
  fromDeviceId: string;
  toUser: string;
  ts: Date;
  readAt: Date | null;
  convKey: string;
};

const USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_ENDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const app = express();
app.use(cors({ origin: true }));
app.use(requestLogger);
app.use(express.json());

const AuthSchema = z.object({
  username: z.string().min(3).max(32).regex(USERNAME_REGEX),
  password: z.string().min(6).max(128),
});

const ResetPasswordSchema = z.object({
  username: z.string().min(3).max(32).regex(USERNAME_REGEX),
  recoveryCode: z.string().min(6).max(64),
  newPassword: z.string().min(6).max(128),
});

const SessionPeerSchema = z.object({
  peer: z.string().min(3).max(32).regex(USERNAME_REGEX),
});

const SessionRespondSchema = SessionPeerSchema.extend({
  action: z.enum(["accept", "decline"]),
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Map<string, Map<string, WebSocket>>();
let lastSessionCleanupAt: number | null = null;
let lastSessionCleanupResult = { expiredPending: 0, purgedEnded: 0 };

function activeClientCount() {
  let count = 0;
  for (const deviceSockets of clients.values()) {
    for (const client of deviceSockets.values()) {
      if (client.readyState === WebSocket.OPEN) count += 1;
    }
  }
  return count;
}

function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}

function makePeerKey(a: string, b: string) {
  return [normalizeUsername(a), normalizeUsername(b)].sort().join("|");
}

function peerFromSession(me: string, session: PeerSessionRow) {
  return session.userA === me ? session.userB : session.userA;
}

function normalizeRecoveryCode(value: string) {
  return value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function makeRecoveryCode() {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]);
  return [chars.slice(0, 4).join(""), chars.slice(4, 8).join(""), chars.slice(8, 12).join("")].join("-");
}

function send(ws: WebSocket, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
}

function userSockets(username: string) {
  return clients.get(username) ?? new Map<string, WebSocket>();
}

function isUserOnline(username: string) {
  for (const socket of userSockets(username).values()) {
    if (socket.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

function sendToDevice(username: string, deviceId: string, msg: ServerMsg) {
  const ws = userSockets(username).get(deviceId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  send(ws, msg);
}

function sendToUser(username: string, msg: ServerMsg, exceptDeviceId?: string) {
  for (const [deviceId, ws] of userSockets(username).entries()) {
    if (exceptDeviceId && deviceId === exceptDeviceId) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    send(ws, msg);
  }
}

function setClient(username: string, deviceId: string, ws: WebSocket) {
  const sockets = clients.get(username) ?? new Map<string, WebSocket>();
  sockets.set(deviceId, ws);
  clients.set(username, sockets);
}

function deleteClient(username: string, deviceId: string, ws: WebSocket) {
  const sockets = clients.get(username);
  if (!sockets) return;
  if (sockets.get(deviceId) === ws) {
    sockets.delete(deviceId);
  }
  if (!sockets.size) {
    clients.delete(username);
  }
}

function broadcast(msg: ServerMsg, exceptUser?: string) {
  for (const [username, sockets] of clients.entries()) {
    if (exceptUser && username === exceptUser) continue;
    for (const client of sockets.values()) {
      if (client.readyState !== WebSocket.OPEN) continue;
      send(client, msg);
    }
  }
}

function bearerUser(req: express.Request): string | null {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    return normalizeUsername(verifyToken(token).username);
  } catch {
    return null;
  }
}

function requestDeviceId(req: express.Request) {
  const value = String(req.header("x-zchat-device-id") || "").trim();
  return value || null;
}

async function fetchPeerSession(me: string, peer: string) {
  const rows = await prisma.$queryRawUnsafe<PeerSessionRow[]>(
    `SELECT * FROM "PeerSession" WHERE "peerKey" = $1 LIMIT 1`,
    makePeerKey(me, peer)
  );
  return rows[0] ?? null;
}

async function listIncomingSessions(me: string) {
  return prisma.$queryRawUnsafe<PeerSessionRow[]>(
    `SELECT *
     FROM "PeerSession"
     WHERE "status" = 'pending'
       AND "requestedBy" <> $1
       AND ("userA" = $1 OR "userB" = $1)
     ORDER BY "updatedAt" DESC`,
    me
  );
}

async function upsertPendingSession(me: string, peer: string) {
  const peerKey = makePeerKey(me, peer);
  const [userA, userB] = peerKey.split("|");
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PeerSession" ("id", "peerKey", "userA", "userB", "requestedBy", "status", "createdAt", "updatedAt", "endedAt")
     VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
     ON CONFLICT ("peerKey") DO UPDATE
     SET "requestedBy" = EXCLUDED."requestedBy",
         "status" = 'pending',
         "endedAt" = NULL,
         "updatedAt" = CURRENT_TIMESTAMP`,
    randomUUID(),
    peerKey,
    userA,
    userB,
    me
  );

  const session = await fetchPeerSession(me, peer);
  if (!session) throw new Error("Failed to upsert peer session");
  return session;
}

async function setSessionStatus(me: string, peer: string, status: SessionStatus) {
  await prisma.$executeRawUnsafe(
    `UPDATE "PeerSession"
     SET "status" = $1,
         "endedAt" = CASE WHEN $1 = 'ended' THEN CURRENT_TIMESTAMP ELSE NULL END,
         "updatedAt" = CURRENT_TIMESTAMP
     WHERE "peerKey" = $2`,
    status,
    makePeerKey(me, peer)
  );

  return fetchPeerSession(me, peer);
}

function buildSessionEvent(me: string, session: PeerSessionRow): SessionUpdateEvent {
  return {
    kind: "session_update",
    ts: Date.now(),
    peer: peerFromSession(me, session),
    status: session.status,
    requestedBy: session.requestedBy,
    createdAt: new Date(session.createdAt).getTime(),
    updatedAt: new Date(session.updatedAt).getTime(),
  };
}

function notifySessionUsers(session: PeerSessionRow) {
  sendToUser(session.userA, buildSessionEvent(session.userA, session));
  sendToUser(session.userB, buildSessionEvent(session.userB, session));
}

async function expirePendingSessions(cutoff: Date) {
  const expired = await prisma.$queryRawUnsafe<PeerSessionRow[]>(
    `UPDATE "PeerSession"
     SET "status" = 'ended',
         "endedAt" = CURRENT_TIMESTAMP,
         "updatedAt" = CURRENT_TIMESTAMP
     WHERE "status" = 'pending'
       AND "updatedAt" < $1
     RETURNING *`,
    cutoff
  );

  for (const session of expired) {
    notifySessionUsers(session);
  }

  return expired.length;
}

async function purgeEndedSessions(cutoff: Date) {
  const deleted = await prisma.$executeRawUnsafe(
    `DELETE FROM "PeerSession"
     WHERE "status" = 'ended'
       AND COALESCE("endedAt", "updatedAt") < $1`,
    cutoff
  );
  return Number(deleted ?? 0);
}

async function cleanupSessions() {
  const pendingCutoff = new Date(Date.now() - SESSION_PENDING_TTL_MS);
  const endedCutoff = new Date(Date.now() - SESSION_ENDED_RETENTION_MS);
  const expiredPending = await expirePendingSessions(pendingCutoff);
  const purgedEnded = await purgeEndedSessions(endedCutoff);
  lastSessionCleanupAt = Date.now();
  lastSessionCleanupResult = { expiredPending, purgedEnded };
  if (expiredPending || purgedEnded) {
    log("info", "session.cleanup", { expiredPending, purgedEnded });
  }
  return lastSessionCleanupResult;
}

async function ensureConversation(convKey: string) {
  const [userA, userB] = convKey.split("|");
  return prisma.conversation.upsert({
    where: { convKey },
    create: { convKey, userA, userB },
    update: {},
  });
}

async function isSessionActive(me: string, peer: string) {
  const session = await fetchPeerSession(me, peer);
  return session?.status === "active";
}

async function userExists(username: string) {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { username: true },
  });
  return Boolean(user);
}

async function upsertUserDevice(
  username: string,
  deviceId: string,
  deviceLabel: string,
  publicKeyJwk?: unknown,
  notificationsEnabled?: boolean
) {
  const rows = await prisma.$queryRawUnsafe<UserDeviceRow[]>(
    `INSERT INTO "UserDevice" ("id", "userUsername", "deviceId", "deviceLabel", "publicKeyJwk", "notificationsEnabled", "lastSeenAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT ("deviceId") DO UPDATE
     SET "userUsername" = EXCLUDED."userUsername",
         "deviceLabel" = EXCLUDED."deviceLabel",
         "publicKeyJwk" = EXCLUDED."publicKeyJwk",
         "notificationsEnabled" = EXCLUDED."notificationsEnabled",
         "lastSeenAt" = CURRENT_TIMESTAMP,
         "updatedAt" = CURRENT_TIMESTAMP
     RETURNING *`,
    randomUUID(),
    username,
    deviceId,
    deviceLabel,
    JSON.stringify(publicKeyJwk ?? null),
    notificationsEnabled ?? false
  );
  return rows[0];
}

async function touchUserDevice(username: string, deviceId: string) {
  return prisma.$executeRawUnsafe(
    `UPDATE "UserDevice"
     SET "lastSeenAt" = CURRENT_TIMESTAMP,
         "updatedAt" = CURRENT_TIMESTAMP
     WHERE "userUsername" = $1 AND "deviceId" = $2`,
    username,
    deviceId
  );
}

async function getUserDevices(username: string) {
  return prisma.$queryRawUnsafe<UserDeviceRow[]>(
    `SELECT *
     FROM "UserDevice"
     WHERE "userUsername" = $1
     ORDER BY "lastSeenAt" DESC, "createdAt" ASC`,
    username
  );
}

async function getUserDevice(username: string, deviceId: string) {
  const rows = await prisma.$queryRawUnsafe<UserDeviceRow[]>(
    `SELECT *
     FROM "UserDevice"
     WHERE "userUsername" = $1 AND "deviceId" = $2
     LIMIT 1`,
    username,
    deviceId
  );
  return rows[0] ?? null;
}

function serializeDevice(device: UserDeviceRow) {
  return {
    deviceId: device.deviceId,
    deviceLabel: device.deviceLabel,
    publicKeyJwk: device.publicKeyJwk,
    notificationsEnabled: device.notificationsEnabled,
    online: isUserOnline(device.userUsername) && userSockets(device.userUsername).has(device.deviceId),
    lastSeenAt: device.lastSeenAt.getTime(),
    updatedAt: device.updatedAt.getTime(),
    createdAt: device.createdAt.getTime(),
  };
}

app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    uptimeSec: Math.floor(process.uptime()),
    wsClients: activeClientCount(),
    sessionCleanup: {
      lastRunAt: lastSessionCleanupAt,
      ...lastSessionCleanupResult,
    },
    metricsUptimeSec: metricsSnapshot().uptimeSec,
  });
});

app.get("/metrics", (req, res) => {
  const metricsToken = process.env.METRICS_TOKEN;
  const provided = String(req.header("x-metrics-token") || "").trim();
  if (metricsToken && provided !== metricsToken) {
    return replyError(req, res, 401, "Unauthorized");
  }

  return res.json(metricsSnapshot());
});

app.post("/api/register", async (req, res) => {
  try {
    const parsed = AuthSchema.safeParse(req.body);
    if (!parsed.success) return replyError(req, res, 400, "Invalid input");

    const username = normalizeUsername(parsed.data.username);
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return replyError(req, res, 409, "Username already taken", { username });

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const recoveryCode = makeRecoveryCode();
    const recoveryCodeHash = await bcrypt.hash(normalizeRecoveryCode(recoveryCode), 12);

    await prisma.user.create({ data: { username, passwordHash } });
    await prisma.$executeRawUnsafe(
      `UPDATE "User" SET "recoveryCodeHash" = $1 WHERE "username" = $2`,
      recoveryCodeHash,
      username
    );

    const token = signToken(username);
    log("info", "auth.register.success", { username });
    return res.json({ token, username, recoveryCode });
  } catch (error) {
    log("error", "auth.register.failure", { error: error instanceof Error ? error.message : String(error) });
    return replyError(req, res, 500, "Server error");
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const parsed = AuthSchema.safeParse(req.body);
    if (!parsed.success) return replyError(req, res, 400, "Invalid input");

    const username = normalizeUsername(parsed.data.username);
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return replyError(req, res, 401, "Invalid credentials", { username });

    const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!ok) return replyError(req, res, 401, "Invalid credentials", { username });

    await prisma.user.update({ where: { username }, data: { lastSeenAt: new Date() } });

    const token = signToken(username);
    log("info", "auth.login.success", { username });
    return res.json({ token, username });
  } catch (error) {
    log("error", "auth.login.failure", { error: error instanceof Error ? error.message : String(error) });
    return replyError(req, res, 500, "Server error");
  }
});

app.post("/api/password/reset", async (req, res) => {
  try {
    const parsed = ResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) return replyError(req, res, 400, "Invalid input");

    const username = normalizeUsername(parsed.data.username);
    const rows = await prisma.$queryRawUnsafe<Array<{ recoveryCodeHash: string | null }>>(
      `SELECT "recoveryCodeHash" FROM "User" WHERE "username" = $1 LIMIT 1`,
      username
    );
    const recoveryCodeHash = rows[0]?.recoveryCodeHash;
    if (!recoveryCodeHash) return replyError(req, res, 401, "Invalid recovery code", { username });

    const ok = await bcrypt.compare(normalizeRecoveryCode(parsed.data.recoveryCode), recoveryCodeHash);
    if (!ok) return replyError(req, res, 401, "Invalid recovery code", { username });

    const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
    await prisma.user.update({ where: { username }, data: { passwordHash } });

    log("info", "auth.password_reset.success", { username });
    return res.json({ ok: true });
  } catch (error) {
    log("error", "auth.password_reset.failure", { error: error instanceof Error ? error.message : String(error) });
    return replyError(req, res, 500, "Server error");
  }
});

app.get("/api/users/search", async (req, res) => {
  const q = normalizeUsername(String(req.query.q ?? ""));
  if (!q) return res.json({ users: [] });

  const users = await prisma.user.findMany({
    where: { username: { contains: q } },
    select: { username: true, lastSeenAt: true },
    take: 20,
  });

  return res.json({
    users: users.map((user) => ({
      username: user.username,
      lastSeenAt: user.lastSeenAt.getTime(),
    })),
  });
});

app.get("/api/users/status", async (req, res) => {
  const username = normalizeUsername(String(req.query.u ?? ""));
  if (!username) return replyError(req, res, 400, "Missing u");

  const user = await prisma.user.findUnique({
    where: { username },
    select: { lastSeenAt: true },
  });

  return res.json({
    username,
    online: isUserOnline(username),
    lastSeenAt: user?.lastSeenAt ? user.lastSeenAt.getTime() : undefined,
  });
});

app.get("/api/devices", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return replyError(req, res, 401, "Unauthorized");

  const username = normalizeUsername(String(req.query.u ?? ""));
  if (!username) return replyError(req, res, 400, "Missing u");

  const devices = await getUserDevices(username);
  return res.json({ username, devices: devices.map(serializeDevice) });
});

app.get("/api/devices/me", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return replyError(req, res, 401, "Unauthorized");

  const devices = await getUserDevices(me);
  return res.json({ username: me, currentDeviceId: requestDeviceId(req), devices: devices.map(serializeDevice) });
});

app.post("/api/devices/upsert", async (req, res) => {
  const username = bearerUser(req);
  if (!username) return replyError(req, res, 401, "Unauthorized");

  const deviceId = String(req.body?.deviceId || "").trim();
  const deviceLabel = String(req.body?.deviceLabel || "").trim();
  const publicKeyJwk = req.body?.publicKeyJwk;
  const notificationsEnabled = Boolean(req.body?.notificationsEnabled);

  if (!deviceId) return replyError(req, res, 400, "Missing deviceId");
  if (!deviceLabel) return replyError(req, res, 400, "Missing deviceLabel");

  const device = await upsertUserDevice(username, deviceId, deviceLabel, publicKeyJwk, notificationsEnabled);
  log("info", "device.upsert", { username, deviceId, notificationsEnabled });
  return res.json({ ok: true, device: serializeDevice(device) });
});

app.post("/api/devices/notifications", async (req, res) => {
  const username = bearerUser(req);
  if (!username) return replyError(req, res, 401, "Unauthorized");

  const deviceId = String(req.body?.deviceId || "").trim();
  if (!deviceId) return replyError(req, res, 400, "Missing deviceId");

  await prisma.$executeRawUnsafe(
    `UPDATE "UserDevice"
     SET "notificationsEnabled" = $1,
         "lastSeenAt" = CURRENT_TIMESTAMP,
         "updatedAt" = CURRENT_TIMESTAMP
     WHERE "userUsername" = $2 AND "deviceId" = $3`,
    Boolean(req.body?.notificationsEnabled),
    username,
    deviceId
  );

  log("info", "device.notifications.updated", {
    username,
    deviceId,
    notificationsEnabled: Boolean(req.body?.notificationsEnabled),
  });
  return res.json({ ok: true });
});

app.post("/api/keys/set", async (req, res) => {
  const username = bearerUser(req);
  if (!username) return replyError(req, res, 401, "Unauthorized");
  const deviceId = requestDeviceId(req);
  if (!deviceId) return replyError(req, res, 400, "Missing deviceId");

  const publicKeyJwk = req.body?.publicKeyJwk;
  if (!publicKeyJwk) return replyError(req, res, 400, "Missing publicKeyJwk");
  const deviceLabel = String(req.body?.deviceLabel || "").trim() || "Unknown device";

  await prisma.user.update({
    where: { username },
    data: { publicKeyJwk, keyUpdatedAt: new Date() },
  });
  await upsertUserDevice(username, deviceId, deviceLabel, publicKeyJwk, Boolean(req.body?.notificationsEnabled));

  log("info", "keys.set", { username });
  return res.json({ ok: true });
});

app.get("/api/keys/get", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return replyError(req, res, 401, "Unauthorized");
  const username = normalizeUsername(String(req.query.u ?? ""));
  if (!username) return replyError(req, res, 400, "Missing u");

  const devices = await getUserDevices(username);

  return res.json({
    username,
    devices: devices.map(serializeDevice),
    publicKeyJwk: devices[0]?.publicKeyJwk ?? null,
    keyUpdatedAt: devices[0]?.updatedAt ? devices[0].updatedAt.getTime() : undefined,
  });
});

app.get("/api/messages", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return replyError(req, res, 401, "Unauthorized");
  const deviceId = requestDeviceId(req);
  if (!deviceId) return replyError(req, res, 400, "Missing deviceId");

  const other = normalizeUsername(String(req.query.u ?? ""));
  if (!other) return replyError(req, res, 400, "Missing u");

  const convKey = makePeerKey(me, other);
  const envelopes = await prisma.$queryRawUnsafe<MessageEnvelopeRow[]>(
    `SELECT
        e."id",
        e."msgId",
        e."ownerUsername",
        e."deviceId",
        e."bodyCiphertext",
        e."deliveredAt",
        e."createdAt",
        m."id" AS "messageId",
        m."fromUser",
        m."fromDeviceId",
        m."toUser",
        m."ts",
        m."readAt",
        c."convKey"
     FROM "MessageEnvelope" e
     JOIN "Message" m ON m."id" = e."msgId"
     JOIN "Conversation" c ON c."id" = m."convId"
     WHERE e."ownerUsername" = $1
       AND e."deviceId" = $2
       AND c."convKey" = $3
     ORDER BY m."ts" ASC
     LIMIT 200`,
    me,
    deviceId,
    convKey
  );

  return res.json({
    messages: envelopes.map((envelope) => ({
      id: envelope.messageId,
      from: envelope.fromUser,
      fromDeviceId: envelope.fromDeviceId,
      to: envelope.toUser,
      body: envelope.bodyCiphertext,
      ts: envelope.ts.getTime(),
      readAt: envelope.readAt ? envelope.readAt.getTime() : undefined,
    })),
  });
});

app.get("/api/sessions", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return replyError(req, res, 401, "Unauthorized");

  const peer = normalizeUsername(String(req.query.u ?? ""));
  if (!peer) return replyError(req, res, 400, "Missing u");

  const session = await fetchPeerSession(me, peer);
  if (!session) {
    return res.json({ peer, status: "none", requestedBy: null });
  }

  return res.json(buildSessionEvent(me, session));
});

app.get("/api/sessions/incoming", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return replyError(req, res, 401, "Unauthorized");

  const sessions = await listIncomingSessions(me);
  return res.json({ sessions: sessions.map((session) => buildSessionEvent(me, session)) });
});

app.post("/api/sessions/request", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return replyError(req, res, 401, "Unauthorized");

  const parsed = SessionPeerSchema.safeParse(req.body);
  if (!parsed.success) return replyError(req, res, 400, "Invalid peer");

  const peer = normalizeUsername(parsed.data.peer);
  if (peer === me) return replyError(req, res, 400, "Choose a different peer", { username: me });
  if (!(await userExists(peer))) return replyError(req, res, 404, "Peer not found", { username: me, peer });

  const session = await upsertPendingSession(me, peer);
  notifySessionUsers(session);
  log("info", "session.requested", { username: me, peer, requestedBy: me });
  return res.json(buildSessionEvent(me, session));
});

app.post("/api/sessions/respond", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return replyError(req, res, 401, "Unauthorized");

  const parsed = SessionRespondSchema.safeParse(req.body);
  if (!parsed.success) return replyError(req, res, 400, "Invalid session response");

  const peer = normalizeUsername(parsed.data.peer);
  const session = await fetchPeerSession(me, peer);
  if (!session || session.status !== "pending") return replyError(req, res, 404, "No pending request", { username: me, peer });
  if (session.requestedBy === me) return replyError(req, res, 400, "Requester cannot respond", { username: me, peer });

  const nextStatus: SessionStatus = parsed.data.action === "accept" ? "active" : "ended";
  const updated = await setSessionStatus(me, peer, nextStatus);
  if (!updated) return replyError(req, res, 404, "Session not found", { username: me, peer });

  notifySessionUsers(updated);
  log("info", "session.responded", { username: me, peer, action: parsed.data.action, status: updated.status });
  return res.json(buildSessionEvent(me, updated));
});

app.post("/api/sessions/end", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return replyError(req, res, 401, "Unauthorized");

  const parsed = SessionPeerSchema.safeParse(req.body);
  if (!parsed.success) return replyError(req, res, 400, "Invalid peer");

  const peer = normalizeUsername(parsed.data.peer);
  const updated = await setSessionStatus(me, peer, "ended");
  if (!updated) return replyError(req, res, 404, "Session not found", { username: me, peer });

  notifySessionUsers(updated);
  log("info", "session.ended", { username: me, peer });
  return res.json(buildSessionEvent(me, updated));
});

app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log("error", "http.unhandled_error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return replyError(req, res, 500, "Server error");
});

wss.on("connection", (ws) => {
  let authedUser: string | null = null;
  let authedDeviceId: string | null = null;
  const connectionId = randomUUID();
  log("info", "ws.connection.opened", { connectionId, wsClients: activeClientCount() + 1 });

  ws.on("message", async (buf) => {
    let data: ClientMsg | any;
    try {
      data = JSON.parse(buf.toString());
    } catch {
      log("warn", "ws.invalid_json", { connectionId });
      return send(ws, { kind: "error", ts: Date.now(), message: "Invalid JSON" });
    }

    if (!authedUser || !authedDeviceId) {
      if (data?.kind !== "auth" || !data?.token || !data?.deviceId) {
        log("warn", "ws.auth.required", { connectionId });
        send(ws, { kind: "error", ts: Date.now(), message: "Auth required" });
        ws.close();
        return;
      }

      try {
        authedUser = normalizeUsername(verifyToken(data.token).username);
        authedDeviceId = String(data.deviceId).trim();
        const device = await getUserDevice(authedUser, authedDeviceId);
        if (!device) {
          log("warn", "ws.auth.unknown_device", { connectionId, username: authedUser, deviceId: authedDeviceId });
          send(ws, { kind: "error", ts: Date.now(), message: "Device not registered" });
          ws.close();
          return;
        }

        const existing = userSockets(authedUser).get(authedDeviceId);
        if (existing && existing.readyState === WebSocket.OPEN) {
          send(existing, { kind: "error", ts: Date.now(), message: "This device connected elsewhere. Disconnecting old socket." });
          existing.close();
          log("warn", "ws.session.replaced", { connectionId, username: authedUser, deviceId: authedDeviceId });
        }

        setClient(authedUser, authedDeviceId, ws);
        const now = new Date();
        await prisma.user.update({ where: { username: authedUser }, data: { lastSeenAt: now } });
        await touchUserDevice(authedUser, authedDeviceId);

        log("info", "ws.auth.success", {
          connectionId,
          username: authedUser,
          deviceId: authedDeviceId,
          wsClients: activeClientCount(),
        });
        send(ws, { kind: "authed", ts: now.getTime(), username: authedUser });

        for (const username of clients.keys()) {
          if (username === authedUser || !isUserOnline(username)) continue;
          send(ws, { kind: "presence", ts: now.getTime(), username, online: true });
        }

        broadcast(
          { kind: "presence", ts: now.getTime(), username: authedUser, online: true, lastSeenAt: now.getTime() },
          authedUser
        );

        const undelivered = await prisma.$queryRawUnsafe<MessageEnvelopeRow[]>(
          `SELECT
              e."id",
              e."msgId",
              e."ownerUsername",
              e."deviceId",
              e."bodyCiphertext",
              e."deliveredAt",
              e."createdAt",
              m."id" AS "messageId",
              m."fromUser",
              m."fromDeviceId",
              m."toUser",
              m."ts",
              m."readAt",
              c."convKey"
           FROM "MessageEnvelope" e
           JOIN "Message" m ON m."id" = e."msgId"
           JOIN "Conversation" c ON c."id" = m."convId"
           WHERE e."ownerUsername" = $1
             AND e."deviceId" = $2
             AND e."deliveredAt" IS NULL
           ORDER BY m."ts" ASC
           LIMIT 200`,
          authedUser,
          authedDeviceId
        );

        for (const envelope of undelivered) {
          const deliver: MsgDeliverEvent = {
            kind: "msg_deliver",
            from: envelope.fromUser,
            fromDeviceId: envelope.fromDeviceId,
            to: envelope.toUser,
            ts: envelope.ts.getTime(),
            convId: envelope.convKey,
            msgId: envelope.messageId,
            body: envelope.bodyCiphertext,
            deliveredAt: Date.now(),
          };
          send(ws, deliver);
          await prisma.$executeRawUnsafe(
            `UPDATE "MessageEnvelope" SET "deliveredAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
            envelope.id
          );
        }

        return;
      } catch {
        log("warn", "ws.auth.invalid_token", { connectionId });
        send(ws, { kind: "error", ts: Date.now(), message: "Invalid token" });
        ws.close();
        return;
      }
    }

    data.from = authedUser;
    data.fromDeviceId = authedDeviceId;
    const to = normalizeUsername(String(data.to ?? ""));
    if (!to) return send(ws, { kind: "error", ts: Date.now(), message: "Missing 'to'" });

    if (data.kind === "msg_send") {
      if (!(await isSessionActive(authedUser, to))) {
        log("warn", "message.blocked.no_active_session", { connectionId, username: authedUser, peer: to, deviceId: authedDeviceId });
        return send(ws, { kind: "error", ts: Date.now(), message: "Chat session not active" });
      }

      const convKey = String(data.convId || makePeerKey(authedUser, to));
      const conv = await ensureConversation(convKey);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Message" ("id", "convId", "fromUser", "fromDeviceId", "toUser", "bodyCiphertext", "ts")
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)`,
        data.msgId,
        conv.id,
        authedUser,
        authedDeviceId,
        to,
        data.envelopes[0]?.body || ""
      );

      for (const envelope of data.envelopes as DeviceEnvelope[]) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "MessageEnvelope" ("id", "msgId", "ownerUsername", "deviceId", "bodyCiphertext", "createdAt")
           VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
          randomUUID(),
          data.msgId,
          normalizeUsername(envelope.username),
          envelope.deviceId,
          envelope.body
        );
      }

      let deliveredLive = false;
      for (const envelope of data.envelopes as DeviceEnvelope[]) {
        const targetUsername = normalizeUsername(envelope.username);
        const targetSocket = userSockets(targetUsername).get(envelope.deviceId);
        if (!targetSocket || targetSocket.readyState !== WebSocket.OPEN) continue;
        send(targetSocket, {
          kind: "msg_deliver",
          from: authedUser,
          fromDeviceId: authedDeviceId,
          to,
          ts: Date.now(),
          convId: convKey,
          msgId: data.msgId,
          body: envelope.body,
          deliveredAt: Date.now(),
        });
        deliveredLive = true;
        await prisma.$executeRawUnsafe(
          `UPDATE "MessageEnvelope"
           SET "deliveredAt" = CURRENT_TIMESTAMP
           WHERE "msgId" = $1 AND "deviceId" = $2 AND "ownerUsername" = $3`,
          data.msgId,
          envelope.deviceId,
          targetUsername
        );
      }
      if (deliveredLive) {
        await prisma.message.update({ where: { id: data.msgId }, data: { deliveredAt: new Date() } });
      }
      log("info", "message.sent", {
        connectionId,
        username: authedUser,
        deviceId: authedDeviceId,
        peer: to,
        convId: convKey,
        msgId: data.msgId,
        deliveredLive,
        envelopes: data.envelopes.length,
      });
      return;
    }

    if (data.kind === "msg_read") {
      await prisma.message.update({
        where: { id: data.msgId },
        data: { readAt: new Date(data.readAt) },
      });

      sendToUser(to, { ...data, ts: Date.now(), fromDeviceId: authedDeviceId });
      log("info", "message.read", {
        connectionId,
        username: authedUser,
        deviceId: authedDeviceId,
        peer: to,
        convId: data.convId,
        msgId: data.msgId,
      });
      return;
    }

    if (data.kind === "draft_update" || data.kind === "draft_clear") {
      if (!(await isSessionActive(authedUser, to))) {
        log("warn", "draft.blocked.no_active_session", { connectionId, username: authedUser, peer: to, deviceId: authedDeviceId });
        return send(ws, { kind: "error", ts: Date.now(), message: "Chat session not active" });
      }

        if (data.kind === "draft_update") {
          for (const envelope of data.envelopes) {
            sendToDevice(to, envelope.deviceId, {
              kind: "draft_update",
              from: authedUser,
              fromDeviceId: authedDeviceId,
              to,
              ts: Date.now(),
              convId: data.convId,
              draftId: data.draftId,
              seq: data.seq,
              body: envelope.body,
              envelopes: [{ deviceId: envelope.deviceId, body: envelope.body }],
              cursor: data.cursor,
              expiresInMs: data.expiresInMs,
            });
          }
      } else {
        sendToUser(to, { ...data, to, ts: Date.now(), fromDeviceId: authedDeviceId });
        log("info", "draft.cleared", { connectionId, username: authedUser, deviceId: authedDeviceId, peer: to, convId: data.convId });
      }
      return;
    }

    log("warn", "ws.unknown_event_kind", { connectionId, username: authedUser, deviceId: authedDeviceId, kind: data?.kind });
    return send(ws, { kind: "error", ts: Date.now(), message: "Unknown event kind" });
  });

  ws.on("close", () => {
    if (authedUser && authedDeviceId) deleteClient(authedUser, authedDeviceId, ws);
    if (authedUser) {
      const now = new Date();
      prisma.user.update({ where: { username: authedUser }, data: { lastSeenAt: now } }).catch(() => undefined);
      touchUserDevice(authedUser, authedDeviceId || "").catch(() => undefined);
      broadcast({ kind: "presence", ts: now.getTime(), username: authedUser, online: isUserOnline(authedUser), lastSeenAt: now.getTime() });
      log("info", "ws.connection.closed", {
        connectionId,
        username: authedUser,
        deviceId: authedDeviceId,
        wsClients: activeClientCount(),
      });
      return;
    }
    log("info", "ws.connection.closed", { connectionId, wsClients: activeClientCount() });
  });

  ws.on("error", (error) => {
    log("error", "ws.connection.error", {
      connectionId,
      username: authedUser,
      deviceId: authedDeviceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

const PORT = Number(process.env.PORT || 8080);
cleanupSessions().catch((error) => {
  log("error", "session.cleanup.failure", { error: error instanceof Error ? error.message : String(error) });
});

setInterval(() => {
  cleanupSessions().catch((error) => {
    log("error", "session.cleanup.failure", { error: error instanceof Error ? error.message : String(error) });
  });
}, SESSION_CLEANUP_INTERVAL_MS).unref();

process.on("unhandledRejection", (error) => {
  log("error", "process.unhandled_rejection", {
    error: error instanceof Error ? error.message : String(error),
  });
});

process.on("uncaughtException", (error) => {
  log("error", "process.uncaught_exception", { error: error.message, stack: error.stack });
});

server.listen(PORT, "0.0.0.0", () => {
  log("info", "server.started", { port: PORT });
});

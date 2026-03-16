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
import { ClientMsg, MsgDeliverEvent, ServerMsg, SessionStatus, SessionUpdateEvent } from "./types";

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

const USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

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
const clients = new Map<string, WebSocket>();

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

function sendToUser(username: string, msg: ServerMsg) {
  const ws = clients.get(username);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  send(ws, msg);
}

function broadcast(msg: ServerMsg, exceptUser?: string) {
  for (const [username, client] of clients.entries()) {
    if (exceptUser && username === exceptUser) continue;
    if (client.readyState !== WebSocket.OPEN) continue;
    send(client, msg);
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

app.post("/api/register", async (req, res) => {
  try {
    const parsed = AuthSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

    const username = normalizeUsername(parsed.data.username);
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return res.status(409).json({ error: "Username already taken" });

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
    return res.json({ token, username, recoveryCode });
  } catch (error) {
    console.error("REGISTER 500:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const parsed = AuthSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

    const username = normalizeUsername(parsed.data.username);
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    await prisma.user.update({ where: { username }, data: { lastSeenAt: new Date() } });

    const token = signToken(username);
    return res.json({ token, username });
  } catch (error) {
    console.error("LOGIN 500:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/password/reset", async (req, res) => {
  try {
    const parsed = ResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

    const username = normalizeUsername(parsed.data.username);
    const rows = await prisma.$queryRawUnsafe<Array<{ recoveryCodeHash: string | null }>>(
      `SELECT "recoveryCodeHash" FROM "User" WHERE "username" = $1 LIMIT 1`,
      username
    );
    const recoveryCodeHash = rows[0]?.recoveryCodeHash;
    if (!recoveryCodeHash) return res.status(401).json({ error: "Invalid recovery code" });

    const ok = await bcrypt.compare(normalizeRecoveryCode(parsed.data.recoveryCode), recoveryCodeHash);
    if (!ok) return res.status(401).json({ error: "Invalid recovery code" });

    const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
    await prisma.user.update({ where: { username }, data: { passwordHash } });

    return res.json({ ok: true });
  } catch (error) {
    console.error("PASSWORD RESET 500:", error);
    return res.status(500).json({ error: "Server error" });
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
  if (!username) return res.status(400).json({ error: "Missing u" });

  const user = await prisma.user.findUnique({
    where: { username },
    select: { lastSeenAt: true },
  });

  return res.json({
    username,
    online: clients.get(username)?.readyState === WebSocket.OPEN,
    lastSeenAt: user?.lastSeenAt ? user.lastSeenAt.getTime() : undefined,
  });
});

app.post("/api/keys/set", async (req, res) => {
  const username = bearerUser(req);
  if (!username) return res.status(401).json({ error: "Unauthorized" });

  const publicKeyJwk = req.body?.publicKeyJwk;
  if (!publicKeyJwk) return res.status(400).json({ error: "Missing publicKeyJwk" });

  await prisma.user.update({
    where: { username },
    data: { publicKeyJwk, keyUpdatedAt: new Date() },
  });

  return res.json({ ok: true });
});

app.get("/api/keys/get", async (req, res) => {
  const username = normalizeUsername(String(req.query.u ?? ""));
  if (!username) return res.status(400).json({ error: "Missing u" });

  const user = await prisma.user.findUnique({
    where: { username },
    select: { publicKeyJwk: true, keyUpdatedAt: true },
  });

  return res.json({
    username,
    publicKeyJwk: user?.publicKeyJwk ?? null,
    keyUpdatedAt: user?.keyUpdatedAt ? user.keyUpdatedAt.getTime() : undefined,
  });
});

app.get("/api/messages", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return res.status(401).json({ error: "Unauthorized" });

  const other = normalizeUsername(String(req.query.u ?? ""));
  if (!other) return res.status(400).json({ error: "Missing u" });

  const convKey = makePeerKey(me, other);
  const conv = await prisma.conversation.findUnique({
    where: { convKey },
    include: {
      messages: {
        orderBy: { ts: "asc" },
        take: 200,
      },
    },
  });

  return res.json({
    messages: (conv?.messages ?? []).map((message) => ({
      id: message.id,
      from: message.fromUser,
      to: message.toUser,
      body: message.bodyCiphertext,
      ts: message.ts.getTime(),
      readAt: message.readAt ? message.readAt.getTime() : undefined,
    })),
  });
});

app.get("/api/sessions", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return res.status(401).json({ error: "Unauthorized" });

  const peer = normalizeUsername(String(req.query.u ?? ""));
  if (!peer) return res.status(400).json({ error: "Missing u" });

  const session = await fetchPeerSession(me, peer);
  if (!session) {
    return res.json({ peer, status: "none", requestedBy: null });
  }

  return res.json(buildSessionEvent(me, session));
});

app.get("/api/sessions/incoming", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return res.status(401).json({ error: "Unauthorized" });

  const sessions = await listIncomingSessions(me);
  return res.json({ sessions: sessions.map((session) => buildSessionEvent(me, session)) });
});

app.post("/api/sessions/request", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return res.status(401).json({ error: "Unauthorized" });

  const parsed = SessionPeerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid peer" });

  const peer = normalizeUsername(parsed.data.peer);
  if (peer === me) return res.status(400).json({ error: "Choose a different peer" });
  if (!(await userExists(peer))) return res.status(404).json({ error: "Peer not found" });

  const session = await upsertPendingSession(me, peer);
  notifySessionUsers(session);
  return res.json(buildSessionEvent(me, session));
});

app.post("/api/sessions/respond", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return res.status(401).json({ error: "Unauthorized" });

  const parsed = SessionRespondSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid session response" });

  const peer = normalizeUsername(parsed.data.peer);
  const session = await fetchPeerSession(me, peer);
  if (!session || session.status !== "pending") return res.status(404).json({ error: "No pending request" });
  if (session.requestedBy === me) return res.status(400).json({ error: "Requester cannot respond" });

  const nextStatus: SessionStatus = parsed.data.action === "accept" ? "active" : "ended";
  const updated = await setSessionStatus(me, peer, nextStatus);
  if (!updated) return res.status(404).json({ error: "Session not found" });

  notifySessionUsers(updated);
  return res.json(buildSessionEvent(me, updated));
});

app.post("/api/sessions/end", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return res.status(401).json({ error: "Unauthorized" });

  const parsed = SessionPeerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid peer" });

  const peer = normalizeUsername(parsed.data.peer);
  const updated = await setSessionStatus(me, peer, "ended");
  if (!updated) return res.status(404).json({ error: "Session not found" });

  notifySessionUsers(updated);
  return res.json(buildSessionEvent(me, updated));
});

wss.on("connection", (ws) => {
  let authedUser: string | null = null;

  ws.on("message", async (buf) => {
    let data: ClientMsg | any;
    try {
      data = JSON.parse(buf.toString());
    } catch {
      return send(ws, { kind: "error", ts: Date.now(), message: "Invalid JSON" });
    }

    if (!authedUser) {
      if (data?.kind !== "auth" || !data?.token) {
        send(ws, { kind: "error", ts: Date.now(), message: "Auth required" });
        ws.close();
        return;
      }

      try {
        authedUser = normalizeUsername(verifyToken(data.token).username);

        const existing = clients.get(authedUser);
        if (existing && existing.readyState === WebSocket.OPEN) {
          send(existing, { kind: "error", ts: Date.now(), message: "Logged in elsewhere. Disconnecting this session." });
          existing.close();
        }

        clients.set(authedUser, ws);
        const now = new Date();
        await prisma.user.update({ where: { username: authedUser }, data: { lastSeenAt: now } });

        send(ws, { kind: "authed", ts: now.getTime(), username: authedUser });

        for (const [username, client] of clients.entries()) {
          if (username === authedUser || client.readyState !== WebSocket.OPEN) continue;
          send(ws, { kind: "presence", ts: now.getTime(), username, online: true });
        }

        broadcast(
          { kind: "presence", ts: now.getTime(), username: authedUser, online: true, lastSeenAt: now.getTime() },
          authedUser
        );

        const undelivered = await prisma.message.findMany({
          where: { toUser: authedUser, deliveredAt: null },
          orderBy: { ts: "asc" },
          take: 200,
        });

        for (const message of undelivered) {
          const conv = await prisma.conversation.findUnique({ where: { id: message.convId } });
          const convKey = conv?.convKey ?? makePeerKey(message.fromUser, message.toUser);

          const deliver: MsgDeliverEvent = {
            kind: "msg_deliver",
            from: message.fromUser,
            to: message.toUser,
            ts: message.ts.getTime(),
            convId: convKey,
            msgId: message.id,
            body: message.bodyCiphertext,
            deliveredAt: Date.now(),
          };
          send(ws, deliver);
          await prisma.message.update({ where: { id: message.id }, data: { deliveredAt: new Date() } });
        }

        return;
      } catch {
        send(ws, { kind: "error", ts: Date.now(), message: "Invalid token" });
        ws.close();
        return;
      }
    }

    data.from = authedUser;
    const to = normalizeUsername(String(data.to ?? ""));
    if (!to) return send(ws, { kind: "error", ts: Date.now(), message: "Missing 'to'" });

    if (data.kind === "msg_send") {
      if (!(await isSessionActive(authedUser, to))) {
        return send(ws, { kind: "error", ts: Date.now(), message: "Chat session not active" });
      }

      const convKey = String(data.convId || makePeerKey(authedUser, to));
      const conv = await ensureConversation(convKey);
      await prisma.message.create({
        data: {
          id: data.msgId,
          convId: conv.id,
          fromUser: authedUser,
          toUser: to,
          bodyCiphertext: String(data.body),
          ts: new Date(),
        },
      });

      const receiver = clients.get(to);
      if (receiver && receiver.readyState === WebSocket.OPEN) {
        send(receiver, {
          kind: "msg_deliver",
          from: authedUser,
          to,
          ts: Date.now(),
          convId: convKey,
          msgId: data.msgId,
          body: String(data.body),
          deliveredAt: Date.now(),
        });
        await prisma.message.update({ where: { id: data.msgId }, data: { deliveredAt: new Date() } });
      }
      return;
    }

    if (data.kind === "msg_read") {
      await prisma.message.update({
        where: { id: data.msgId },
        data: { readAt: new Date(data.readAt) },
      });

      const senderSock = clients.get(to);
      if (senderSock && senderSock.readyState === WebSocket.OPEN) {
        send(senderSock, { ...data, ts: Date.now() });
      }
      return;
    }

    if (data.kind === "draft_update" || data.kind === "draft_clear") {
      if (!(await isSessionActive(authedUser, to))) {
        return send(ws, { kind: "error", ts: Date.now(), message: "Chat session not active" });
      }

      const receiver = clients.get(to);
      if (receiver && receiver.readyState === WebSocket.OPEN) {
        send(receiver, { ...data, to, ts: Date.now() });
      }
      return;
    }

    return send(ws, { kind: "error", ts: Date.now(), message: "Unknown event kind" });
  });

  ws.on("close", () => {
    if (authedUser && clients.get(authedUser) === ws) clients.delete(authedUser);
    if (authedUser) {
      const now = new Date();
      prisma.user.update({ where: { username: authedUser }, data: { lastSeenAt: now } }).catch(() => undefined);
      broadcast({ kind: "presence", ts: now.getTime(), username: authedUser, online: false, lastSeenAt: now.getTime() });
    }
  });
});

const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Zchat server listening on :${PORT}`);
});

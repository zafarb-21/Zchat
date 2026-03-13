import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import { z } from "zod";
import { WebSocketServer, WebSocket } from "ws";

import prisma from "./db";
import { signToken, verifyToken } from "./jwt";
import { ClientMsg, ServerMsg, MsgDeliverEvent } from "./types";

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

const AuthSchema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(6).max(128),
});

// -------- AUTH API --------
app.post("/api/register", async (req, res) => {
  try {
    const parsed = AuthSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

    const uname = parsed.data.username.toLowerCase();
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);

    const existing = await prisma.user.findUnique({ where: { username: uname } });
    if (existing) return res.status(409).json({ error: "Username already taken" });

    await prisma.user.create({ data: { username: uname, passwordHash } });

    const token = signToken(uname);
    return res.json({ token, username: uname });
  } catch (e: any) {
    console.error("REGISTER 500:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const parsed = AuthSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid input" });

    const uname = parsed.data.username.toLowerCase();
    const user = await prisma.user.findUnique({ where: { username: uname } });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    await prisma.user.update({ where: { username: uname }, data: { lastSeenAt: new Date() } });

    const token = signToken(uname);
    return res.json({ token, username: uname });
  } catch (e: any) {
    console.error("LOGIN 500:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// -------- CONTACTS / SEARCH --------
app.get("/api/users/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();
  if (!q) return res.json({ users: [] });

  const users = await prisma.user.findMany({
    where: { username: { contains: q } },
    select: { username: true, lastSeenAt: true },
    take: 20,
  });

  res.json({ users: users.map((u: { username: string; lastSeenAt: Date }) => ({ username: u.username, lastSeenAt: u.lastSeenAt.getTime() })) });

});

// -------- E2EE KEYS (public) --------
function bearerUser(req: express.Request): string | null {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  try {
    return verifyToken(token).username.toLowerCase();
  } catch {
    return null;
  }
}

app.post("/api/keys/set", async (req, res) => {
  const u = bearerUser(req);
  if (!u) return res.status(401).json({ error: "Unauthorized" });

  const publicKeyJwk = req.body?.publicKeyJwk;
  if (!publicKeyJwk) return res.status(400).json({ error: "Missing publicKeyJwk" });

  await prisma.user.update({
    where: { username: u },
    data: { publicKeyJwk, keyUpdatedAt: new Date() },
  });

  res.json({ ok: true });
});

app.get("/api/keys/get", async (req, res) => {
  const u = String(req.query.u ?? "").trim().toLowerCase();
  if (!u) return res.status(400).json({ error: "Missing u" });

  const user = await prisma.user.findUnique({
    where: { username: u },
    select: { publicKeyJwk: true, keyUpdatedAt: true },
  });

  res.json({
    username: u,
    publicKeyJwk: user?.publicKeyJwk ?? null,
    keyUpdatedAt: user?.keyUpdatedAt ? user.keyUpdatedAt.getTime() : undefined,
  });
});

app.get("/api/messages", async (req, res) => {
  const me = bearerUser(req);
  if (!me) return res.status(401).json({ error: "Unauthorized" });

  const other = String(req.query.u ?? "").trim().toLowerCase();
  if (!other) return res.status(400).json({ error: "Missing u" });

  const convKey = [me, other].sort().join("|");
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
    messages: (conv?.messages ?? []).map((m) => ({
      id: m.id,
      from: m.fromUser,
      to: m.toUser,
      body: m.bodyCiphertext,
      ts: m.ts.getTime(),
      readAt: m.readAt ? m.readAt.getTime() : undefined,
    })),
  });
});
// -------- WS SERVER --------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map<string, WebSocket>();

function send(ws: WebSocket, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMsg, exceptUser?: string) {
  for (const [username, client] of clients.entries()) {
    if (exceptUser && username === exceptUser) continue;
    if (client.readyState !== WebSocket.OPEN) continue;
    send(client, msg);
  }
}

async function ensureConversation(convKey: string) {
  const [userA, userB] = convKey.split("|");
  return prisma.conversation.upsert({
    where: { convKey },
    create: { convKey, userA, userB },
    update: {},
  });
}

wss.on("connection", (ws) => {
  let authedUser: string | null = null;

  ws.on("message", async (buf) => {
    let data: ClientMsg | any;
    try { data = JSON.parse(buf.toString()); }
    catch { return send(ws, { kind: "error", ts: Date.now(), message: "Invalid JSON" }); }

    // AUTH FIRST
    if (!authedUser) {
      if (data?.kind !== "auth" || !data?.token) {
        send(ws, { kind: "error", ts: Date.now(), message: "Auth required" });
        ws.close();
        return;
      }

      try {
        authedUser = verifyToken(data.token).username.toLowerCase();

        // single-device enforcement
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
          if (username === authedUser) continue;
          if (client.readyState !== WebSocket.OPEN) continue;
          send(ws, { kind: "presence", ts: now.getTime(), username, online: true });
        }
        broadcast(
          { kind: "presence", ts: now.getTime(), username: authedUser, online: true, lastSeenAt: now.getTime() },
          authedUser
        );

        console.log(`[ws] connected: ${authedUser}`);

        // offline delivery
        const undelivered = await prisma.message.findMany({
          where: { toUser: authedUser, deliveredAt: null },
          orderBy: { ts: "asc" },
          take: 200,
        });

        for (const m of undelivered) {
          const conv = await prisma.conversation.findUnique({ where: { id: m.convId } });
          const convKey = conv?.convKey ?? "";

          const deliver: MsgDeliverEvent = {
            kind: "msg_deliver",
            from: m.fromUser,
            to: m.toUser,
            ts: m.ts.getTime(),
            convId: convKey,
            msgId: m.id,
            body: m.bodyCiphertext,
            deliveredAt: Date.now(),
          };
          send(ws, deliver);

          await prisma.message.update({ where: { id: m.id }, data: { deliveredAt: new Date() } });
        }

        return;
      } catch (e) {
        send(ws, { kind: "error", ts: Date.now(), message: "Invalid token" });
        ws.close();
        return;
      }
    }

    // normal events
    data.from = authedUser;
    const to = String(data.to ?? "").trim().toLowerCase();
    if (!to) return send(ws, { kind: "error", ts: Date.now(), message: "Missing 'to'" });

    // MESSAGE SEND: persist + deliver
    if (data.kind === "msg_send") {
      const convKey = String(data.convId);
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

    // READ RECEIPT
    if (data.kind === "msg_read") {
      await prisma.message.update({
        where: { id: data.msgId },
        data: { readAt: new Date(data.readAt) },
      });

      // forward to original sender if online
      const senderSock = clients.get(to);
      if (senderSock && senderSock.readyState === WebSocket.OPEN) {
        send(senderSock, { ...data, ts: Date.now() });
      }
      return;
    }

    // DRAFTS: relay only (no DB)
    if (data.kind === "draft_update" || data.kind === "draft_clear") {
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
      prisma.user.update({ where: { username: authedUser }, data: { lastSeenAt: now } }).catch(() => {});
      broadcast({ kind: "presence", ts: now.getTime(), username: authedUser, online: false, lastSeenAt: now.getTime() });
      console.log(`[ws] disconnected: ${authedUser}`);
    }
  });
});

const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Zchat server listening on :${PORT}`);
});




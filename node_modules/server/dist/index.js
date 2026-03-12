"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const zod_1 = require("zod");
const ws_1 = require("ws");
const db_1 = __importDefault(require("./db"));
const jwt_1 = require("./jwt");
const app = (0, express_1.default)();
app.use((0, cors_1.default)({ origin: true }));
app.use(express_1.default.json());
app.get("/health", (_req, res) => res.json({ ok: true }));
const AuthSchema = zod_1.z.object({
    username: zod_1.z.string().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/),
    password: zod_1.z.string().min(6).max(128),
});
// -------- AUTH API --------
app.post("/api/register", async (req, res) => {
    try {
        const parsed = AuthSchema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: "Invalid input" });
        const uname = parsed.data.username.toLowerCase();
        const passwordHash = await bcrypt_1.default.hash(parsed.data.password, 12);
        const existing = await db_1.default.user.findUnique({ where: { username: uname } });
        if (existing)
            return res.status(409).json({ error: "Username already taken" });
        await db_1.default.user.create({ data: { username: uname, passwordHash } });
        const token = (0, jwt_1.signToken)(uname);
        return res.json({ token, username: uname });
    }
    catch (e) {
        console.error("REGISTER 500:", e);
        return res.status(500).json({ error: "Server error" });
    }
});
app.post("/api/login", async (req, res) => {
    try {
        const parsed = AuthSchema.safeParse(req.body);
        if (!parsed.success)
            return res.status(400).json({ error: "Invalid input" });
        const uname = parsed.data.username.toLowerCase();
        const user = await db_1.default.user.findUnique({ where: { username: uname } });
        if (!user)
            return res.status(401).json({ error: "Invalid credentials" });
        const ok = await bcrypt_1.default.compare(parsed.data.password, user.passwordHash);
        if (!ok)
            return res.status(401).json({ error: "Invalid credentials" });
        await db_1.default.user.update({ where: { username: uname }, data: { lastSeenAt: new Date() } });
        const token = (0, jwt_1.signToken)(uname);
        return res.json({ token, username: uname });
    }
    catch (e) {
        console.error("LOGIN 500:", e);
        return res.status(500).json({ error: "Server error" });
    }
});
// -------- CONTACTS / SEARCH --------
app.get("/api/users/search", async (req, res) => {
    const q = String(req.query.q ?? "").trim().toLowerCase();
    if (!q)
        return res.json({ users: [] });
    const users = await db_1.default.user.findMany({
        where: { username: { contains: q } },
        select: { username: true, lastSeenAt: true },
        take: 20,
    });
    res.json({ users: users.map((u) => ({ username: u.username, lastSeenAt: u.lastSeenAt.getTime() })) });
});
// -------- E2EE KEYS (public) --------
function bearerUser(req) {
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token)
        return null;
    try {
        return (0, jwt_1.verifyToken)(token).username.toLowerCase();
    }
    catch {
        return null;
    }
}
app.post("/api/keys/set", async (req, res) => {
    const u = bearerUser(req);
    if (!u)
        return res.status(401).json({ error: "Unauthorized" });
    const publicKeyJwk = req.body?.publicKeyJwk;
    if (!publicKeyJwk)
        return res.status(400).json({ error: "Missing publicKeyJwk" });
    await db_1.default.user.update({
        where: { username: u },
        data: { publicKeyJwk, keyUpdatedAt: new Date() },
    });
    res.json({ ok: true });
});
app.get("/api/keys/get", async (req, res) => {
    const u = String(req.query.u ?? "").trim().toLowerCase();
    if (!u)
        return res.status(400).json({ error: "Missing u" });
    const user = await db_1.default.user.findUnique({
        where: { username: u },
        select: { publicKeyJwk: true, keyUpdatedAt: true },
    });
    res.json({
        username: u,
        publicKeyJwk: user?.publicKeyJwk ?? null,
        keyUpdatedAt: user?.keyUpdatedAt ? user.keyUpdatedAt.getTime() : undefined,
    });
});
// -------- WS SERVER --------
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
const clients = new Map();
function send(ws, msg) {
    ws.send(JSON.stringify(msg));
}
async function ensureConversation(convKey) {
    const [userA, userB] = convKey.split("|");
    return db_1.default.conversation.upsert({
        where: { convKey },
        create: { convKey, userA, userB },
        update: {},
    });
}
wss.on("connection", (ws) => {
    let authedUser = null;
    ws.on("message", async (buf) => {
        let data;
        try {
            data = JSON.parse(buf.toString());
        }
        catch {
            return send(ws, { kind: "error", ts: Date.now(), message: "Invalid JSON" });
        }
        // AUTH FIRST
        if (!authedUser) {
            if (data?.kind !== "auth" || !data?.token) {
                send(ws, { kind: "error", ts: Date.now(), message: "Auth required" });
                ws.close();
                return;
            }
            try {
                authedUser = (0, jwt_1.verifyToken)(data.token).username.toLowerCase();
                // single-device enforcement
                const existing = clients.get(authedUser);
                if (existing && existing.readyState === ws_1.WebSocket.OPEN) {
                    send(existing, { kind: "error", ts: Date.now(), message: "Logged in elsewhere. Disconnecting this session." });
                    existing.close();
                }
                clients.set(authedUser, ws);
                await db_1.default.user.update({ where: { username: authedUser }, data: { lastSeenAt: new Date() } });
                send(ws, { kind: "authed", ts: Date.now(), username: authedUser });
                send(ws, { kind: "presence", ts: Date.now(), username: authedUser, online: true });
                console.log(`✅ connected: ${authedUser}`);
                // offline delivery
                const undelivered = await db_1.default.message.findMany({
                    where: { toUser: authedUser, deliveredAt: null },
                    orderBy: { ts: "asc" },
                    take: 200,
                });
                for (const m of undelivered) {
                    const conv = await db_1.default.conversation.findUnique({ where: { id: m.convId } });
                    const convKey = conv?.convKey ?? "";
                    const deliver = {
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
                    await db_1.default.message.update({ where: { id: m.id }, data: { deliveredAt: new Date() } });
                }
                return;
            }
            catch (e) {
                send(ws, { kind: "error", ts: Date.now(), message: "Invalid token" });
                ws.close();
                return;
            }
        }
        // normal events
        data.from = authedUser;
        const to = String(data.to ?? "").trim().toLowerCase();
        if (!to)
            return send(ws, { kind: "error", ts: Date.now(), message: "Missing 'to'" });
        // MESSAGE SEND: persist + deliver
        if (data.kind === "msg_send") {
            const convKey = String(data.convId);
            const conv = await ensureConversation(convKey);
            await db_1.default.message.create({
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
            if (receiver && receiver.readyState === ws_1.WebSocket.OPEN) {
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
                await db_1.default.message.update({ where: { id: data.msgId }, data: { deliveredAt: new Date() } });
            }
            return;
        }
        // READ RECEIPT
        if (data.kind === "msg_read") {
            await db_1.default.message.update({
                where: { id: data.msgId },
                data: { readAt: new Date(data.readAt) },
            });
            // forward to original sender if online
            const senderSock = clients.get(to);
            if (senderSock && senderSock.readyState === ws_1.WebSocket.OPEN) {
                send(senderSock, { ...data, ts: Date.now() });
            }
            return;
        }
        // DRAFTS: relay only (no DB)
        if (data.kind === "draft_update" || data.kind === "draft_clear") {
            const receiver = clients.get(to);
            if (receiver && receiver.readyState === ws_1.WebSocket.OPEN) {
                send(receiver, { ...data, to, ts: Date.now() });
            }
            return;
        }
        return send(ws, { kind: "error", ts: Date.now(), message: "Unknown event kind" });
    });
    ws.on("close", () => {
        if (authedUser && clients.get(authedUser) === ws)
            clients.delete(authedUser);
        if (authedUser) {
            db_1.default.user.update({ where: { username: authedUser }, data: { lastSeenAt: new Date() } }).catch(() => { });
            console.log(`❌ disconnected: ${authedUser}`);
        }
    });
});
const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Zchat server listening on :${PORT}`);
});

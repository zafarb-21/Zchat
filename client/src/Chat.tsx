import { useEffect, useMemo, useRef, useState } from "react";
import { WS_BASE, apiGetKey, apiSearchUsers, apiSetKey } from "./api";
import { decryptFromPayload, deriveSessionKey, encryptToPayload, loadOrCreateIdentityKeypair } from "./crypto";

type ServerEvt =
  | { kind: "authed"; ts: number; username: string }
  | { kind: "error"; ts: number; message: string }
  | { kind: "presence"; ts: number; username: string; online: boolean; lastSeenAt?: number }
  | { kind: "msg_deliver"; from: string; to: string; ts: number; convId: string; msgId: string; body: string; deliveredAt?: number }
  | { kind: "msg_read"; from: string; to: string; ts: number; convId: string; msgId: string; readAt: number }
  | { kind: "draft_update"; from: string; to: string; ts: number; convId: string; draftId: string; seq: number; body: string; cursor: number; expiresInMs: number }
  | { kind: "draft_clear"; from: string; to: string; ts: number; convId: string; draftId: string };

type ClientEvt =
  | { kind: "auth"; token: string }
  | { kind: "msg_send"; from: string; to: string; ts: number; convId: string; msgId: string; body: string }
  | { kind: "msg_read"; from: string; to: string; ts: number; convId: string; msgId: string; readAt: number }
  | { kind: "draft_update"; from: string; to: string; ts: number; convId: string; draftId: string; seq: number; body: string; cursor: number; expiresInMs: number }
  | { kind: "draft_clear"; from: string; to: string; ts: number; convId: string; draftId: string };

const uid = () => crypto.randomUUID();

function makeConvId(a: string, b: string) {
  return [a.trim().toLowerCase(), b.trim().toLowerCase()].sort().join("|");
}

export default function Chat(props: { token: string; me: string; onLogout: () => void }) {
  const me = props.me.trim().toLowerCase();

  const [peer, setPeer] = useState<string>(localStorage.getItem("zchat_peer") || "");
  const convId = useMemo(() => (peer ? makeConvId(me, peer) : ""), [me, peer]);

  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // contacts/search
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ username: string; lastSeenAt: number }>>([]);
  const [recents, setRecents] = useState<string[]>(JSON.parse(localStorage.getItem("zchat_recents") || "[]"));

  // presence
  const [presence, setPresence] = useState<Record<string, { online: boolean; lastSeenAt?: number }>>({});

  // E2EE
  const myPrivRef = useRef<CryptoKey | null>(null);
  const [sessionKey, setSessionKey] = useState<CryptoKey | null>(null);
  const [e2eeReady, setE2eeReady] = useState(false);

  // messages
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Array<{ id: string; from: string; body: string; ts: number; readAt?: number }>>([]);

  // drafts
  const myDraftId = useRef(uid());
  const mySeq = useRef(0);
  const debounceTimer = useRef<number | null>(null);
  const lastSentAt = useRef(0);

  const [theirDraft, setTheirDraft] = useState("");
  const theirDraftExpiryTimer = useRef<number | null>(null);

  function rememberPeer(p: string) {
    const clean = p.trim().toLowerCase();
    if (!clean) return;

    setRecents((current) => {
      const next = [clean, ...current.filter((x) => x !== clean)].slice(0, 10);
      localStorage.setItem("zchat_recents", JSON.stringify(next));
      return next;
    });
  }

  function sendEvent(evt: ClientEvt) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(evt));
  }

  function connect() {
    wsRef.current?.close();

    const ws = new WebSocket(WS_BASE);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      sendEvent({ kind: "auth", token: props.token });
    };

    ws.onclose = () => setConnected(false);
    ws.onerror = (e) => console.log("WS error", e);

    ws.onmessage = async (m) => {
      let evt: ServerEvt;
      try { evt = JSON.parse(m.data); } catch { return; }

      if (evt.kind === "error") {
        console.log("Server error:", evt.message);
        if (evt.message.toLowerCase().includes("logged in elsewhere")) props.onLogout();
        return;
      }

      if (evt.kind === "presence") {
        setPresence(old => ({ ...old, [evt.username]: { online: evt.online, lastSeenAt: evt.lastSeenAt } }));
        return;
      }

      if (evt.kind === "msg_read") {
        // mark message read in UI
        setMessages(old => old.map(mm => (mm.id === evt.msgId ? { ...mm, readAt: evt.readAt } : mm)));
        return;
      }

      if (evt.kind === "msg_deliver") {
        if (!peer || evt.convId !== convId) return;
        if (!sessionKey) return; // can't decrypt yet

        const plaintext = await decryptFromPayload(sessionKey, evt.body).catch(() => "[decrypt failed]");
        setMessages(old => [...old, { id: evt.msgId, from: evt.from, body: plaintext, ts: evt.ts }]);

        // send read receipt
        sendEvent({ kind: "msg_read", from: me, to: evt.from, ts: Date.now(), convId: evt.convId, msgId: evt.msgId, readAt: Date.now() });
        return;
      }

      if (evt.kind === "draft_update") {
        const expectedSender = peer.trim().toLowerCase();
        const actualSender = evt.from?.trim().toLowerCase();
        if (evt.convId !== convId) return;
        if (actualSender !== expectedSender) return;
        if (!sessionKey) return;

        const pt = await decryptFromPayload(sessionKey, evt.body).catch(() => "");
        setTheirDraft(pt);

        if (theirDraftExpiryTimer.current) clearTimeout(theirDraftExpiryTimer.current);
        theirDraftExpiryTimer.current = window.setTimeout(() => setTheirDraft(""), evt.expiresInMs);
        return;
      }

      if (evt.kind === "draft_clear") {
        const expectedSender = peer.trim().toLowerCase();
        const actualSender = evt.from?.trim().toLowerCase();
        if (evt.convId !== convId) return;
        if (actualSender !== expectedSender) return;
        setTheirDraft("");
        return;
      }
    };
  }

  // 1) bootstrap: identity key + publish public key + connect WS
  useEffect(() => {
    (async () => {
      const id = await loadOrCreateIdentityKeypair();
      myPrivRef.current = id.privateKey;
      await apiSetKey(props.token, id.publicKeyJwk).catch(console.error);

      connect();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2) when peer changes: derive session key
  useEffect(() => {
    (async () => {
      setSessionKey(null);
      setE2eeReady(false);
      setMessages([]);
      setTheirDraft("");

      const p = peer.trim().toLowerCase();
      if (!p) return;
      if (!myPrivRef.current) return;

      rememberPeer(p);

      const kb = await apiGetKey(p).catch(() => null);
      if (!kb?.publicKeyJwk) return; // peer hasn't published yet

      const key = await deriveSessionKey(myPrivRef.current, kb.publicKeyJwk, makeConvId(me, p));
      setSessionKey(key);
      setE2eeReady(true);
    })();
  }, [peer, me]);

  // contacts search
  useEffect(() => {
    const t = window.setTimeout(async () => {
      const qq = q.trim().toLowerCase();
      if (!qq) return setResults([]);
      const users = await apiSearchUsers(qq).catch(() => []);
      setResults(users.filter(u => u.username !== me));
    }, 200);
    return () => clearTimeout(t);
  }, [q, me]);

  async function sendMessage() {
    const raw = message.trim();
    if (!raw) return;
    if (!peer.trim()) return alert("Set a peer username first");
    if (!sessionKey) return alert("E2EE not ready yet (peer key missing?)");

    const body = await encryptToPayload(sessionKey, raw);

    const msgId = uid();
    setMessages(old => [...old, { id: msgId, from: me, body: raw, ts: Date.now() }]);

    sendEvent({
      kind: "msg_send",
      from: me,
      to: peer.trim().toLowerCase(),
      ts: Date.now(),
      convId,
      msgId,
      body
    });

    setMessage("");
    sendEvent({ kind: "draft_clear", from: me, to: peer.trim().toLowerCase(), ts: Date.now(), convId, draftId: myDraftId.current });
  }

  function scheduleDraft(nextText: string, cursor: number) {
    if (!peer.trim()) return;
    if (!sessionKey) return; // don't leak plaintext before E2EE is ready

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(async () => {
      const now = Date.now();
      const minGap = 250;
      if (now - lastSentAt.current < minGap) {
        scheduleDraft(nextText, cursor);
        return;
      }
      lastSentAt.current = now;
      mySeq.current += 1;

      const enc = await encryptToPayload(sessionKey, nextText);

      sendEvent({
        kind: "draft_update",
        from: me,
        to: peer.trim().toLowerCase(),
        ts: now,
        convId,
        draftId: myDraftId.current,
        seq: mySeq.current,
        body: enc,
        cursor,
        expiresInMs: 3000
      });
    }, 120);
  }

  const peerStatus = presence[peer.trim().toLowerCase()];
  const peerPresenceLabel = !peer.trim()
    ? ""
    : peerStatus?.online
      ? "online"
      : peerStatus?.lastSeenAt
        ? `last seen ${new Date(peerStatus.lastSeenAt).toLocaleString()}`
        : "offline";

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={{ margin: 0 }}>Zchat</h2>
        <span style={{ marginLeft: "auto" }}>
          Signed in as <b>{me}</b>
        </span>
        <button onClick={props.onLogout}>Logout</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 14, marginTop: 12 }}>
        {/* Left: contacts/search */}
        <div style={{ border: "1px solid #333", borderRadius: 10, padding: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Contacts</div>
          <input
            placeholder="Search users..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: "100%" }}
          />
          <div style={{ marginTop: 10 }}>
            {results.map(u => (
              <div key={u.username} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
                <button
                  onClick={() => setPeer(u.username)}
                  style={{ textAlign: "left", width: "100%" }}
                >
                  {u.username}
                </button>
                <span style={{ opacity: 0.7, marginLeft: 8, fontSize: 12 }}>
                  {new Date(u.lastSeenAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14, fontWeight: 700 }}>Recents</div>
          {recents.map(r => (
            <div key={r} style={{ padding: "6px 0" }}>
              <button onClick={() => setPeer(r)} style={{ width: "100%", textAlign: "left" }}>
                {r}
              </button>
            </div>
          ))}
        </div>

        {/* Right: chat */}
        <div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <label>
              Peer:
              <input
                style={{ marginLeft: 8 }}
                value={peer}
                onChange={(e) => {
                  setPeer(e.target.value);
                  localStorage.setItem("zchat_peer", e.target.value);
                }}
              />
            </label>

            <button onClick={connect} disabled={connected}>{connected ? "Connected" : "Connect"}</button>

            <span style={{ marginLeft: "auto" }}>
              Status: <b>{connected ? "connected" : "disconnected"}</b>
              {peer.trim() ? (
                <>
                  {" | "}Peer: <b>{peerPresenceLabel}</b>
                  {" | "}E2EE: <b>{e2eeReady ? "on" : "pending"}</b>
                </>
              ) : null}
            </span>
          </div>

          <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12, minHeight: 260, marginTop: 10 }}>
            <div style={{ marginBottom: 8 }}>
              <b>Conversation:</b> {convId || "(set peer)"}
            </div>

            {messages.map(m => (
              <div key={m.id} style={{ padding: 8, borderRadius: 8, background: "#f6f6f6", marginBottom: 6, color: "#111" }}>
                <div style={{ fontSize: 12, opacity: 0.7, color: "#333" }}>
                  {m.from} | {new Date(m.ts).toLocaleTimeString()}{" "}
                  {m.from === me && m.readAt ? `| read ${new Date(m.readAt).toLocaleTimeString()}` : ""}
                </div>
                <div style={{ color: "#111" }}>{m.body}</div>
              </div>
            ))}

            {theirDraft && (
              <div style={{ marginTop: 12, padding: 10, borderRadius: 8, border: "1px dashed #bbb" }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{peer.trim().toLowerCase()} drafting:</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{theirDraft}</div>
              </div>
            )}
          </div>

          <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12, marginTop: 10 }}>
            <textarea
              value={message}
              placeholder="Type... peer sees this live (encrypted)"
              style={{ width: "100%", height: 90, resize: "vertical" }}
              onChange={(e) => {
                const txt = e.target.value;
                setMessage(txt);
                scheduleDraft(txt, e.target.selectionStart ?? txt.length);
              }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={sendMessage} disabled={!connected || !message.trim() || !peer.trim() || !sessionKey}>
                Send
              </button>
              <button
                onClick={() => {
                  setMessage("");
                  if (!peer.trim()) return;
                  sendEvent({ kind: "draft_clear", from: me, to: peer.trim().toLowerCase(), ts: Date.now(), convId, draftId: myDraftId.current });
                }}
                disabled={!connected || !peer.trim()}
              >
                Clear Draft
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


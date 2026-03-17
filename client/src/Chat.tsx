import { useEffect, useMemo, useRef, useState } from "react";
import {
  WS_BASE,
  apiEndSession,
  apiGetDevices,
  apiGetIncomingSessions,
  apiGetMessages,
  apiGetMyDevices,
  apiGetSession,
  apiGetUserStatus,
  apiRequestSession,
  apiRespondSession,
  apiSearchUsers,
  apiSetKey,
  apiUpdateDeviceNotifications,
  type DeviceInfo,
  type SessionInfo,
} from "./api";
import { decryptFromPayload, deriveSessionKey, encryptToPayload, loadOrCreateIdentityKeypair } from "./crypto";
import { getDeviceId, getDeviceLabel } from "./device";
import { requestNotificationAccess, showDesktopNotification } from "./notifications";

type ServerEvt =
  | { kind: "authed"; ts: number; username: string }
  | { kind: "error"; ts: number; message: string }
  | { kind: "presence"; ts: number; username: string; online: boolean; lastSeenAt?: number }
  | { kind: "session_update"; ts: number; peer: string; status: "pending" | "active" | "ended"; requestedBy: string; createdAt: number; updatedAt: number }
  | { kind: "msg_deliver"; from: string; fromDeviceId: string; to: string; ts: number; convId: string; msgId: string; body: string; deliveredAt?: number }
  | { kind: "msg_read"; from: string; fromDeviceId?: string; to: string; ts: number; convId: string; msgId: string; readAt: number }
  | { kind: "draft_update"; from: string; fromDeviceId: string; to: string; ts: number; convId: string; draftId: string; seq: number; body?: string; envelopes: Array<{ deviceId: string; body: string }>; cursor: number; expiresInMs: number }
  | { kind: "draft_clear"; from: string; fromDeviceId?: string; to: string; ts: number; convId: string; draftId: string };

type ClientEvt =
  | { kind: "auth"; token: string; deviceId: string }
  | { kind: "msg_send"; from: string; fromDeviceId: string; to: string; ts: number; convId: string; msgId: string; envelopes: Array<{ username: string; deviceId: string; body: string }> }
  | { kind: "msg_read"; from: string; fromDeviceId?: string; to: string; ts: number; convId: string; msgId: string; readAt: number }
  | { kind: "draft_update"; from: string; fromDeviceId: string; to: string; ts: number; convId: string; draftId: string; seq: number; envelopes: Array<{ deviceId: string; body: string }>; cursor: number; expiresInMs: number }
  | { kind: "draft_clear"; from: string; fromDeviceId?: string; to: string; ts: number; convId: string; draftId: string };

type ChatMessage = {
  id: string;
  from: string;
  fromDeviceId: string;
  body: string;
  ts: number;
  readAt?: number;
};

type ChatProps = {
  token: string;
  me: string;
  onLogout: () => void;
  recoveryCodeNotice: string | null;
  onDismissRecoveryCode: () => void;
};

const uid = () => crypto.randomUUID();
const NOTIFICATION_PREF_KEY = "zchat_notifications_enabled_v1";

function makeConvId(a: string, b: string) {
  return [a.trim().toLowerCase(), b.trim().toLowerCase()].sort().join("|");
}

function makeSessionContext(convId: string, senderDeviceId: string, targetDeviceId: string) {
  return `${convId}:${senderDeviceId}:${targetDeviceId}`;
}

function emptySession(peer: string): SessionInfo {
  return { peer, status: "none", requestedBy: null };
}

function deviceDirectoryKey(username: string, deviceId: string) {
  return `${username}:${deviceId}`;
}

export default function Chat({ token, me, onLogout, recoveryCodeNotice, onDismissRecoveryCode }: ChatProps) {
  const self = me.trim().toLowerCase();
  const localDeviceId = useMemo(() => getDeviceId(), []);
  const localDeviceLabel = useMemo(() => getDeviceLabel(), []);
  const [peer, setPeer] = useState<string>(localStorage.getItem("zchat_peer") || "");
  const convId = useMemo(() => (peer ? makeConvId(self, peer) : ""), [peer, self]);

  const wsRef = useRef<WebSocket | null>(null);
  const peerRef = useRef(peer.trim().toLowerCase());
  const convIdRef = useRef(convId);
  const privateKeyRef = useRef<CryptoKey | null>(null);
  const deviceKeyCacheRef = useRef(new Map<string, CryptoKey>());

  const [connected, setConnected] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ username: string; lastSeenAt: number }>>([]);
  const [recents, setRecents] = useState<string[]>(JSON.parse(localStorage.getItem("zchat_recents") || "[]"));
  const [incomingSessions, setIncomingSessions] = useState<SessionInfo[]>([]);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [presence, setPresence] = useState<Record<string, { online: boolean; lastSeenAt?: number }>>({});
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [theirDraft, setTheirDraft] = useState("");
  const [peerDevices, setPeerDevices] = useState<DeviceInfo[]>([]);
  const [myDevices, setMyDevices] = useState<DeviceInfo[]>([]);
  const [notificationEnabled, setNotificationEnabled] = useState(localStorage.getItem(NOTIFICATION_PREF_KEY) === "true");

  const myDraftId = useRef(uid());
  const mySeq = useRef(0);
  const debounceTimer = useRef<number | null>(null);
  const lastSentAt = useRef(0);
  const theirDraftExpiryTimer = useRef<number | null>(null);

  useEffect(() => {
    peerRef.current = peer.trim().toLowerCase();
    convIdRef.current = convId;
  }, [peer, convId]);

  const deviceDirectory = useMemo(() => {
    const next = new Map<string, DeviceInfo>();
    for (const device of myDevices) next.set(deviceDirectoryKey(self, device.deviceId), device);
    for (const device of peerDevices) next.set(deviceDirectoryKey(peer.trim().toLowerCase(), device.deviceId), device);
    return next;
  }, [myDevices, peerDevices, peer, self]);

  const selectedPeer = peer.trim().toLowerCase();
  const encryptablePeerDevices = peerDevices.filter((device) => device.publicKeyJwk);
  const encryptableSelfDevices = myDevices.filter((device) => device.publicKeyJwk);
  const e2eeReady = Boolean(privateKeyRef.current) && encryptablePeerDevices.length > 0;
  const canChat = connected && session?.status === "active" && e2eeReady && !chatError;
  const peerStatus = presence[selectedPeer];
  const peerPresenceLabel = !selectedPeer
    ? "Select a peer"
    : peerStatus?.online
      ? "online"
      : peerStatus?.lastSeenAt
        ? `last seen ${new Date(peerStatus.lastSeenAt).toLocaleString()}`
        : "offline";
  const incomingForSelected = incomingSessions.find((item) => item.peer === selectedPeer);

  function rememberPeer(nextPeer: string) {
    const clean = nextPeer.trim().toLowerCase();
    if (!clean) return;
    setRecents((current) => {
      const next = [clean, ...current.filter((value) => value !== clean)].slice(0, 10);
      localStorage.setItem("zchat_recents", JSON.stringify(next));
      return next;
    });
  }

  function sendEvent(evt: ClientEvt) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(evt));
  }

  async function sharedKeyFor(username: string, deviceId: string, publicKeyJwk: JsonWebKey, senderDeviceId: string, targetDeviceId: string, conversationId: string) {
    const cacheKey = `${username}:${deviceId}:${senderDeviceId}:${targetDeviceId}:${conversationId}`;
    const cached = deviceKeyCacheRef.current.get(cacheKey);
    if (cached) return cached;

    const privateKey = privateKeyRef.current;
    if (!privateKey) throw new Error("Missing local private key");

    const derived = await deriveSessionKey(privateKey, publicKeyJwk, makeSessionContext(conversationId, senderDeviceId, targetDeviceId));
    deviceKeyCacheRef.current.set(cacheKey, derived);
    return derived;
  }

  async function decryptForCurrentDevice(body: string, from: string, fromDeviceId: string, conversationId: string) {
    const senderDevice = deviceDirectory.get(deviceDirectoryKey(from, fromDeviceId));
    if (!senderDevice?.publicKeyJwk) throw new Error("Missing sender device key");
    const key = await sharedKeyFor(from, fromDeviceId, senderDevice.publicKeyJwk, fromDeviceId, localDeviceId, conversationId);
    return decryptFromPayload(key, body);
  }

  async function refreshIncomingSessions() {
    const sessions = await apiGetIncomingSessions(token).catch(() => []);
    setIncomingSessions(sessions.filter((item) => item.status === "pending"));
  }

  async function refreshSelectedSession(targetPeer: string) {
    const cleanPeer = targetPeer.trim().toLowerCase();
    if (!cleanPeer) {
      setSession(null);
      return;
    }
    const nextSession = await apiGetSession(token, cleanPeer).catch(() => emptySession(cleanPeer));
    setSession(nextSession);
  }

  async function refreshDeviceState(targetPeer: string) {
    const cleanPeer = targetPeer.trim().toLowerCase();
    const [mine, peerList] = await Promise.all([
      apiGetMyDevices(token, localDeviceId).catch(() => ({ devices: [] as DeviceInfo[] })),
      cleanPeer ? apiGetDevices(token, cleanPeer).catch(() => [] as DeviceInfo[]) : Promise.resolve([] as DeviceInfo[]),
    ]);
    setMyDevices(mine.devices);
    setPeerDevices(peerList);
  }

  async function refreshSelectedHistory(targetPeer: string) {
    const history = await apiGetMessages(token, targetPeer, localDeviceId).catch(() => []);
    const conversationId = makeConvId(self, targetPeer);
    const decrypted = await Promise.all(
      history.map(async (item) => ({
        id: item.id,
        from: item.from,
        fromDeviceId: item.fromDeviceId,
        body: await decryptForCurrentDevice(item.body, item.from, item.fromDeviceId, conversationId).catch(() => "[decrypt failed]"),
        ts: item.ts,
        readAt: item.readAt,
      }))
    );
    setMessages(decrypted);
  }

  async function refreshPeerStatus(targetPeer: string) {
    const cleanPeer = targetPeer.trim().toLowerCase();
    if (!cleanPeer) return;
    const status = await apiGetUserStatus(cleanPeer).catch(() => null);
    if (!status) return;
    setPresence((current) => ({ ...current, [cleanPeer]: { online: status.online, lastSeenAt: status.lastSeenAt } }));
  }

  function maybeNotify(title: string, body: string, tag: string) {
    if (!notificationEnabled) return;
    if (!document.hidden) return;
    showDesktopNotification(title, body, tag);
  }

  function connect() {
    wsRef.current?.close();
    const ws = new WebSocket(WS_BASE);
    wsRef.current = ws;
    setConnected(false);

    ws.onopen = () => {
      ws.send(JSON.stringify({ kind: "auth", token, deviceId: localDeviceId } satisfies ClientEvt));
    };

    ws.onclose = () => setConnected(false);
    ws.onerror = () => setNotice("Realtime connection is unstable. State will continue to refresh from the server.");

    ws.onmessage = async (event) => {
      let payload: ServerEvt;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.kind === "authed") {
        setConnected(true);
        return;
      }

      if (payload.kind === "error") {
        setNotice(payload.message);
        return;
      }

      if (payload.kind === "presence") {
        setPresence((current) => ({ ...current, [payload.username]: { online: payload.online, lastSeenAt: payload.lastSeenAt } }));
        return;
      }

      if (payload.kind === "session_update") {
        if (payload.peer === peerRef.current) {
          setSession({
            peer: payload.peer,
            status: payload.status,
            requestedBy: payload.requestedBy,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          });
        }
        if (payload.status === "pending" && payload.requestedBy !== self) {
          maybeNotify("Incoming session request", `${payload.requestedBy} wants to chat securely.`, `session-${payload.peer}`);
        }
        if (payload.status === "active" && payload.peer === peerRef.current) {
          setNotice(`Session with ${payload.peer} is active.`);
        }
        void refreshIncomingSessions();
        return;
      }

      if (payload.kind === "msg_read") {
        setMessages((current) => current.map((item) => (item.id === payload.msgId ? { ...item, readAt: payload.readAt } : item)));
        return;
      }

      if (payload.kind === "msg_deliver") {
        const plaintext = await decryptForCurrentDevice(payload.body, payload.from, payload.fromDeviceId, payload.convId).catch(() => "[decrypt failed]");
        setMessages((current) => {
          if (current.some((item) => item.id === payload.msgId)) return current;
          return [...current, { id: payload.msgId, from: payload.from, fromDeviceId: payload.fromDeviceId, body: plaintext, ts: payload.ts }];
        });

        if (payload.from !== self) {
          if (peerRef.current !== payload.from) {
            maybeNotify(`New message from ${payload.from}`, plaintext, `msg-${payload.msgId}`);
          } else {
            sendEvent({
              kind: "msg_read",
              from: self,
              fromDeviceId: localDeviceId,
              to: payload.from,
              ts: Date.now(),
              convId: payload.convId,
              msgId: payload.msgId,
              readAt: Date.now(),
            });
          }
        }
        return;
      }

      if (payload.kind === "draft_update") {
        const currentConvId = convIdRef.current;
        if (!currentConvId || payload.convId !== currentConvId || payload.from !== peerRef.current) return;
        const body = payload.body ?? payload.envelopes.find((item) => item.deviceId === localDeviceId)?.body;
        if (!body) return;
        const plaintext = await decryptForCurrentDevice(body, payload.from, payload.fromDeviceId, payload.convId).catch(() => "");
        setTheirDraft(plaintext);
        if (theirDraftExpiryTimer.current) clearTimeout(theirDraftExpiryTimer.current);
        theirDraftExpiryTimer.current = window.setTimeout(() => setTheirDraft(""), payload.expiresInMs);
        return;
      }

      if (payload.kind === "draft_clear" && payload.from === peerRef.current && payload.convId === convIdRef.current) {
        setTheirDraft("");
      }
    };
  }

  useEffect(() => {
    (async () => {
      try {
        if (!window.isSecureContext || !window.crypto?.subtle) {
          throw new Error("Secure browser context required");
        }

        setChatError(null);
        const identity = await loadOrCreateIdentityKeypair(`${self}:${localDeviceId}`);
        privateKeyRef.current = identity.privateKey;
        await apiSetKey(token, localDeviceId, localDeviceLabel, identity.publicKeyJwk, notificationEnabled);
        await refreshDeviceState(peerRef.current);
        connect();
      } catch (caught) {
        console.error(caught);
        setChatError("This browser could not initialize secure chat. Use a modern browser over HTTPS.");
      }
    })();

    return () => {
      wsRef.current?.close();
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (theirDraftExpiryTimer.current) clearTimeout(theirDraftExpiryTimer.current);
    };
  }, [token, localDeviceId, localDeviceLabel, notificationEnabled]);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const query = q.trim().toLowerCase();
      if (!query) {
        setResults([]);
        return;
      }
      const users = await apiSearchUsers(query).catch(() => []);
      setResults(users.filter((item) => item.username !== self));
    }, 200);
    return () => clearTimeout(timer);
  }, [q, self]);

  useEffect(() => {
    void refreshIncomingSessions();
    const intervalId = window.setInterval(() => void refreshIncomingSessions(), 5000);
    return () => clearInterval(intervalId);
  }, [token]);

  useEffect(() => {
    const cleanPeer = peer.trim().toLowerCase();
    localStorage.setItem("zchat_peer", cleanPeer);
    setTheirDraft("");
    setMessages([]);
    deviceKeyCacheRef.current.clear();
    void refreshSelectedSession(cleanPeer);
    void refreshPeerStatus(cleanPeer);
    void refreshDeviceState(cleanPeer);

    if (!cleanPeer) {
      setPeerDevices([]);
      return;
    }

    rememberPeer(cleanPeer);
  }, [peer, self, token]);

  useEffect(() => {
    const cleanPeer = peer.trim().toLowerCase();
    if (!cleanPeer || !privateKeyRef.current) return;
    if (!peerDevices.length && !myDevices.length) return;
    void refreshSelectedHistory(cleanPeer);
  }, [peerDevices, myDevices, peer, token, self]);

  useEffect(() => {
    const cleanPeer = peer.trim().toLowerCase();
    if (!cleanPeer) return;
    const intervalId = window.setInterval(() => {
      void refreshSelectedSession(cleanPeer);
      void refreshPeerStatus(cleanPeer);
      void refreshDeviceState(cleanPeer);
    }, 6000);
    return () => clearInterval(intervalId);
  }, [peer, token]);

  useEffect(() => {
    const cleanPeer = peer.trim().toLowerCase();
    if (!cleanPeer || !privateKeyRef.current) return;
    const intervalId = window.setInterval(() => {
      void refreshSelectedHistory(cleanPeer);
    }, 4000);
    return () => clearInterval(intervalId);
  }, [peer, token, myDevices, peerDevices]);

  async function handleRequestSession(targetPeer: string) {
    const cleanPeer = targetPeer.trim().toLowerCase();
    if (!cleanPeer) return;
    setBusyAction("request");
    try {
      const next = await apiRequestSession(token, cleanPeer);
      setSession(next);
      setNotice(`Chat request sent to ${cleanPeer}.`);
      await refreshIncomingSessions();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Unable to request chat");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRespondSession(targetPeer: string, action: "accept" | "decline") {
    const cleanPeer = targetPeer.trim().toLowerCase();
    setBusyAction(action);
    try {
      const next = await apiRespondSession(token, cleanPeer, action);
      if (cleanPeer === selectedPeer) setSession(next);
      setNotice(action === "accept" ? `Chat session with ${cleanPeer} is active.` : `Declined request from ${cleanPeer}.`);
      await refreshIncomingSessions();
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Unable to update session");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleEndSession(targetPeer: string) {
    const cleanPeer = targetPeer.trim().toLowerCase();
    setBusyAction("end");
    try {
      const next = await apiEndSession(token, cleanPeer);
      if (cleanPeer === selectedPeer) setSession(next);
      setNotice(`Session with ${cleanPeer} ended.`);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Unable to end session");
    } finally {
      setBusyAction(null);
    }
  }

  async function toggleNotifications() {
    if (!notificationEnabled) {
      const permission = await requestNotificationAccess();
      if (permission !== "granted") {
        setNotice("Browser notifications were not granted.");
        return;
      }
    }

    const next = !notificationEnabled;
    localStorage.setItem(NOTIFICATION_PREF_KEY, String(next));
    setNotificationEnabled(next);
    await apiUpdateDeviceNotifications(token, localDeviceId, next).catch(() => undefined);
  }

  async function sendMessage() {
    const raw = message.trim();
    if (!raw || !selectedPeer || !privateKeyRef.current) return;

    const peerTargets = encryptablePeerDevices.map((device) => ({ username: selectedPeer, device }));
    const selfTargets = encryptableSelfDevices.map((device) => ({ username: self, device }));
    const conversationId = convId;
    const targets = [...peerTargets, ...selfTargets];
    const envelopes = await Promise.all(
      targets.map(async ({ username, device }) => {
        const shared = await sharedKeyFor(
          username,
          device.deviceId,
          device.publicKeyJwk as JsonWebKey,
          localDeviceId,
          device.deviceId,
          conversationId
        );
        return {
          username,
          deviceId: device.deviceId,
          body: await encryptToPayload(shared, raw),
        };
      })
    );

    const msgId = uid();
    setMessages((current) => [...current, { id: msgId, from: self, fromDeviceId: localDeviceId, body: raw, ts: Date.now() }]);
    sendEvent({
      kind: "msg_send",
      from: self,
      fromDeviceId: localDeviceId,
      to: selectedPeer,
      ts: Date.now(),
      convId: conversationId,
      msgId,
      envelopes,
    });
    setMessage("");
    sendEvent({ kind: "draft_clear", from: self, fromDeviceId: localDeviceId, to: selectedPeer, ts: Date.now(), convId: conversationId, draftId: myDraftId.current });
  }

  function scheduleDraft(nextText: string, cursor: number) {
    if (!selectedPeer || !privateKeyRef.current || session?.status !== "active") return;

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(async () => {
      const now = Date.now();
      if (now - lastSentAt.current < 250) {
        scheduleDraft(nextText, cursor);
        return;
      }

      lastSentAt.current = now;
      mySeq.current += 1;
      const envelopes = await Promise.all(
        encryptablePeerDevices.map(async (device) => {
          const shared = await sharedKeyFor(
            selectedPeer,
            device.deviceId,
            device.publicKeyJwk as JsonWebKey,
            localDeviceId,
            device.deviceId,
            convId
          );
          return {
            deviceId: device.deviceId,
            body: await encryptToPayload(shared, nextText),
          };
        })
      );

      sendEvent({
        kind: "draft_update",
        from: self,
        fromDeviceId: localDeviceId,
        to: selectedPeer,
        ts: now,
        convId,
        draftId: myDraftId.current,
        seq: mySeq.current,
        envelopes,
        cursor,
        expiresInMs: 3000,
      });
    }, 120);
  }

  function renderSessionActions() {
    if (!selectedPeer) {
      return <span className="status-chip muted">Select a peer to begin.</span>;
    }

    if (session?.status === "active") {
      return (
        <>
          <span className="status-chip success">Session active</span>
          <button className="secondary-button" disabled={busyAction === "end"} onClick={() => void handleEndSession(selectedPeer)} type="button">
            {busyAction === "end" ? "Ending..." : "End session"}
          </button>
        </>
      );
    }

    if (session?.status === "pending" && session.requestedBy === self) {
      return (
        <>
          <span className="status-chip warning">Request pending</span>
          <button className="secondary-button" disabled={busyAction === "end"} onClick={() => void handleEndSession(selectedPeer)} type="button">
            Cancel request
          </button>
        </>
      );
    }

    if ((session?.status === "pending" && session.requestedBy !== self) || incomingForSelected) {
      return (
        <>
          <span className="status-chip warning">Incoming request</span>
          <button className="primary-button compact" disabled={busyAction === "accept"} onClick={() => void handleRespondSession(selectedPeer, "accept")} type="button">
            Accept
          </button>
          <button className="secondary-button compact" disabled={busyAction === "decline"} onClick={() => void handleRespondSession(selectedPeer, "decline")} type="button">
            Decline
          </button>
        </>
      );
    }

    return (
      <>
        <span className="status-chip muted">No active session</span>
        <button className="primary-button compact" disabled={busyAction === "request"} onClick={() => void handleRequestSession(selectedPeer)} type="button">
          {busyAction === "request" ? "Requesting..." : "Request chat"}
        </button>
      </>
    );
  }

  return (
    <div className="chat-shell">
      <header className="chat-header surface-panel">
        <div>
          <span className="eyebrow">Encrypted peer workspace</span>
          <h1>Zchat</h1>
        </div>
        <div className="header-actions">
          <div className="identity-card">
            <span>Signed in as</span>
            <strong>{self}</strong>
            <small>{localDeviceLabel}</small>
          </div>
          <button className="secondary-button" onClick={onLogout} type="button">
            Logout
          </button>
        </div>
      </header>

      {recoveryCodeNotice ? (
        <div className="banner-card recovery-banner">
          <div>
            <strong>Save your recovery code now.</strong>
            <p>{recoveryCodeNotice}</p>
          </div>
          <button className="secondary-button" onClick={onDismissRecoveryCode} type="button">
            I saved it
          </button>
        </div>
      ) : null}

      {chatError ? <div className="banner-card error-banner">{chatError}</div> : null}
      {notice ? <div className="banner-card info-banner">{notice}</div> : null}

      <div className="chat-grid">
        <aside className="sidebar surface-panel">
          <section>
            <div className="section-heading">
              <h2>Discover peers</h2>
              <span className={`status-chip ${connected ? "success" : "muted"}`}>{connected ? "socket ready" : "connecting"}</span>
            </div>
            <input className="app-input" placeholder="Search username" value={q} onChange={(event) => setQ(event.target.value)} />
            <div className="stack-list">
              {results.map((item) => (
                <button className="list-item" key={item.username} onClick={() => setPeer(item.username)} type="button">
                  <div>
                    <strong>{item.username}</strong>
                    <span>{new Date(item.lastSeenAt).toLocaleDateString()}</span>
                  </div>
                  <span className="arrow-mark">Open</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="section-heading">
              <h2>Incoming requests</h2>
              <span>{incomingSessions.length}</span>
            </div>
            <div className="stack-list compact-list">
              {incomingSessions.length ? incomingSessions.map((item) => (
                <div className="list-card" key={`${item.peer}-${item.updatedAt ?? 0}`}>
                  <div>
                    <strong>{item.peer}</strong>
                    <span>{item.requestedBy} wants to start a secure session.</span>
                  </div>
                  <div className="inline-actions">
                    <button className="primary-button compact" onClick={() => { setPeer(item.peer); void handleRespondSession(item.peer, "accept"); }} type="button">
                      Accept
                    </button>
                    <button className="secondary-button compact" onClick={() => void handleRespondSession(item.peer, "decline")} type="button">
                      Decline
                    </button>
                  </div>
                </div>
              )) : <div className="empty-card">No incoming session requests.</div>}
            </div>
          </section>

          <section>
            <div className="section-heading">
              <h2>Devices</h2>
              <button className="secondary-button compact" onClick={() => void toggleNotifications()} type="button">
                {notificationEnabled ? "Notifications on" : "Enable alerts"}
              </button>
            </div>
            <div className="stack-list compact-list">
              {myDevices.map((device) => (
                <div className="list-card" key={device.deviceId}>
                  <div>
                    <strong>{device.deviceLabel}{device.deviceId === localDeviceId ? " (this device)" : ""}</strong>
                    <span>{device.online ? "online" : `last seen ${new Date(device.lastSeenAt).toLocaleString()}`}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="section-heading">
              <h2>Recent peers</h2>
            </div>
            <div className="stack-list compact-list">
              {recents.length ? recents.map((item) => (
                <button className="list-item" key={item} onClick={() => setPeer(item)} type="button">
                  <div>
                    <strong>{item}</strong>
                    <span>Resume or request a session</span>
                  </div>
                </button>
              )) : <div className="empty-card">Recent peers appear here after you start browsing contacts.</div>}
            </div>
          </section>
        </aside>

        <section className="workspace">
          <div className="surface-panel workspace-hero">
            <div>
              <span className="eyebrow">Peer session</span>
              <h2>{selectedPeer || "Choose a peer"}</h2>
              <p>{peerPresenceLabel}</p>
            </div>
            <div className="session-actions">{renderSessionActions()}</div>
          </div>

          <div className="surface-panel conversation-panel">
            <div className="conversation-header">
              <div className="conversation-meta">
                <strong>{convId || "No conversation selected"}</strong>
                <span>
                  {e2eeReady ? `End-to-end encryption ready across ${encryptablePeerDevices.length} peer device(s)` : "Encryption pending"}
                </span>
              </div>
            </div>

            <div className="message-stream">
              {!selectedPeer ? <div className="empty-card">Select a peer, request a secure session, then start chatting.</div> : null}
              {selectedPeer && !messages.length ? <div className="empty-card">No messages yet. Session history will appear here.</div> : null}
              {messages.map((item) => (
                <article className={`message-bubble ${item.from === self ? "mine" : "theirs"}`} key={item.id}>
                  <header>
                    <strong>{item.from}</strong>
                    <span>
                      {new Date(item.ts).toLocaleTimeString()}
                      {item.from === self && item.readAt ? ` | read ${new Date(item.readAt).toLocaleTimeString()}` : ""}
                    </span>
                  </header>
                  <p>{item.body}</p>
                </article>
              ))}
              {theirDraft ? (
                <div className="draft-card">
                  <span>{selectedPeer} is typing...</span>
                  <p>{theirDraft}</p>
                </div>
              ) : null}
            </div>
          </div>

          <div className="surface-panel composer-panel">
            <textarea
              className="composer-input"
              value={message}
              placeholder={canChat ? "Type an encrypted message" : "Start or accept a secure session to chat"}
              disabled={!canChat}
              onChange={(event) => {
                const next = event.target.value;
                setMessage(next);
                scheduleDraft(next, event.target.selectionStart ?? next.length);
              }}
            />
            <div className="composer-actions">
              <button className="primary-button" disabled={!canChat || !message.trim()} onClick={() => void sendMessage()} type="button">
                Send
              </button>
              <button
                className="secondary-button"
                disabled={!selectedPeer || !canChat}
                onClick={() => {
                  setMessage("");
                  sendEvent({ kind: "draft_clear", from: self, fromDeviceId: localDeviceId, to: selectedPeer, ts: Date.now(), convId, draftId: myDraftId.current });
                }}
                type="button"
              >
                Clear draft
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

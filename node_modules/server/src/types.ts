export type EventKind =
  | "auth"
  | "authed"
  | "error"
  | "presence"
  | "msg_send"
  | "msg_deliver"
  | "msg_read"
  | "draft_update"
  | "draft_clear";

export type ErrorEvent = { kind: "error"; ts: number; message: string };
export type AuthedEvent = { kind: "authed"; ts: number; username: string };

export type PresenceEvent = {
  kind: "presence";
  ts: number;
  username: string;
  online: boolean;
  lastSeenAt?: number;
};

export type AuthMsg = { kind: "auth"; token: string };

export type MsgSendEvent = {
  kind: "msg_send";
  from: string;
  to: string;
  ts: number;
  convId: string; // "alice|bob"
  msgId: string;
  body: string; // ciphertext
};

export type MsgDeliverEvent = {
  kind: "msg_deliver";
  from: string;
  to: string;
  ts: number;
  convId: string; // "alice|bob"
  msgId: string;
  body: string; // ciphertext
  deliveredAt?: number;
};

export type MsgReadEvent = {
  kind: "msg_read";
  from: string; // reader
  to: string;   // original sender
  ts: number;
  convId: string;
  msgId: string;
  readAt: number;
};

export type DraftUpdateEvent = {
  kind: "draft_update";
  from: string;
  to: string;
  ts: number;
  convId: string;
  draftId: string;
  seq: number;
  body: string; // ciphertext
  cursor: number;
  expiresInMs: number;
};

export type DraftClearEvent = {
  kind: "draft_clear";
  from: string;
  to: string;
  ts: number;
  convId: string;
  draftId: string;
};

export type ClientMsg =
  | AuthMsg
  | MsgSendEvent
  | MsgReadEvent
  | DraftUpdateEvent
  | DraftClearEvent;

export type ServerMsg =
  | AuthedEvent
  | ErrorEvent
  | PresenceEvent
  | MsgDeliverEvent
  | MsgReadEvent
  | DraftUpdateEvent
  | DraftClearEvent;

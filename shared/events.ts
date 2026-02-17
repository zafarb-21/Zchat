export type EventKind =
  | "msg_send"
  | "msg_deliver"
  | "draft_update"
  | "draft_clear"
  | "error";

export type BaseEvent = {
  kind: EventKind;
  from: string;
  to: string;
  ts: number;      // unix ms
  convId: string;  // sorted "alice|bob"
};

export type MsgSendEvent = BaseEvent & {
  kind: "msg_send";
  msgId: string;
  body: string; // plaintext for Phase 1
};

export type MsgDeliverEvent = BaseEvent & {
  kind: "msg_deliver";
  msgId: string;
  body: string;
};

export type DraftUpdateEvent = BaseEvent & {
  kind: "draft_update";
  draftId: string;
  seq: number;
  body: string;
  cursor: number;
  expiresInMs: number;
};

export type DraftClearEvent = BaseEvent & {
  kind: "draft_clear";
  draftId: string;
};

export type ErrorEvent = {
  kind: "error";
  ts: number;
  message: string;
};

export type ClientToServerEvent = MsgSendEvent | DraftUpdateEvent | DraftClearEvent;
export type ServerToClientEvent = MsgDeliverEvent | DraftUpdateEvent | DraftClearEvent | ErrorEvent;

export function makeConvId(a: string, b: string) {
  return [a, b].sort().join("|");
}

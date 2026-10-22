import type { Message } from "./stateStore.ts";
import type { ChatPhase } from "./bus.ts";

export type InboxSession = {
  key: string;
  name: string;
  projectId: string;
  state: "active";
  noInbox: false;
  lastTouchedAt: number | null;
};

export type ClientFrame =
  | { type: "prompt"; text: string }
  | { type: "abort" };

export type ServerFrame =
  | { type: "accepted" }
  | { type: "snapshot"; messages: Message[]; running: boolean }
  | { type: "message.delta"; messageId: string; text: string }
  | { type: "message.end"; message: Message }
  | { type: "status"; phase: ChatPhase; errorMessage?: string }
  | { type: "error"; errorMessage: string };

export type ControlFrame =
  | { type: "ready" }
  | { type: "access.changed"; projectId: string; granted: boolean }
  | { type: "project.deleted"; projectId: string }
  | { type: "session.deleted"; projectId: string; sessionKey: string };

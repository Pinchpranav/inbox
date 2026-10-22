import { EventEmitter } from "node:events";
import type { Message } from "./stateStore.ts";

export type ChatPhase = "streaming" | "idle" | "aborted" | "error";
export type BusEvent =
  | { kind: "message.delta"; sessionKey: string; messageId: string; text: string }
  | { kind: "message.end"; sessionKey: string; message: Message }
  | { kind: "status"; sessionKey: string; phase: ChatPhase; errorMessage?: string };

export type ControlEvent =
  | { type: "access.changed"; projectId: string; email: string; granted: boolean }
  | { type: "project.deleted"; projectId: string; emails: string[] }
  | { type: "session.deleted"; projectId: string; sessionKey: string };

export const EVENT = "chat";
export const CONTROL = "control";

/** Local fan-out. Each app instance owns its subscriptions and turns. */
export class AppBus extends EventEmitter {
  constructor() { super(); this.setMaxListeners(0); }
  chat(event: BusEvent): void { this.emit(EVENT, event); }
  control(event: ControlEvent): void { this.emit(CONTROL, event); }
}

// bus.ts — the in-process event bus (a Node EventEmitter).
//
// Decouples the durable sqlite write (relay persists) from the live client
// push (a subscriber receives events). The relay publishes post-commit; any
// subscriber (today a test stand-in, later the WebSocket route) listens.
// Mirrors t3code's eventPubSub + streamDomainEvents.
//
// ── FLOW ─────────────────────────────────────────────────────────────
//   relay.ts  ──bus.emit(EVENT, ev)──▶  bus  ──bus.on(EVENT, cb)──▶  chat.ts (WS route)
//   (producer: after each durable sqlite write)   (consumer: forwards to the browser)
// The bus is the middleman between "durable write" and "live push" — two
// consumers of the same event, connected by the shared `sequence`.
import { EventEmitter } from "node:events";

export type BusEventKind = "message.sent" | "message.delta" | "message.end";

/**
 * The payload that flows through the bus.
 * Produced by relay.ts (after it persists the same event to sqlite); consumed
 * by the WS route (chat.ts, built in build-cqf) which reads `kind` to decide
 * which ServerFrame to send to the browser.
 */
export interface BusEvent {
  sessionKey: string;
  kind: BusEventKind;
  messageId: string;
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  /** Global ordering key from the sqlite log (t3code sequence). */
  sequence: number;
}

/** The event name the relay emits and subscribers listen for. */
export const EVENT = "event";

/**
 * The single shared bus instance. relay.ts emits on it; the WS route
 * subscribes to it. setMaxListeners(0) = unlimited subscribers (later: one
 * per open browser tab).
 */
export const bus = new EventEmitter();
bus.setMaxListeners(0); // unlimited subscribers (later: one per open browser tab)

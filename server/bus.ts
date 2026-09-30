// bus.ts — the in-process event bus (a Node EventEmitter).
//
// Connects the durable write to the live push: the relay publishes after the
// sqlite commit, the WS route forwards to the browser. Mirrors t3code's
// eventPubSub + streamDomainEvents.
//
// ── FLOW ─────────────────────────────────────────────────────────────
//   relay.ts ──bus.emit(EVENT, ev)──▶ bus ──bus.on(EVENT, cb)──▶ chat.ts
//   The relay persists FIRST, then publishes the same event; the bus copy carries
//   only what a subscriber renders (see BusEvent).
import { EventEmitter } from "node:events";

export type BusEventKind = "message.sent" | "message.delta" | "message.end";

/**
 * The payload that flows through the bus.
 * Produced by relay.ts (after it persists the same event to sqlite); consumed
 * by the WS route (chat.ts) which reads `kind` to decide
 * which ServerFrame to send to the browser.
 *
 * Only fields a subscriber actually renders belong here. The durable ordering
 * key (write()'s sequence) and the streaming flag stay in the event log and its
 * projection payload: the bus is a fire-and-forget fan-out, and when chat.ts
 * needs the settled row it re-reads it from the store (persist-first).
 */
export interface BusEvent {
  sessionKey: string;
  kind: BusEventKind;
  messageId: string;
  role: "user" | "assistant";
  text: string;
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

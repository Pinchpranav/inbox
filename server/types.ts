// types.ts — shared protocol shapes (contracts 7.md, step2-files §6).
//
// These are the shapes that CROSS THE WIRE (HTTP/WS) between the browser and
// the server. They are separate from the DB shapes in stateStore.ts (which are
// about the database). InboxSession is just a Session restricted to active +
// not muted.
//
// ── FLOW ─────────────────────────────────────────────────────────────
//   Browser ──ClientFrame──▶ (WS /api/chat/:key) ──▶ server
//   Browser ◀──ServerFrame── (WS /api/chat/:key) ◀── server
//   Browser ◀──InboxSession[]── (GET /api/inbox) ◀── server
// These types are consumed by the routes (build-spi / build-cqf) and by the
// frontend (build-n9b / build-2c9).

import type { State } from "./stateStore.ts";

export type { State };

/**
 * contracts Flow A — the inbox rail (default entry).
 * Returned by GET /api/inbox (routes/inbox.ts). Only sessions that are
 * active AND not muted appear here.
 */
export type InboxSession = {
  key: string;
  name: string;
  projectId: string;
  state: "active"; // must be "active" to qualify
  noInbox: false; // must be false to appear
  lastTouchedAt: number | null; // null = treated recent
};

/**
 * contracts Flow C/D — WS client → server (browser sends these).
 * Sent over WS /api/chat/:key. The session key is carried by the URL path,
 * so it's optional in the frame (defensive).
 */
export type ClientFrame =
  | { type: "prompt"; text: string; sessionKey?: string } // send a message
  | { type: "abort"; sessionKey?: string }; // stop the current generation

/**
 * contracts Flow C/D — the live status of a conversation turn.
 * Sent to the browser as a { type: "status" } ServerFrame.
 */
export type Phase = "streaming" | "idle" | "aborted" | "error";

/**
 * contracts Flow C/D — WS server → client (server sends these).
 * Sent over WS /api/chat/:key. The WS route (chat.ts) is a thin subscriber to
 * the bus: it turns each BusEvent into one of these frames.
 */
export type ServerFrame =
  | { type: "message.delta"; sessionKey: string; messageId: string; text: string } // a streaming chunk
  | { type: "message.end"; sessionKey: string; message: import("./stateStore.ts").Message } // the final settled message
  | { type: "status"; sessionKey: string; phase: Phase } // streaming/idle/aborted/error
  | { type: "error"; sessionKey: string; errorMessage: string }; // something went wrong

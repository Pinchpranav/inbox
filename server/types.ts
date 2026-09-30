// types.ts — shared protocol shapes (contracts 7.md, step2-files §6).
//
// These are the shapes that CROSS THE WIRE (HTTP/WS) between the browser and
// the server. They are separate from the DB shapes in stateStore.ts (which are
// about the database). InboxSession is just a Session restricted to active +
// not muted.
//
// ── FLOW ─────────────────────────────────────────────────────────────
//   Browser ──ClientFrame──▶  WS /api/chat/:key ──▶ chat.ts
//   Browser ◀───frames──────  WS /api/chat/:key ◀── chat.ts
//   Browser ◀─InboxSession[]─  GET /api/inbox   ◀── inbox.ts
//
// The server→browser frame union is NOT declared here: the only consumer is
// the browser, which owns it as `ServerFrame`/`ChatPhase` in
// src/api/chatSocket.ts. Keep that union in step with the JSON sent by
// server/routes/chat.ts when you add or change a frame.

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

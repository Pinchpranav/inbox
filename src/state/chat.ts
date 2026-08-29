// Live conversation state, one "drawer" per thread (build-a9c: extracted from
// App.vue). `live` is a map keyed by session key; each drawer holds that
// thread's settled messages, its in-progress reply, its status line, and its
// own socket. The UI renders ONE drawer (the selected thread), but every open
// drawer keeps working — so switching threads no longer aborts a stream.
//
// The server keeps a turn running after the browser's socket closes
// (server/routes/chat.ts onClose only detaches the view), and the 5s poll
// re-syncs settled state, so a background turn's result is never lost.
//
// Dependency direction (no cycles): chat.ts → sessions.ts (touchSession),
// backend.ts (conn/connError), api, domain.

import { reactive } from "vue";
import * as api from "../api/projectsApi";
import { ChatSocket } from "../api/chatSocket";
import { conn, connError } from "./backend";
import { touchSession } from "./sessions";
import type { Message } from "../data/domain";

/** Everything that is live (not yet settled) for one thread. */
export interface LiveState {
  /** Settled messages: transcript history + finished replies. */
  messages: Message[];
  /** The assistant reply being streamed right now. */
  liveText: string;
  /** Status line under the live reply ("preparing…", "generating…"). */
  phase: string | null;
  streaming: boolean;
  socket: ChatSocket | null;
  abortFallback: ReturnType<typeof setTimeout> | null;
}

const live = reactive<Record<string, LiveState>>({});

function drawer(key: string): LiveState {
  let d = live[key];
  if (!d) {
    d = {
      messages: [],
      liveText: "",
      phase: null,
      streaming: false,
      socket: null,
      abortFallback: null,
    };
    live[key] = d;
  }
  return d;
}

/** The drawer the UI should render for `key` (creates it on first read). */
export function liveFor(key: string): LiveState {
  return drawer(key);
}

export function isStreaming(key: string): boolean {
  return live[key]?.streaming ?? false;
}

// ── history ────────────────────────────────────────────────────────────────

/** Load a thread's settled transcript into its drawer (on selection).
 *  If that thread is mid-stream, the local drawer is fresher than the
 *  persisted copy, so we keep it. */
export async function loadHistory(key: string): Promise<void> {
  const d = drawer(key);
  if (conn.value !== "ok") {
    d.messages = [];
    return;
  }
  try {
    const rows = await api.fetchMessages(key);
    if (!d.streaming) d.messages = rows;
  } catch (err) {
    if (!d.streaming) d.messages = [];
    connError.value = `messages: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── turns ─────────────────────────────────────────────────────────────────

/** Start a turn in `key`'s drawer: push the user message, open the socket,
 *  stream deltas into liveText. One turn at a time per thread. */
export function send(key: string, text: string): void {
  if (conn.value !== "ok") return;
  const d = drawer(key);
  if (d.streaming) return; // one turn at a time per thread

  d.messages.push({ id: `u${Date.now()}`, role: "user", text });
  touchSession(key);
  d.streaming = true;
  d.liveText = "";
  d.phase = "preparing…";

  const socket = new ChatSocket(key, {
    onDelta: (t) => {
      d.liveText += t;
    },
    onEnd: (m) => {
      const settled = m.text?.trim() || d.liveText || "";
      if (settled) {
        d.messages.push({ id: m.id || `a${Date.now()}`, role: "assistant", text: settled });
      }
      d.liveText = "";
    },
    onStatus: (p) => {
      if (p === "idle") {
        d.streaming = false;
        d.phase = null;
        closeTurn(key);
      } else if (p === "aborted") {
        abortReal(key);
        closeTurn(key);
      } else if (p === "error") {
        errorReal(key, "⚠ chat error");
        closeTurn(key);
      } else if (p === "streaming") {
        d.phase = "generating…";
      }
    },
    onError: (msg) => {
      errorReal(key, msg);
      closeTurn(key);
    },
    onOpen: () => {
      socket.sendPrompt(text);
    },
  });
  d.socket = socket;
  socket.connect();
}

/** Ask the server to stop the turn in `key`'s drawer. The server answers
 *  with a terminal status (aborted); the fallback timer un-hangs the UI if
 *  that never arrives. */
export function abort(key: string): void {
  const d = drawer(key);
  if (!d.streaming || !d.socket) return;
  d.socket.sendAbort();
  if (d.abortFallback) clearTimeout(d.abortFallback);
  d.abortFallback = setTimeout(() => {
    d.abortFallback = null;
    if (d.streaming) abortReal(key);
    closeTurn(key);
  }, 2000);
}

/** Close the socket + fallback timer for `key`'s drawer. */
export function closeTurn(key: string): void {
  const d = drawer(key);
  if (d.abortFallback) {
    clearTimeout(d.abortFallback);
    d.abortFallback = null;
  }
  if (d.socket) {
    d.socket.close();
    d.socket = null;
  }
}

/** Close every open turn (app unmount). */
export function closeAll(): void {
  for (const key of Object.keys(live)) closeTurn(key);
}

// ── settlement ────────────────────────────────────────────────────────────

function abortReal(key: string): void {
  const d = drawer(key);
  const partial = d.liveText;
  if (partial.trim()) {
    d.messages.push({ id: `a${Date.now()}`, role: "assistant", text: `${partial} ⏹ (stopped)` });
  }
  d.liveText = "";
  d.phase = null;
  d.streaming = false;
}

function errorReal(key: string, msg: string): void {
  const d = drawer(key);
  const text = msg?.trim() || "⚠ chat error";
  d.messages.push({ id: `a${Date.now()}`, role: "assistant", text });
  d.liveText = "";
  d.phase = null;
  d.streaming = false;
}

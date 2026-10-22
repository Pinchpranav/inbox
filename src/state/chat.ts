import { reactive } from "vue";
import { ChatSocket } from "../api/chatSocket";
import { touchSession } from "./sessions";
import type { Message } from "../data/domain";

export interface LiveState {
  messages: Message[];
  loading: boolean;
  phase: string | null;
  streaming: boolean;
  connected: boolean;
  pending: boolean;
  draft: string;
  error: string;
  socket: ChatSocket | null;
}

const live = reactive<Record<string, LiveState>>({});

export function liveFor(key: string): LiveState {
  if (!live[key]) live[key] = {
    messages: [], loading: true, phase: null, streaming: false,
    connected: false, pending: false, draft: "", error: "", socket: null,
  };
  return live[key]!;
}

function upsert(d: LiveState, message: Message): void {
  const index = d.messages.findIndex((m) => m.id === message.id);
  if (index < 0) d.messages.push(message);
  else d.messages[index] = message;
}

/** Subscribe on viewing, with history and busy state supplied by one snapshot. */
export function loadHistory(key: string): void {
  const d = liveFor(key);
  if (d.socket) return;
  const socket = new ChatSocket(key, (frame) => {
    // A deleted/revoked drawer must never be restored by late callbacks.
    if (live[key] !== d) return;
    if (frame.type === "snapshot") {
      d.messages = frame.messages.map((m) => ({ ...m, isStreaming: frame.running && m.isStreaming }));
      d.streaming = frame.running;
      d.phase = frame.running ? "generating…" : null;
      d.connected = true;
      d.loading = false;
      d.pending = false;
      d.error = "";
    } else if (frame.type === "accepted") {
      d.pending = false;
      d.draft = "";
    } else if (frame.type === "message.end") {
      upsert(d, frame.message);
      touchSession(key);
    } else if (frame.type === "message.delta") {
      const message = d.messages.find((m) => m.id === frame.messageId);
      if (message) message.text += frame.text;
      else upsert(d, { id: frame.messageId, role: "assistant", text: frame.text, isStreaming: true });
    } else if (frame.type === "status") {
      d.streaming = frame.phase === "streaming";
      d.phase = d.streaming ? "generating…" : null;
      if (!d.streaming) {
        d.pending = false;
        for (const m of d.messages) m.isStreaming = false;
      }
      if (frame.errorMessage) d.error = frame.errorMessage;
    } else if (frame.type === "error") {
      // Rejected commands do not change the conversation's shared busy state.
      d.pending = false;
      d.error = frame.errorMessage;
    }
  }, (forbidden) => {
    if (live[key] !== d) return;
    d.connected = false;
    d.pending = false;
    d.loading = false;
    d.error = forbidden ? "Conversation access ended." : "Reconnecting…";
    if (forbidden) {
      d.messages = [];
      d.draft = "";
      d.streaming = false;
    }
  });
  d.socket = socket;
  socket.connect();
}

export function send(key: string, text: string): void {
  const d = liveFor(key);
  if (!d.connected || d.streaming || d.pending) return;
  d.error = "";
  d.pending = true;
  if (!d.socket?.send({ type: "prompt", text })) {
    d.pending = false;
    d.error = "Connection unavailable. Your draft is saved.";
  }
}

export function abort(key: string): void {
  const d = liveFor(key);
  if (d.connected && d.streaming) d.socket?.send({ type: "abort" });
}

export function forget(key: string): void {
  const d = live[key];
  if (!d) return;
  d.socket?.close();
  delete live[key];
}

export function forgetProject(projectId: string): void {
  for (const key of Object.keys(live)) {
    if (key.split(":")[1] === projectId) forget(key);
  }
}

export function retainSessions(keys: Set<string>): void {
  for (const key of Object.keys(live)) if (!keys.has(key)) forget(key);
}

export function closeAll(): void {
  for (const key of Object.keys(live)) forget(key);
}

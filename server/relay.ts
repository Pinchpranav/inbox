// relay.ts — persist pi engine events first, then publish to the bus.
// Deltas buffer and flush; settle replaces with the persisted full text.

import { randomUUID } from "node:crypto";
import type { StateStore } from "./stateStore.ts";
import type { AppBus } from "./bus.ts";

interface PiEvent {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string; content?: string };
}

export interface AttachedRelay { unsubscribe(): void; }

/** Persist before publishing, including human messages seen by other viewers. */
export function recordUserMessage(store: StateStore, bus: AppBus, sessionKey: string, text: string, authorEmail: string): void {
  const messageId = randomUUID();
  store.write({ type: "message.sent", payload: { messageId, role: "user", text, sessionKey, authorEmail } });
  const message = store.getMessages(sessionKey).find((m) => m.id === messageId)!;
  bus.chat({ kind: "message.end", sessionKey, message });
}

/** Buffer assistant deltas; finish or stop with the persisted full text. */
export function attachAssistantRelay(store: StateStore, bus: AppBus, sessionKey: string, session: {
  subscribe(cb: (event: PiEvent) => void): () => void;
}): AttachedRelay {
  let messageId: string | null = null;
  let fullText = "";
  let buffer = "";

  const flush = () => {
    if (!messageId || !buffer) return;
    const text = buffer;
    buffer = "";
    store.write({ type: "message.sent", payload: { messageId, role: "assistant", text, streaming: true, sessionKey } });
    bus.chat({ kind: "message.delta", sessionKey, messageId, text });
  };
  const settle = () => {
    if (!messageId) return;
    const id = messageId;
    store.write({ type: "message.sent", payload: { messageId: id, role: "assistant", text: fullText, sessionKey } });
    messageId = null;
    buffer = "";
    const message = store.getMessages(sessionKey).find((m) => m.id === id)!;
    bus.chat({ kind: "message.end", sessionKey, message });
  };
  const timer = setInterval(flush, 1000);
  const detach = session.subscribe((event) => {
    const update = event.assistantMessageEvent;
    if (event.type !== "message_update" || !update) return;
    if (update.type === "text_start") {
      settle();
      messageId = randomUUID();
      fullText = "";
      buffer = "";
    } else if (update.type === "text_delta" && messageId) {
      const text = update.delta ?? "";
      fullText += text;
      buffer += text;
    } else if (update.type === "text_end" && messageId) {
      fullText = update.content ?? fullText;
      settle();
    }
  });
  return {
    unsubscribe() {
      clearInterval(timer);
      detach();
      settle();
    },
  };
}

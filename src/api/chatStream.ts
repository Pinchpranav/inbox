// Chat stream reconciliation + history helpers for the thin sidebar app.
//
// `resolveDeltaChatStreamText` is copied faithfully from
// openclaw/ui/src/pages/chat/chat-gateway.ts — the core rule the Control UI
// uses to reconcile `delta` events: full reset on `replace`, append on
// increment, resync to the message snapshot when the prefix drifts.
//
// We deliberately do NOT replicate the Control UI's full tool-stream / segment
// / keyed-item / run-lifecycle machinery — this is a thin viewer that only
// needs visible assistant text. That matches the project's stated scope.

// ── Wire types (subset of the gateway `chat` event payload) ───────────────

export type ChatState = "status" | "delta" | "final" | "aborted" | "error";

export interface ChatEventPayload {
  state?: ChatState;
  runId?: string;
  sessionKey?: string;
  phase?: string;
  deltaText?: string;
  replace?: boolean;
  message?: unknown;
  errorMessage?: string;
}

export interface ChatHistoryMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
}

// ── resolveDeltaChatStreamText (verbatim rule) ────────────────────────────

export function resolveDeltaChatStreamText(
  currentStream: string | null,
  payload: ChatEventPayload,
): string | null {
  const snapshot = payload.message == null ? null : extractMessageText(payload.message);
  if (typeof payload.deltaText === "string") {
    if (payload.replace === true) {
      return payload.deltaText;
    }
    if (currentStream === null) {
      return typeof snapshot === "string" ? snapshot : payload.deltaText;
    }
    if (typeof snapshot === "string") {
      const prefixLength = snapshot.length - payload.deltaText.length;
      if (
        prefixLength !== currentStream.length ||
        snapshot.slice(0, prefixLength) !== currentStream
      ) {
        return snapshot;
      }
    }
    return `${currentStream}${payload.deltaText}`;
  }
  return typeof snapshot === "string" ? snapshot : null;
}

// ── Message text extraction ──────────────────────────────────────────────

/** Extract visible text from a gateway chat message.
 *  Handles `content` as a string or as an array of `{ type: "text", text }` blocks. */
export function extractMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const m = message as { content?: unknown; text?: unknown };
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    const parts = m.content
      .map((block) =>
        block && typeof block === "object" && (block as { type?: string }).type === "text"
          ? (block as { text?: unknown }).text
          : null,
      )
      .filter((t): t is string => typeof t === "string");
    return parts.length > 0 ? parts.join("") : null;
  }
  if (typeof m.text === "string") return m.text;
  return null;
}

// ── History → app Message mapping ─────────────────────────────────────────

export interface AppMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** Map gateway chat.history rows onto the app's simple Message type.
 *  Keeps only user + assistant rows with visible text. */
export function mapHistoryMessages(rows: unknown[]): AppMessage[] {
  const out: AppMessage[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as ChatHistoryMessage;
    const role = typeof r.role === "string" ? r.role.toLowerCase() : "";
    if (role !== "user" && role !== "assistant") continue;
    const text = extractMessageText(row)?.trim();
    if (!text) continue;
    out.push({
      id: `h${out.length}-${(r.timestamp ?? Date.now()).toString(36)}`,
      role: role as "user" | "assistant",
      text,
    });
  }
  return out;
}
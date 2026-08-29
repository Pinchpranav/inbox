// these shapes describe the world the app renders (projects, sessions,
// messages) and are shared by the state modules (backend/sessions/chat) and
// the components.

export type State = "active" | "deferred" | "done";

export interface Project {
  id: string; // == agent id
  name: string;
  state: State;
  emoji?: string; // from agent identity (gateway only)
}

export interface Session {
  key: string; // "agent:<projectId>:<thread>"
  name: string;
  agentId: string; // project id
  state: State;
  noInbox: boolean;
  updatedAt: number; // ms epoch
  /** Selected model slug (build-gw6.5.1). null = backend default. */
  modelId?: string | null;
  /** Selected thinking level (build-gw6.5.1). null = "off". */
  thinkingLevel?: string | null;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
}

/** A model as returned by GET /api/models (build-gw6.5.1). */
export interface ModelEntry {
  id: string;
  name: string;
  /** undefined = model does not reason (no thinking levels). */
  thinkingLevelMap: Record<string, string | null> | undefined;
  input: string[];
}

const HOUR = 60 * 60 * 1000;

/** Inbox window: active threads touched within the last 48h. */
export const INBOX_WINDOW_MS = 48 * HOUR;

// Inbox rule (mirrors plugins/projects/src/panel.js):
//   active + not noInbox + touched within last 48h (null/unknown treated as recent).
export function isInInbox(s: Session): boolean {
  if (s.state !== "active") return false;
  if (s.noInbox) return false;
  if (!s.updatedAt) return true;
  return Date.now() - s.updatedAt <= INBOX_WINDOW_MS;
}

export function stateLabel(state: State): string {
  return { active: "Active", deferred: "Deferred", done: "Done" }[state];
}

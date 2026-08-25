// Dummy data for the design MVP. No backend — this stands in for what the
// projects plugin REST route + the gateway will give us later.

export type State = "active" | "deferred" | "done";

export interface Project {
  id: string; // == agent id
  name: string;
  state: State;
  emoji?: string; // from agent identity (gateway only; mock has none)
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
const now = Date.now();

export const projects: Project[] = [
  { id: "tax-bot", name: "Tax Bot", state: "active" },
  { id: "website-revamp", name: "Website Revamp", state: "active" },
  { id: "research", name: "Research", state: "done" },
];

export const sessions: Session[] = [
  // Tax Bot — active threads
  {
    key: "agent:tax-bot:1",
    name: "GST reconciliation for Q1",
    agentId: "tax-bot",
    state: "active",
    noInbox: false,
    updatedAt: now - 2 * HOUR,
  },
  {
    key: "agent:tax-bot:2",
    name: "Notice reply — jurisdiction issue",
    agentId: "tax-bot",
    state: "active",
    noInbox: false,
    updatedAt: now - 30 * 60 * 1000,
  },
  {
    key: "agent:tax-bot:3",
    name: "Archived: FY24 workings",
    agentId: "tax-bot",
    state: "done",
    noInbox: true,
    updatedAt: now - 200 * HOUR,
  },
  // Website Revamp — mixed
  {
    key: "agent:website-revamp:1",
    name: "Hero section copy",
    agentId: "website-revamp",
    state: "active",
    noInbox: false,
    updatedAt: now - 5 * HOUR,
  },
  {
    key: "agent:website-revamp:2",
    name: "Pricing page refactor",
    agentId: "website-revamp",
    state: "deferred",
    noInbox: false,
    updatedAt: now - 40 * HOUR,
  },
  {
    key: "agent:website-revamp:3",
    name: "404 page (waiting on assets)",
    agentId: "website-revamp",
    state: "deferred",
    noInbox: true,
    updatedAt: now - 70 * HOUR,
  },
  // Research — done project
  {
    key: "agent:research:1",
    name: "Competitor pricing scan",
    agentId: "research",
    state: "done",
    noInbox: true,
    updatedAt: now - 500 * HOUR,
  },
];

export const messagesBySession: Record<string, Message[]> = {
  "agent:tax-bot:1": [
    {
      id: "m1",
      role: "user",
      text: "Can you reconcile the Q1 GST? The books are in /data/books.",
    },
    {
      id: "m2",
      role: "assistant",
      text: "Sure. I'll pull the sales and purchase registers, cross-check the input-tax credit, and flag any mismatches. Starting now.",
    },
    {
      id: "m3",
      role: "user",
      text: "Also add the late-fee column we talked about.",
    },
    {
      id: "m4",
      role: "assistant",
      text: "Added. The late-fee column is computed per the slab we agreed on last quarter. Three rows were above the threshold — highlighted in the report:\n\n| Row | Value |\n|---|---|\n| 12 | ₹4,200 |\n| 18 | ₹1,150 |\n\n```py\nfee = slab(amount)\n```",
    },
  ],
};

// A canned reply used by the mock streamer when you send a message.
export const mockReply =
  "Working on it. Here's the plan:\n\n1. Read the relevant files\n2. Draft a change\n3. Show you a diff\n\n```ts\nconst answer = 42;\n```\n\nStreaming the steps as I go.";;

// Inbox rule (mirrors plugins/projects/src/panel.js):
//   active + not noInbox + touched within last 48h (null/unknown treated as recent).
export const INBOX_WINDOW_MS = 48 * HOUR;

export function isInInbox(s: Session): boolean {
  if (s.state !== "active") return false;
  if (s.noInbox) return false;
  if (!s.updatedAt) return true;
  return Date.now() - s.updatedAt <= INBOX_WINDOW_MS;
}

export function stateLabel(state: State): string {
  return { active: "Active", deferred: "Deferred", done: "Done" }[state];
}
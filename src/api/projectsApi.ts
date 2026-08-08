// Client for the openclaw `projects` plugin REST route.
// Route: {gateway}/plugins/projects/api  (auth = gateway Bearer token)
//
//   GET  → { ok, state, agents, sessions }  (merged view in one call)
//   POST → { op, ...fields }                (mutations; see index.ts)
//
// We map the gateway response onto the app's existing domain types
// (Project / Session from ../data/mock), so the UI components don't change.

import type { Project, Session, State } from "../data/mock";

// ── Gateway wire types (subset of what the plugin returns) ──────────────

interface ProjectsStore {
  version: 1;
  projects: Record<string, State>;
  sessions: Record<string, { state: State; noInbox?: boolean }>;
}

interface AgentRow {
  id: string;
  name?: string;
  identity?: { emoji?: string };
}

interface SessionRow {
  key: string;
  displayName?: string;
  label?: string;
  updatedAt: number | null;
  archived?: boolean;
  agentId?: string; // enriched by the plugin's GET handler
}

interface GetResponse {
  ok: true;
  state: ProjectsStore;
  agents: AgentRow[];
  sessions: SessionRow[];
}

interface ErrorResponse {
  ok: false;
  error: string;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

// ── Config injection ─────────────────────────────────────────────────────

export interface GatewayClient {
  url: string;
  token: string;
}

function apiUrl(c: GatewayClient): string {
  return `${c.url.replace(/\/+$/, "")}/plugins/projects/api`;
}

async function request<T>(
  c: GatewayClient,
  init: RequestInit,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(c), init);
  } catch (err) {
    throw new GatewayError(
      `Network error reaching ${apiUrl(c)} — ${String(err)}`,
    );
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new GatewayError(
      `Gateway returned non-JSON (status ${res.status})`,
      res.status,
    );
  }
  if (!res.ok) {
    const msg =
      (body as ErrorResponse | null)?.error ??
      `Gateway error (status ${res.status})`;
    throw new GatewayError(msg, res.status);
  }
  return body as T;
}

function authHeaders(c: GatewayClient): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${c.token}`,
  };
}

// ── READ: merge gateway view → app domain types ──────────────────────────

export interface SidebarView {
  projects: Project[];
  sessions: Session[];
}

/** Map a GET response onto the app's Project[]/Session[] domain types. */
export function mapView(body: GetResponse): SidebarView {
  const { state, agents, sessions } = body;

  const projects: Project[] = agents.map((a) => ({
    id: a.id,
    name: a.name?.trim() || a.id,
    state: state.projects[a.id] ?? "active",
    emoji: a.identity?.emoji,
  }));

  const mapped: Session[] = sessions.map((s) => {
    const key = s.key;
    const ss = state.sessions[key];
    const agentId = s.agentId ?? parseAgentIdFromKey(key) ?? "";
    return {
      key,
      name: s.displayName?.trim() || s.label?.trim() || key,
      agentId,
      state: ss?.state ?? "active",
      noInbox: ss?.noInbox === true,
      // updatedAt null → 0; mock isInInbox treats 0 as "recent" (matches plugin intent).
      updatedAt: s.updatedAt ?? 0,
    };
  });

  // Drop sessions whose project isn't in the agent list (orphaned transcripts).
  const known = new Set(projects.map((p) => p.id));
  const filtered = mapped.filter((s) => known.has(s.agentId));

  return { projects, sessions: filtered };
}

function parseAgentIdFromKey(key: string): string | null {
  const parts = key.split(":");
  if (parts.length >= 2 && parts[0] === "agent") return parts[1];
  return null;
}

export async function fetchView(c: GatewayClient): Promise<SidebarView> {
  const body = await request<GetResponse>(c, {
    method: "GET",
    headers: authHeaders(c),
  });
  return mapView(body);
}

// ── WRITE: POST ops ──────────────────────────────────────────────────────

interface OkResponse {
  ok: true;
  project?: { id: string };
  session?: { key: string };
  newKey?: string;
}

async function postOp(
  c: GatewayClient,
  payload: Record<string, unknown>,
): Promise<OkResponse> {
  return request<OkResponse>(c, {
    method: "POST",
    headers: authHeaders(c),
    body: JSON.stringify(payload),
  });
}

export function setSessionState(
  c: GatewayClient,
  key: string,
  state: State,
): Promise<OkResponse> {
  return postOp(c, { op: "setSessionState", key, state });
}

export function setProjectState(
  c: GatewayClient,
  agentId: string,
  state: State,
): Promise<OkResponse> {
  return postOp(c, { op: "setProjectState", agentId, state });
}

export function setNoInbox(
  c: GatewayClient,
  key: string,
  value: boolean,
): Promise<OkResponse> {
  return postOp(c, { op: "setNoInbox", key, value });
}

export function createProject(
  c: GatewayClient,
  name: string,
  emoji?: string,
): Promise<OkResponse> {
  return postOp(c, { op: "createProject", name, emoji });
}

export function createThread(
  c: GatewayClient,
  agentId: string,
  label?: string,
): Promise<OkResponse> {
  return postOp(c, { op: "createThread", agentId, label });
}

export function moveThread(
  c: GatewayClient,
  key: string,
  destAgentId: string,
): Promise<OkResponse> {
  return postOp(c, { op: "moveThread", key, destAgentId });
}
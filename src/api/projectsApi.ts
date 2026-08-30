// Client for the Hono backend (server/index.ts) REST routes.
//
//   GET   /api/projects                → Project[]
//   POST  /api/projects                → { ok, project:{id} }        (body: {name, dir})
//   PATCH /api/projects/:id/state      → { ok:true }                 (body: {state})
//   GET   /api/projects/:id/sessions   → Session[]
//   POST  /api/projects/:id/sessions   → { ok, session:{key} }       (body: {name?})
//   GET   /api/sessions/:key/messages  → Message[]
//   PATCH /api/sessions/:key/state     → { ok:true }                 (body: {state})
//   PATCH /api/sessions/:key/noInbox   → { ok:true }                 (body: {noInbox})
//   POST  /api/sessions/:key/move       → { ok, session:{key} }      (body: {destProjectId})
//   GET   /api/inbox                   → InboxSession[]
//
// We map the backend wire shapes onto the app's existing domain types
// (Project / Session / Message from ../data/domain), so the UI components
// don't change.

import type { Project, Session, Message, State, ModelEntry } from "../data/domain";
import { baseUrl } from "../config";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ── Backend wire shapes (subset of what the routes return) ────────────────

interface BackendProject {
  id: string;
  name: string;
  emoji?: string;
  dir: string;
  state: State;
  createdAt: number;
  updatedAt: number;
}

interface BackendSession {
  key: string;
  name: string;
  projectId: string;
  state: State;
  noInbox: boolean;
  lastTouchedAt: number | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
}

interface BackendMessage {
  id: string;
  sessionKey: string;
  role: "user" | "assistant";
  text: string;
  isStreaming: boolean;
  timestamp: number;
  idx: number;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function api(path: string): string {
  const base = baseUrl();
  return `${base}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(api(path), init);
  } catch (err) {
    throw new ApiError(`Network error reaching ${api(path)} — ${String(err)}`);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(`Backend returned non-JSON (status ${res.status})`, res.status);
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Backend error (status ${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

// ── Mapping backend → app domain types ───────────────────────────────────

function mapProject(p: BackendProject): Project {
  return { id: p.id, name: p.name, state: p.state, emoji: p.emoji };
}

function mapSession(s: BackendSession): Session {
  return {
    key: s.key,
    name: s.name,
    agentId: s.projectId,
    state: s.state,
    noInbox: s.noInbox,
    // lastTouchedAt null → 0; mock isInInbox treats 0 as "recent".
    updatedAt: s.lastTouchedAt ?? 0,
    modelId: s.modelId ?? null,
    thinkingLevel: s.thinkingLevel ?? null,
  };
}

function mapMessage(m: BackendMessage): Message {
  return { id: m.id, role: m.role, text: m.text };
}

// ── READ ──────────────────────────────────────────────────────────────────

export interface SidebarView {
  projects: Project[];
  sessions: Session[];
}

/** Load all projects + every project's sessions (the sidebar view). */
export async function fetchView(): Promise<SidebarView> {
  const projects = (await request<BackendProject[]>("/api/projects")).map(mapProject);
  const sessions: Session[] = [];
  for (const p of projects) {
    const rows = await request<BackendSession[]>(`/api/projects/${encodeURIComponent(p.id)}/sessions`);
    sessions.push(...rows.map(mapSession));
  }
  return { projects, sessions };
}

/** Load a conversation's transcript (not the live stream). */
export async function fetchMessages(key: string): Promise<Message[]> {
  const rows = await request<BackendMessage[]>(`/api/sessions/${encodeURIComponent(key)}/messages`);
  return rows.map(mapMessage);
}

/** GET /api/sessions/:key/status — is a turn running on this conversation? */
export async function fetchSessionStatus(key: string): Promise<boolean> {
  const res = await request<{ running: boolean }>(`/api/sessions/${encodeURIComponent(key)}/status`);
  return res.running;
}

// ── WRITE ─────────────────────────────────────────────────────────────────

export async function createProject(name: string, dir: string): Promise<{ id: string }> {
  const res = await request<{ ok: true; project: { id: string } }>("/api/projects", json("POST", { name, dir }));
  return res.project;
}

export async function setProjectState(id: string, state: State): Promise<void> {
  await request(`/api/projects/${encodeURIComponent(id)}/state`, json("PATCH", { state }));
}

export async function createThread(projectId: string, name?: string): Promise<{ key: string }> {
  const res = await request<{ ok: true; session: { key: string } }>(
    `/api/projects/${encodeURIComponent(projectId)}/sessions`,
    json("POST", { name }),
  );
  return res.session;
}

export async function setSessionState(key: string, state: State): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(key)}/state`, json("PATCH", { state }));
}

export async function setNoInbox(key: string, value: boolean): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(key)}/noInbox`, json("PATCH", { noInbox: value }));
}

export async function moveSession(key: string, destProjectId: string): Promise<{ key: string }> {
  const res = await request<{ ok: true; session: { key: string } }>(
    `/api/sessions/${encodeURIComponent(key)}/move`,
    json("POST", { destProjectId }),
  );
  return res.session;
}

/** GET /api/models — the catalog for the composer picker (build-gw6.5.1). */
export async function getModels(): Promise<ModelEntry[]> {
  return request<ModelEntry[]>("/api/models");
}

/** PATCH /api/sessions/:key/model — persist the chosen model (event-sourced). */
export async function setSessionModel(key: string, modelId: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(key)}/model`, json("PATCH", { model: modelId }));
}

/** PATCH /api/sessions/:key/thinking — persist the chosen thinking level. */
export async function setSessionThinking(key: string, level: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(key)}/thinking`, json("PATCH", { level }));
}

/** POST /api/sessions/zdr — global ZDR toggle (x-cmd-zdr on every request). */
export async function setZdr(zdr: boolean): Promise<void> {
  await request("/api/sessions/zdr", json("POST", { zdr }));
}

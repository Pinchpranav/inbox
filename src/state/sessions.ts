// The app's world model (build-a9c: extracted from App.vue). Owns: the
// projects list, the sessions (threads) list, which one is selected, the
// 5s poll that keeps both fresh, and the write actions (new project/thread,
// state, noInbox, move, per-session model/thinking).
//
// Each write action updates the list on screen first, then asks the backend,
// and re-syncs from the backend if it says no (the poll is the repair path).
//
// Read by: Sidebar (lists + selection), ChatView/Composer (selected session's
// name/state/model/thinking), chat.ts (touchSession on settle).
//
// Dependency direction (no cycles): sessions.ts → backend.ts, api, domain.
// chat.ts → sessions.ts, backend.ts. App.vue composes them.

import { ref, computed } from "vue";
import * as api from "../api/projectsApi";
import { connError, refreshView, type ViewData } from "./backend";
import type { Project, Session, State } from "../data/domain";

// ── state ──────────────────────────────────────────────────────────────────
export const projects = ref<Project[]>([]);
export const sessions = ref<Session[]>([]);
export const selectedKey = ref<string | null>(null);

export const selectedSession = computed(
  () => sessions.value.find((s) => s.key === selectedKey.value) ?? null,
);
export const selectedProjectName = computed(() => {
  const s = selectedSession.value;
  if (!s) return "";
  return projects.value.find((p) => p.id === s.agentId)?.name ?? s.agentId;
});

// ── the 5s poll (this module drives it — the poll keeps the VIEW fresh) ───
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startPolling(): void {
  stopPolling();
  void pollOnce();
  pollTimer = setInterval(() => void pollOnce(), 5000);
}

export function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** One reachability check: adopt the backend's view, or keep the current one. */
async function pollOnce(): Promise<void> {
  const view = await refreshView();
  if (view) adoptView(view);
}

/** Adopt a backend view: replace both lists, drop a selection that vanished. */
export function adoptView(view: ViewData): void {
  projects.value = view.projects;
  sessions.value = view.sessions;
  if (selectedKey.value && !sessions.value.some((s) => s.key === selectedKey.value)) {
    selectedKey.value = null;
  }
}

// ── selection ──────────────────────────────────────────────────────────────

/** Switch which thread is visible. (App.vue also calls chat.loadHistory(key);
 *  other threads keep streaming — chat.ts state is keyed per session.) */
export function selectSession(key: string): void {
  selectedKey.value = key;
}

/** Bump a thread's recency locally (chat.ts calls this when a turn starts).
 *  The next poll overwrites it with the server's timestamp. */
export function touchSession(key: string): void {
  const s = sessions.value.find((x) => x.key === key);
  if (s) s.updatedAt = Date.now();
}

// ── write actions (screen first, backend second, poll repairs) ────────────

export function newProject(name: string, dir: string): void {
  void api
    .createProject(name, dir)
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
    })
    .finally(() => void pollOnce());
}

export function newThread(agentId: string, name: string): void {
  void api
    .createThread(agentId, name)
    .then((res) => {
      void pollOnce().then(() => {
        if (res.key) selectedKey.value = res.key;
      });
    })
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
      void pollOnce();
    });
}

export function setSessionState(key: string, state: State): void {
  const s = sessions.value.find((x) => x.key === key);
  if (s) s.state = state; // screen first
  void api
    .setSessionState(key, state)
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
      void pollOnce();
    });
}

export function toggleNoInbox(key: string): void {
  const s = sessions.value.find((x) => x.key === key);
  if (!s) return;
  s.noInbox = !s.noInbox; // screen first
  const next = s.noInbox;
  void api
    .setNoInbox(key, next)
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
      void pollOnce();
    });
}

export function moveSession(key: string, destAgentId: string): void {
  void api
    .moveSession(key, destAgentId)
    .then((res) => {
      void pollOnce().then(() => {
        // The move re-keys the session; keep the user on it.
        if (res.key && selectedKey.value === key) selectedKey.value = res.key;
      });
    })
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
      void pollOnce();
    });
}

export function setProjectState(agentId: string, state: State): void {
  const p = projects.value.find((x) => x.id === agentId);
  if (p) p.state = state; // screen first
  void api
    .setProjectState(agentId, state)
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
      void pollOnce();
    });
}

// ── per-session model + thinking (build-gw6.5.1) ──────────────────────────

export const selectedModelId = computed(() => selectedSession.value?.modelId ?? null);
export const selectedThinking = computed(() => selectedSession.value?.thinkingLevel ?? null);

export function setSessionModel(key: string, modelId: string): void {
  const s = sessions.value.find((x) => x.key === key);
  if (s) s.modelId = modelId; // screen first
  void api
    .setSessionModel(key, modelId)
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
      void pollOnce();
    });
}

export function setSessionThinking(key: string, level: string): void {
  const s = sessions.value.find((x) => x.key === key);
  if (s) s.thinkingLevel = level; // screen first
  void api
    .setSessionThinking(key, level)
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
      void pollOnce();
    });
}

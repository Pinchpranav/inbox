// The app's relationship with the backend server (build-a9c: extracted from
// App.vue). Owns: the configured URL, the connection state, the model catalog,
// and the global ZDR switch.
//
// It does NOT own the poll — sessions.ts drives it (the poll exists to keep
// the sidebar view fresh), and calls refreshView() below. Nothing in this
// module imports the sidebar or chat state, so there are no cycles:
//   sessions.ts → backend.ts,  chat.ts → backend.ts + sessions.ts

import { ref } from "vue";
import * as api from "../api/projectsApi";
import {
  loadConfig,
  saveConfig,
  clearConfig,
  type BackendConfig,
} from "../config";
import type { ModelEntry, Project, Session } from "../data/domain";

/** ok = backend reachable · loading = a check is in flight · error = unreachable. */
export type Conn = "ok" | "loading" | "error";

/** The full sidebar view as returned by the backend (wire-mapped). */
export interface ViewData {
  projects: Project[];
  sessions: Session[];
}

// ── state (module-level singletons — the app is a single page) ─────────────
export const config = ref<BackendConfig>(loadConfig());
export const conn = ref<Conn>("loading");
export const connError = ref("");
export const models = ref<ModelEntry[]>([]);
export const zdrOn = ref(true);

// ── connectivity ───────────────────────────────────────────────────────────

/**
 * One full reachability check: fetch the sidebar view, set conn/connError,
 * and (once) refresh the model catalog. Returns null when the backend is
 * unreachable — the caller (sessions.ts) keeps its current data in that case.
 */
export async function refreshView(): Promise<ViewData | null> {
  try {
    const view = await api.fetchView();
    conn.value = "ok";
    connError.value = "";
    // The model catalog is static on the server side — fetch it once per
    // page load instead of on every 5s poll.
    if (models.value.length === 0) {
      void api
        .getModels()
        .then((m) => (models.value = m))
        .catch(() => {
          /* picker stays empty until the backend answers */
        });
    }
    return view;
  } catch (err) {
    conn.value = "error";
    connError.value = err instanceof api.ApiError ? err.message : String(err);
    return null;
  }
}

// ── settings actions ───────────────────────────────────────────────────────

/** Persist a saved URL. The caller restarts the poll to re-check connectivity. */
export function applySavedConfig(cfg: BackendConfig): void {
  saveConfig(cfg);
  config.value = cfg;
}

/** Forget the saved URL (back to same-origin). Caller restarts the poll. */
export function applyClearedConfig(): void {
  clearConfig();
  config.value = { url: "" };
}

// ── global ZDR toggle ──────────────────────────────────────────────────────

export async function toggleZdr(): Promise<void> {
  const next = !zdrOn.value;
  zdrOn.value = next; // optimistic
  if (conn.value !== "ok") return;
  try {
    await api.setZdr(next);
  } catch {
    zdrOn.value = !next; // rollback on failure
  }
}

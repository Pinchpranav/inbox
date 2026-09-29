// The app's relationship with the backend server: the configured URL, connection
// state, model catalog, and the global ZDR switch.
//
// Does NOT own the poll — sessions.ts drives it and calls refreshView() below.
// Nothing here imports the sidebar or chat state, so there are no cycles:
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
 * One reachability check: fetch the sidebar view, set conn/connError, and
 * refresh the model catalog + ZDR state. Returns null when unreachable —
 * the caller (sessions.ts) keeps its current data in that case.
 */
export async function refreshView(): Promise<ViewData | null> {
  try {
    const view = await api.fetchView();
    conn.value = "ok";
    connError.value = "";
    // Model catalog: static server-side, fetch once per page load.
    if (models.value.length === 0) {
      void api
        .getModels()
        .then((m) => (models.value = m))
        .catch(() => {
          /* picker stays empty until the backend answers */
        });
    }
    // ZDR: seed from the server each poll so the button always shows the truth.
    void api
      .getZdr()
      .then((s) => {
        zdrOn.value = s.zdr;
      })
      .catch(() => {
        /* keep last known state */
      });
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

/**
 * Toggle the global ZDR switch. The button only moves when the server confirms,
 * so it never claims a state the backend isn't in. Failures land in connError
 * (cleared by the next healthy poll).
 */
export async function toggleZdr(): Promise<void> {
  if (conn.value !== "ok") {
    connError.value = "ZDR toggle not sent — backend unreachable";
    return;
  }
  const next = !zdrOn.value;
  try {
    await api.setZdr(next);
    zdrOn.value = next;
  } catch (err) {
    connError.value = `ZDR toggle failed: ${err instanceof api.ApiError ? err.message : String(err)}`;
  }
}

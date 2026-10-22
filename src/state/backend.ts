// The app's relationship with the backend server: the configured URL, connection
// state, model catalog, and the global ZDR switch.
//
// Does NOT own the poll — sessions.ts drives it and calls refreshView() below.
// Nothing here imports the sidebar or chat state, so there are no cycles:
//   sessions.ts → backend.ts,  chat.ts → backend.ts + sessions.ts

import { ref } from "vue";
import * as api from "../api/projectsApi";
import type { ModelEntry, Project, Session } from "../data/domain";

/** ok = backend reachable · loading = a check is in flight · error = unreachable. */
export type Conn = "ok" | "loading" | "error";

/** The full sidebar view as returned by the backend (wire-mapped). */
export interface ViewData {
  projects: Project[];
  sessions: Session[];
}

// ── state (module-level singletons — the app is a single page) ─────────────
export const conn = ref<Conn>("loading");
export const connError = ref("");
export const models = ref<ModelEntry[]>([]);
export const zdrOn = ref(true);
export const currentUser = ref<api.CurrentUser | null>(null);

// ── connectivity ───────────────────────────────────────────────────────────

/**
 * One reachability check: fetch the sidebar view, set conn/connError, and
 * refresh the model catalog + ZDR state. Returns null when unreachable —
 * the caller (sessions.ts) keeps its current data in that case.
 */
export async function refreshView(isCurrent: () => boolean = () => true): Promise<ViewData | null> {
  try {
    const user = await api.getMe();
    const view = await api.fetchView();
    if (!isCurrent()) return null;
    currentUser.value = user;
    conn.value = "ok";
    connError.value = "";
    // Model catalog: static server-side, fetch once per page load.
    if (models.value.length === 0) {
      void api
        .getModels()
        .then((m) => { if (isCurrent()) models.value = m; })
        .catch(() => {
          /* picker stays empty until the backend answers */
        });
    }
    // ZDR: seed from the server each poll so the button always shows the truth.
    void api
      .getZdr()
      .then((s) => {
        if (isCurrent()) zdrOn.value = s.zdr;
      })
      .catch(() => {
        /* keep last known state */
      });
    return view;
  } catch (err) {
    if (!isCurrent()) return null;
    if (err instanceof api.ApiError && err.status === 401) currentUser.value = null;
    conn.value = "error";
    connError.value = err instanceof api.ApiError ? err.message : String(err);
    return null;
  }
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

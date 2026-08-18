// Backend connection config for the thin sidebar app.
//
// The app talks to the Hono backend (server/index.ts) over HTTP + WS. In dev the
// Vite server proxies `/api` → the backend (see vite.config.ts), so the default
// base URL is "" (same-origin). Set VITE_BACKEND_URL (or the in-app Settings
// panel, stored in localStorage) to point at a backend on another origin.
//
// Precedence: localStorage override → Vite env → "" (same-origin).

const LS_KEY = "openclaw-sidebar.backend";

export interface BackendConfig {
  /** Base URL of the backend, e.g. http://localhost:8787 (no trailing slash). "" = same-origin. */
  url: string;
}

export function defaultConfig(): BackendConfig {
  const url = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.trim() ?? "";
  return { url };
}

export function loadConfig(): BackendConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BackendConfig>;
      const base = defaultConfig();
      return { url: (parsed.url ?? base.url).trim() };
    }
  } catch {
    /* ignore corrupt entry */
  }
  return defaultConfig();
}

export function saveConfig(cfg: BackendConfig): void {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
}

export function clearConfig(): void {
  localStorage.removeItem(LS_KEY);
}

/** The backend base URL (no trailing slash). "" = same-origin. */
export function baseUrl(): string {
  return loadConfig().url.replace(/\/+$/, "");
}

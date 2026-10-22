// Backend connection config for the thin sidebar app.
//
// The app talks to the Hono backend (server/index.ts) over HTTP + WS. In dev the
// Vite server proxies `/api` → the backend (see vite.config.ts), so the default
// base URL is "" (same-origin). Set VITE_BACKEND_URL to point at a backend on
// another origin.

/** The backend base URL (no trailing slash). "" = same-origin. */
export function baseUrl(): string {
  const url = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.trim() ?? "";
  return url.replace(/\/+$/, "");
}

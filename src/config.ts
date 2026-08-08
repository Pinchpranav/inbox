// Gateway connection config for the projects plugin REST route.
//
// Precedence: localStorage override → Vite env → empty (demo mode).
// Local dev: set VITE_GATEWAY_URL / VITE_GATEWAY_TOKEN in .env, or use the
// in-app Settings panel (stored in localStorage so it survives refresh).

const LS_KEY = "openclaw-sidebar.gateway";

export interface GatewayConfig {
  /** Base URL of the gateway, e.g. http://localhost:18789 (no trailing slash). */
  url: string;
  /** Gateway Bearer token (the projects route uses `auth: "gateway"`). */
  token: string;
}

export function defaultConfig(): GatewayConfig {
  const url = (import.meta.env.VITE_GATEWAY_URL as string | undefined)?.trim() ?? "";
  const token = (import.meta.env.VITE_GATEWAY_TOKEN as string | undefined)?.trim() ?? "";
  return { url, token };
}

export function loadConfig(): GatewayConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GatewayConfig>;
      const base = defaultConfig();
      return {
        url: (parsed.url ?? base.url).trim(),
        token: (parsed.token ?? base.token).trim(),
      };
    }
  } catch {
    /* ignore corrupt entry */
  }
  return defaultConfig();
}

export function saveConfig(cfg: GatewayConfig): void {
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
}

export function clearConfig(): void {
  localStorage.removeItem(LS_KEY);
}

/** A gateway is "configured" only when both url + token are present. */
export function isConfigured(cfg: GatewayConfig): boolean {
  return cfg.url.length > 0 && cfg.token.length > 0;
}
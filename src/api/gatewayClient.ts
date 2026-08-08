// Thin browser gateway client: constructs `GatewayProtocolClient` with
// shared-token bootstrap auth (no device pairing), fallback handshake,
// and exponential reconnect. Exposes start/stop, request, event subscription,
// a ready promise, and chat convenience methods.
//
// Auth model: per docs/gateway/clients.md the *recommended* persistent flow is
// device pairing, but the shared gateway token works as bootstrap. For this
// single-user thin app we use the token from config (same one the projects
// plugin REST route uses). Device pairing can be added later if needed.

import {
  GatewayProtocolClient,
  GatewayProtocolRequestError,
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type EventFrame,
  type GatewayProtocolCloseContext,
  type HelloOk,
} from "@openclaw/gateway-client/browser";
import { createBrowserGatewaySocket } from "./gatewaySocket";
import { createDeviceAuthLifecycle, type GatewayBrowserDeviceAuthPlan } from "./deviceAuth";

export interface GatewayClientOptions {
  /** REST base, e.g. http://localhost:18789 — converted to ws(s):// for the socket. */
  url: string;
  /** Shared gateway bearer token (bootstrap auth). */
  token: string;
  onHello?: () => void;
  onConnectError?: (error: Error) => void;
  onClose?: (willRetry: boolean) => void;
  /** Called for every gateway event frame (chat stream, sessions.changed, …). */
  onEvent?: (event: EventFrame) => void;
}

interface ConnectPlan {
  params: Record<string, unknown>;
  authPlan: GatewayBrowserDeviceAuthPlan;
}

export class ChatGatewayClient {
  private client: GatewayProtocolClient<ConnectPlan>;
  private stopped = true;
  private readyResolvers: Array<(value: void) => void> = [];
  private readyRejecters: Array<(err: Error) => void> = [];
  private opts: GatewayClientOptions;
  private wsUrl: string;
  private lifecycle = createDeviceAuthLifecycle();

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
    this.wsUrl = toWebSocketUrl(opts.url);
    let settled = false;

    this.client = new GatewayProtocolClient<ConnectPlan>({
      createSocket: (handlers) => createBrowserGatewaySocket(this.wsUrl, handlers),
      createRequestId: () =>
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      // Device-auth connect: sign the challenge nonce with our persisted
      // Ed25519 identity (grants operator scopes). Falls back to token-only
      // when no secure context (crypto.subtle unavailable).
      buildConnectPlan: async ({ nonce }) => buildConnectPlan(this.lifecycle, opts.token, nonce),
      buildConnectParams: (plan) => plan.params,
      onConnectHello: (hello, context) => {
        // Persist any device token the gateway issues for later reconnects.
        void this.lifecycle.acceptHello(hello, context.plan.authPlan);
      },
      onHello: () => {
        settled = true;
        this.readyResolvers.splice(0).forEach((r) => r());
        opts.onHello?.();
      },
      onConnectError: (error) => {
        if (!settled) {
          settled = true;
          this.readyRejecters.splice(0).forEach((r) => r(error));
        }
        opts.onConnectError?.(error);
      },
      resolveClose: (context) => this.resolveClose(context),
      onClose: (_context, decision) => {
        if (decision.notify) opts.onClose?.(decision.retry);
      },
      onSocketFactoryError: (error) => opts.onConnectError?.(error),
      onEvent: (event) => opts.onEvent?.(event),
      onCallbackError: (label, error) => console.error(`[gateway] ${label}:`, error),
      handshake: { mode: "fallback", timeoutMs: 750 },
      reconnect: { initialMs: 800, multiplier: 1.7, maxMs: 15_000 },
      requestTimeoutMs: 30_000,
    });
  }

  /** Resolve once the gateway accepts the v4 connect (hello-ok). */
  get ready(): Promise<void> {
    if (this.client.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.readyResolvers.push(resolve);
      this.readyRejecters.push(reject);
    });
  }

  get connected(): boolean {
    return this.client.connected;
  }

  start(): void {
    this.stopped = false;
    this.client.start();
  }

  stop(): void {
    this.stopped = true;
    this.client.stop();
    this.readyRejecters.splice(0).forEach((r) => r(new Error("gateway client stopped")));
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.client.request<T>(method, params);
  }

  // ── Chat convenience methods ────────────────────────────────────────────

  /** Load display-normalized chat history for a session. */
  async chatHistory(sessionKey: string): Promise<unknown[]> {
    const res = await this.client.request<{ messages?: unknown[] }>("chat.history", {
      sessionKey,
    });
    return Array.isArray(res?.messages) ? res.messages : [];
  }

  /** Dispatch a turn. Returns the runId used to match stream events + abort. */
  async chatSend(
    sessionKey: string,
    message: string,
    idempotencyKey: string,
  ): Promise<string> {
    const res = await this.client.request<{ runId?: string }>("chat.send", {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey,
    });
    const runId = typeof res?.runId === "string" && res.runId.trim() ? res.runId.trim() : idempotencyKey;
    return runId;
  }

  /** Abort the active run for a session. */
  chatAbort(sessionKey: string, runId: string): Promise<unknown> {
    return this.client.request("chat.abort", { sessionKey, runId });
  }

  private resolveClose(_context: GatewayProtocolCloseContext) {
    // Retry on any close unless we explicitly stopped. The protocol client owns
    // reconnect scheduling; we just decide whether to retry + notify.
    return { retry: !this.stopped, notify: true };
  }
}

// ── Connect params (device-auth; token bootstrap) ─────────────────────────

const OPERATOR_SCOPES = ["operator.read", "operator.write", "operator.approvals"] as const;

function clientInfo() {
  return {
    id: GATEWAY_CLIENT_IDS.WEBCHAT,
    version: "openclaw-sidebar/0.1.0",
    platform: typeof navigator !== "undefined" ? navigator.platform ?? "web" : "web",
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
  };
}

async function buildConnectPlan(
  lifecycle: ReturnType<typeof createDeviceAuthLifecycle>,
  token: string,
  nonce: string | null,
): Promise<ConnectPlan> {
  const ci = clientInfo();
  const authPlan = await lifecycle.buildPlan({
    client: ci,
    role: "operator",
    defaultScopes: OPERATOR_SCOPES,
    token,
    nonce,
  });
  return {
    authPlan,
    params: {
      minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: ci,
      role: "operator",
      scopes: authPlan.scopes,
      auth: authPlan.auth,
      ...(authPlan.device ? { device: authPlan.device } : {}),
      caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
    },
  };
}

/** Convert an http(s):// gateway URL to ws(s):// for the WebSocket transport. */
export function toWebSocketUrl(httpUrl: string): string {
  const trimmed = httpUrl.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice(8)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice(7)}`;
  // Already a ws(s):// URL or bare host — pass through.
  return trimmed.startsWith("ws://") || trimmed.startsWith("wss://")
    ? trimmed
    : `ws://${trimmed}`;
}

export { GatewayProtocolRequestError };
export type { EventFrame, HelloOk };
// Browser WebSocket adapter for the gateway protocol client.
//
// The `@openclaw/gateway-client/browser` `GatewayProtocolClient` is
// transport-agnostic: the host supplies a `GatewayProtocolSocket` that wraps
// the platform WebSocket. This is the browser adapter — copied (trimmed)
// from openclaw/ui/src/api/gateway-browser-socket.ts.
//
// A browser on a loopback origin (localhost/127.0.0.1, any port) sends the
// `Origin` header automatically, which the gateway's `local-loopback` rule
// trusts — so no shim or origin config is needed in local dev.

import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "@openclaw/gateway-client/browser";

export function createBrowserGatewaySocket(
  url: string,
  handlers: GatewayProtocolSocketHandlers,
): GatewayProtocolSocket {
  const socket = new WebSocket(url);
  let opening = true;
  let openingTimedOut = false;
  let openingTimer: ReturnType<typeof setTimeout> | undefined;

  const finishOpening = () => {
    opening = false;
    if (openingTimer !== undefined) {
      clearTimeout(openingTimer);
      openingTimer = undefined;
    }
  };

  socket.addEventListener("open", () => {
    finishOpening();
    handlers.open();
  });
  socket.addEventListener("message", (event) => handlers.message(String(event.data ?? "")));
  socket.addEventListener("close", (event) => {
    finishOpening();
    handlers.close(event.code, event.reason ?? "");
  });
  socket.addEventListener("error", () => {
    finishOpening();
    if (!openingTimedOut) handlers.error(new Error("websocket error"));
  });

  // Bound the browser's opening phase to the same default preauth budget.
  openingTimer = setTimeout(() => {
    openingTimer = undefined;
    if (!opening) return;
    opening = false;
    openingTimedOut = true;
    try {
      handlers.error(
        new Error(
          `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`,
        ),
      );
    } finally {
      socket.close();
    }
  }, DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (data) => socket.send(data),
    close: (code, reason) => {
      finishOpening();
      // Browser-initiated closes reject the shared protocol's 1008 policy code.
      socket.close(code === 1008 ? 4008 : code, reason);
    },
  };
}
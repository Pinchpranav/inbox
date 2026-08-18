// WS chat client for the Hono backend (server/routes/chat.ts).
//
// Connects to WS /api/chat/:key, sends ClientFrames ({type:"prompt"} / {type:"abort"}),
// and dispatches ServerFrames to the caller:
//   message.delta → onDelta(text)      (a streaming chunk — append to the live text)
//   message.end   → onEnd(message)     (the final settled assistant message)
//   status        → onStatus(phase)   (streaming / idle / aborted / error)
//   error         → onError(message)
//
// The server runs one turn per connection: after a prompt it streams deltas, then
// sends message.end + a terminal status (idle/aborted/error). The caller closes the
// socket when the turn settles.

export type ChatPhase = "streaming" | "idle" | "aborted" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface ChatSocketHandlers {
  onDelta: (text: string) => void;
  onEnd: (message: ChatMessage) => void;
  onStatus: (phase: ChatPhase) => void;
  onError: (message: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

type ServerFrame =
  | { type: "message.delta"; sessionKey: string; messageId: string; text: string }
  | { type: "message.end"; sessionKey: string; message: ChatMessage }
  | { type: "status"; sessionKey: string; phase: ChatPhase }
  | { type: "error"; sessionKey: string; errorMessage: string };

export class ChatSocket {
  private ws: WebSocket | null = null;
  private key: string;
  private handlers: ChatSocketHandlers;

  constructor(key: string, handlers: ChatSocketHandlers) {
    this.key = key;
    this.handlers = handlers;
  }

  /** Open the socket. The caller should send a prompt from onOpen (or right after). */
  connect(): void {
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${window.location.host}/api/chat/${encodeURIComponent(this.key)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => this.handlers.onOpen?.();
    ws.onmessage = (e) => this.handle(parseFrame(String(e.data)));
    ws.onclose = () => this.handlers.onClose?.();
    ws.onerror = () => this.handlers.onError("websocket error");
  }

  sendPrompt(text: string): void {
    this.ws?.send(JSON.stringify({ type: "prompt", text }));
  }

  sendAbort(): void {
    this.ws?.send(JSON.stringify({ type: "abort" }));
  }

  close(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private handle(frame: ServerFrame): void {
    switch (frame.type) {
      case "message.delta":
        this.handlers.onDelta(frame.text);
        break;
      case "message.end":
        this.handlers.onEnd(frame.message);
        break;
      case "status":
        this.handlers.onStatus(frame.phase);
        break;
      case "error":
        this.handlers.onError(frame.errorMessage);
        break;
    }
  }
}

function parseFrame(raw: string): ServerFrame {
  try {
    return JSON.parse(raw) as ServerFrame;
  } catch {
    return { type: "error", sessionKey: "", errorMessage: "invalid frame from server" };
  }
}

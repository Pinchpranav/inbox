import { baseUrl } from "../config";
import type { ClientFrame, ServerFrame, ControlFrame } from "../../server/types";

function socketUrl(path: string): string {
  const url = new URL(`${baseUrl()}${path}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** Reconnect to a fresh snapshot; never replay a submitted command. */
class LiveSocket<Frame> {
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private path: string, private onFrame: (frame: Frame) => void, private onDisconnect: (forbidden: boolean) => void, private retryAfterExpiry = false) {}

  connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(socketUrl(this.path));
    this.ws = ws;
    ws.onmessage = (event) => {
      if (this.stopped || this.ws !== ws) return;
      try { this.onFrame(JSON.parse(String(event.data)) as Frame); }
      catch { ws.close(); }
    };
    ws.onclose = (event) => {
      if (this.stopped || this.ws !== ws) return;
      const forbidden = event.code === 1008;
      this.onDisconnect(forbidden);
      if (!forbidden || this.retryAfterExpiry) this.retry = setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => ws.close();
  }

  send(frame: ClientFrame): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  close(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
  }
}

export class ChatSocket extends LiveSocket<ServerFrame> {
  constructor(key: string, onFrame: (frame: ServerFrame) => void, onDisconnect: (forbidden: boolean) => void) {
    super(`/api/chat/${encodeURIComponent(key)}`, onFrame, onDisconnect);
  }
}

export class ControlSocket extends LiveSocket<ControlFrame> {
  constructor(onFrame: (frame: ControlFrame) => void, onDisconnect: (forbidden: boolean) => void) {
    super("/api/events", onFrame, onDisconnect, true);
  }
}

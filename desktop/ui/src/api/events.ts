import type { ServerMessage } from "./types";

export type ConnectionState = "connecting" | "open" | "closed";

interface Handlers {
  onMessage(message: ServerMessage): void;
  onState(state: ConnectionState): void;
  /** Called after a dropped connection comes back, so the caller can resynchronize state it may have missed. */
  onReconnect(): void;
}

export function connectEvents(handlers: Handlers): () => void {
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let everOpened = false;
  let closed = false;

  const open = () => {
    handlers.onState("connecting");
    const current = new WebSocket(`ws://${location.host}/events`);
    socket = current;
    current.onopen = () => {
      if (everOpened) handlers.onReconnect();
      everOpened = true;
      attempt = 0;
      handlers.onState("open");
    };
    current.onmessage = event => {
      try { handlers.onMessage(JSON.parse(event.data) as ServerMessage); }
      catch (error) { console.error("ALPHA_EVENT_PARSE_FAILED", error); }
    };
    current.onclose = () => {
      if (closed || socket !== current) return;
      handlers.onState("closed");
      timer = setTimeout(open, Math.min(10_000, 1_000 * 2 ** attempt++));
    };
  };

  open();
  return () => {
    closed = true;
    clearTimeout(timer);
    socket?.close();
  };
}

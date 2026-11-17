import { useCallback, useEffect, useRef, useState } from "react";
import { readBankCookie, saveBankCookie } from "../shared/bank";
import type {
  ClientMessage,
  DopamineEvent,
  FlyEvictedEvent,
  FlyStats,
  LogEntry,
  ServerMessage,
  TableState,
  ThinkEvent,
  Topology,
} from "../shared/protocol";

export type Activity = { kind: "think"; event: ThinkEvent } | { kind: "dopamine"; event: DopamineEvent };

/** Spike events bypass React state: the brain canvas subscribes and animates them itself. */
export class ActivityBus {
  private readonly listeners = new Set<(activity: Activity) => void>();

  subscribe(listener: (activity: Activity) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(activity: Activity): void {
    for (const listener of this.listeners) listener(activity);
  }
}

export type ConnectionStatus = "connecting" | "open" | "closed";

const LOG_LIMIT = 60;

export function useGame() {
  const [state, setState] = useState<TableState | null>(null);
  const [topology, setTopology] = useState<Topology | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [eviction, setEviction] = useState<FlyEvictedEvent | null>(null);
  const [stats, setStats] = useState<FlyStats | null>(null);
  const [bet, setBet] = useState(() => readBankCookie(document.cookie).bet);
  const socketRef = useRef<WebSocket | null>(null);
  const busRef = useRef(new ActivityBus());

  // Keep balances (and the chosen bet) in a cookie the server reads on reconnect.
  const bank = state?.bank;
  useEffect(() => {
    if (bank) saveBankCookie({ ...bank, bet });
  }, [bank, bet]);

  // Errors fade on their own.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (!eviction) return;
    const timer = setTimeout(() => setEviction(null), eviction.replayMs);
    return () => clearTimeout(timer);
  }, [eviction]);

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const connect = () => {
      const url = new URL("/ws/game", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      socketRef.current = socket;
      setStatus("connecting");

      socket.addEventListener("open", () => {
        attempt = 0;
        setStatus("open");
        setError(null);
        setLog([]);
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        switch (message.type) {
          case "hello":
            setTopology(message.topology);
            setState(message.state);
            break;
          case "state":
            setState(message.state);
            break;
          case "log":
            setLog((prev) => [...prev, message.entry].slice(-LOG_LIMIT));
            break;
          case "think":
            busRef.current.emit({ kind: "think", event: message.event });
            break;
          case "dopamine":
            busRef.current.emit({ kind: "dopamine", event: message.event });
            break;
          case "stats":
            setStats(message.stats);
            break;
          case "fly_evicted":
            setEviction(message.event);
            break;
          case "error":
            setError(message.message);
            break;
        }
      });

      socket.addEventListener("close", () => {
        if (disposed) return;
        setStatus("closed");
        attempt++;
        retryTimer = setTimeout(connect, Math.min(5000, 500 * 2 ** attempt));
      });
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  return {
    state,
    topology,
    log,
    status,
    error,
    eviction,
    stats,
    bet,
    setBet,
    send,
    activity: busRef.current,
  };
}

import { useEffect, useRef, useState, useCallback } from "react";

export type WSConversationEvent = {
  type: "conversation_opened" | "bot_active" | "escalated" | "resolved" | "message_received";
  conversationId: string;
  tenantId: string;
  status?: string;
  timestamp: number;
  payload?: Record<string, unknown>;
};

type WSState = "connecting" | "connected" | "disconnected" | "error";

const KNOWN_EVENT_TYPES = new Set([
  "conversation_opened",
  "bot_active",
  "escalated",
  "resolved",
  "message_received",
]);

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

export function useConversationsWS(tenantId: string) {
  const [wsState, setWsState] = useState<WSState>("disconnected");
  const [events, setEvents] = useState<WSConversationEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const attemptsRef = useRef(0);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    // Build WebSocket URL from current host — always upgrade to wss:// when the
    // page is served over https:// (mixed-content would otherwise be blocked).
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/api/ws/conversations?tenantId=${encodeURIComponent(tenantId)}`;

    setWsState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      setWsState("error");
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      attemptsRef.current = 0; // reset backoff on successful connection
      setWsState("connected");
    };

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      try {
        const event = JSON.parse(evt.data) as WSConversationEvent;
        // Ignore control frames (e.g. the server's "connected" welcome ping)
        if (!event || !KNOWN_EVENT_TYPES.has(event.type)) return;
        setEvents(prev => [event, ...prev].slice(0, 50));
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setWsState("disconnected");
      // Exponential backoff with jitter: 1s, 2s, 4s, … capped at 30s
      const backoff = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** attemptsRef.current);
      const jitter = Math.floor(Math.random() * 500);
      attemptsRef.current += 1;
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, backoff + jitter);
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setWsState("error");
      ws.close();
    };
  }, [tenantId]);

  useEffect(() => {
    mountedRef.current = true;
    attemptsRef.current = 0;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { wsState, events, clearEvents };
}

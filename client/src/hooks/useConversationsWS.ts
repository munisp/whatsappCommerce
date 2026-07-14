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

export function useConversationsWS(tenantId: string) {
  const [wsState, setWsState] = useState<WSState>("disconnected");
  const [events, setEvents] = useState<WSConversationEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    // Build WebSocket URL from current host
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/api/ws/conversations?tenantId=${encodeURIComponent(tenantId)}`;

    setWsState("connecting");
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setWsState("connected");
    };

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return;
      try {
        const event: WSConversationEvent = JSON.parse(evt.data);
        setEvents(prev => [event, ...prev].slice(0, 50));
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setWsState("disconnected");
      // Auto-reconnect after 3 seconds
      reconnectTimer.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, 3000);
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      setWsState("error");
      ws.close();
    };
  }, [tenantId]);

  useEffect(() => {
    mountedRef.current = true;
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

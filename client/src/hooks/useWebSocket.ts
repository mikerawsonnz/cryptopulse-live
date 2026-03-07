import { useEffect, useRef, useState, useCallback } from "react";
import type { CryptoData, SentimentData, WhaleTransaction, SignalsData, WSMessage } from "@shared/schema";

interface WebSocketState {
  cryptos: CryptoData[];
  btcSentiment: SentimentData | null;
  whaleTransactions: WhaleTransaction[];
  signals: SignalsData | null;
  isConnected: boolean;
  lastUpdated: string | null;
  error: string | null;
}

export function useWebSocket() {
  const [state, setState] = useState<WebSocketState>({
    cryptos: [],
    btcSentiment: null,
    whaleTransactions: [],
    signals: null,
    isConnected: false,
    lastUpdated: null,
    error: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 50; // Increased for better resilience

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        console.log("[WS] Connected");
        reconnectAttempts.current = 0;
        setState((prev) => ({
          ...prev,
          isConnected: true,
          error: null,
        }));
      };

      socket.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data);

          switch (message.type) {
            case "crypto_update":
              setState((prev) => ({
                ...prev,
                cryptos: message.data,
                lastUpdated: new Date().toISOString(),
              }));
              break;

            case "sentiment_update":
              setState((prev) => ({
                ...prev,
                btcSentiment: message.data,
                lastUpdated: new Date().toISOString(),
              }));
              break;

            case "whale_alert":
              setState((prev) => ({
                ...prev,
                whaleTransactions: [message.data, ...prev.whaleTransactions].slice(0, 50),
                lastUpdated: new Date().toISOString(),
              }));
              break;

            case "signals_update":
              setState((prev) => ({
                ...prev,
                signals: message.data,
                lastUpdated: new Date().toISOString(),
              }));
              break;

            case "connection_status":
              setState((prev) => ({
                ...prev,
                isConnected: message.data.connected,
                error: message.data.connected ? null : message.data.message,
              }));
              break;
          }
        } catch (err) {
          console.error("[WS] Failed to parse message:", err);
        }
      };

      socket.onerror = (error) => {
        console.error("[WS] Error:", error);
        setState((prev) => ({
          ...prev,
          error: "Connection error",
        }));
      };

      socket.onclose = (event) => {
        console.log("[WS] Disconnected:", event.code, event.reason);
        wsRef.current = null;
        setState((prev) => ({
          ...prev,
          isConnected: false,
        }));

        if (reconnectAttempts.current < maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
          console.log(`[WS] Reconnecting in ${delay}ms...`);
          reconnectAttempts.current++;

          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        } else {
          setState((prev) => ({
            ...prev,
            error: "Failed to connect after multiple attempts",
          }));
        }
      };
    } catch (err) {
      console.error("[WS] Failed to create connection:", err);
      setState((prev) => ({
        ...prev,
        error: "Failed to establish connection",
      }));
    }
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  useEffect(() => {
    connect();

    // Reconnect when tab becomes visible again (browser may close WS when hidden)
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Reset reconnect attempts when tab becomes visible
        reconnectAttempts.current = 0;
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          console.log("[WS] Tab visible, attempting to reconnect...");
          connect();
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      disconnect();
    };
  }, [connect, disconnect]);

  return {
    ...state,
    reconnect: connect,
  };
}

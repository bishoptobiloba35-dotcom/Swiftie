import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const subscribers = new Map<string, Set<WebSocket>>();

export function attachRealtime(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const deliveryId = url.searchParams.get("deliveryId");

    if (!deliveryId) {
      socket.close(1008, "deliveryId is required");
      return;
    }

    const set = subscribers.get(deliveryId) ?? new Set<WebSocket>();
    set.add(socket);
    subscribers.set(deliveryId, set);

    socket.on("close", () => {
      set.delete(socket);
      if (set.size === 0) subscribers.delete(deliveryId);
    });
  });
}

export function publishDeliveryLocation(deliveryId: string, payload: unknown): void {
  const message = JSON.stringify({ type: "LOCATION_UPDATED", payload });
  for (const socket of subscribers.get(deliveryId) ?? []) {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

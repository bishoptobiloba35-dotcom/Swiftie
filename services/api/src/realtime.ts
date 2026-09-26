import type { Server } from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const subscribers = new Map<string, Set<WebSocket>>();
const trackingTokens = new Map<string, string>();

export function issueTrackingToken(deliveryId: string): string {
  const token = crypto.randomUUID();
  trackingTokens.set(token, deliveryId);
  return token;
}

function validTrackingToken(token: string | null, deliveryId: string): boolean {
  return Boolean(token && trackingTokens.get(token) === deliveryId);
}

export function attachRealtime(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const deliveryId = url.searchParams.get("deliveryId");
    const token = url.searchParams.get("token");

    if (!deliveryId || !validTrackingToken(token, deliveryId)) {
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

function publish(deliveryId: string, type: string, payload: unknown): void {
  const message = JSON.stringify({ type, payload });
  for (const socket of subscribers.get(deliveryId) ?? []) {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

export function publishDeliveryLocation(deliveryId: string, payload: unknown): void {
  publish(deliveryId, "LOCATION_UPDATED", payload);
}

export function publishDeliveryUpdate(deliveryId: string, payload: unknown): void {
  publish(deliveryId, "DELIVERY_UPDATED", payload);
}

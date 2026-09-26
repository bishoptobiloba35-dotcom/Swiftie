export type ApiDelivery = {
  id: string;
  trackingCode: string;
  senderId: string;
  receiverName: string;
  receiverPhone: string;
  pickup: { label: string; formattedAddress: string };
  dropoff: { label: string; formattedAddress: string };
  status: string;
  driverId?: string;
  pickupPhotoUrl?: string;
  latestLocation?: {
    deliveryId: string;
    driverId: string;
    latitude: number;
    longitude: number;
    accuracyMeters?: number;
    recordedAt: string;
  } | null;
  locationHistory?: Array<{
    deliveryId: string;
    driverId: string;
    latitude: number;
    longitude: number;
    accuracyMeters?: number;
    recordedAt: string;
  }>;
  updatedAt: string;
};

export type CreateDeliveryInput = {
  senderId: string;
  receiverName: string;
  receiverPhone: string;
  pickup: { label: string; formattedAddress: string };
  dropoff: { label: string; formattedAddress: string };
};

export class SwiftDropApi {
  constructor(private readonly baseUrl: string) {}

  async health(): Promise<{ ok: boolean }> {
    const response = await fetch(this.baseUrl + "/health");
    if (!response.ok) throw new Error("API health check failed");
    return response.json() as Promise<{ ok: boolean }>;
  }

  async createDelivery(input: CreateDeliveryInput): Promise<ApiDelivery> {
    const response = await fetch(this.baseUrl + "/api/deliveries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    if (!response.ok) throw new Error("Unable to create delivery");
    return response.json() as Promise<ApiDelivery>;
  }

  async track(trackingCode: string): Promise<ApiDelivery> {
    const response = await fetch(
      this.baseUrl + "/api/track/" + encodeURIComponent(trackingCode)
    );
    if (!response.ok) throw new Error("Tracking code not found");
    return response.json() as Promise<ApiDelivery>;
  }

  connectToTracking(
    deliveryId: string,
    onLocation: (location: ApiDelivery["latestLocation"]) => void,
    onDeliveryUpdate?: (delivery: Partial<ApiDelivery>) => void
  ): WebSocket {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    const socket = new WebSocket(
      wsBase + "/ws?deliveryId=" + encodeURIComponent(deliveryId)
    );
    socket.onmessage = event => {
      const message = JSON.parse(event.data) as {
        type: string;
        payload: ApiDelivery["latestLocation"] | Partial<ApiDelivery>;
      };
      if (message.type === "LOCATION_UPDATED") {
        onLocation(message.payload as ApiDelivery["latestLocation"]);
      }
      if (message.type === "DELIVERY_UPDATED") {
        onDeliveryUpdate?.(message.payload as Partial<ApiDelivery>);
      }
    };
    return socket;
  }}

export type ApiDelivery = {
  id: string;
  trackingCode: string;
  senderId?: string;
  receiverName: string;
  receiverPhone: string;
  weightKg: number;
  dimensionsCm: { length: number; width: number; height: number };
  isPerishable: boolean;
  pickup: { label: string; formattedAddress: string; location?: { latitude: number; longitude: number; recordedAt?: string } };
  dropoff: { label: string; formattedAddress: string; location?: { latitude: number; longitude: number; recordedAt?: string } };
  quote?: {
    currency: string;
    distanceMeters: number;
    durationSeconds: number;
    baseFareMinor: number;
    distanceFareMinor: number;
    weightFareMinor: number;
    sizeFareMinor: number;
    perishableSurchargeMinor: number;
    serviceFeeMinor: number;
    totalMinor: number;
  };
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
  senderId?: string;
  receiverPin: string;
  receiverName: string;
  receiverPhone: string;
  pickup: { label: string; formattedAddress: string; latitude: number; longitude: number };
  dropoff: { label: string; formattedAddress: string; latitude: number; longitude: number };
  quote: {
    currency: "NGN";
    distanceMeters: number;
    durationSeconds: number;
    baseFareMinor: number;
    distanceFareMinor: number;
    weightFareMinor: number;
    sizeFareMinor: number;
    perishableSurchargeMinor: number;
    serviceFeeMinor: number;
    totalMinor: number;
  };
};

export class SwiftDropApi {
  private accessToken: string | null = null;

  constructor(private readonly baseUrl: string) {}

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  private headers(json = false): Record<string, string> {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.accessToken ? { authorization: "Bearer " + this.accessToken } : {})
    };
  }

  async register(input: {
    fullName: string; phone: string; email?: string; password: string; role: "CUSTOMER" | "DRIVER";
  }): Promise<{ accessToken: string; user: { id: string; role: string; full_name: string; phone: string; email?: string | null } }> {
    const response = await fetch(this.baseUrl + "/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Registration failed");
    this.setAccessToken(data.accessToken);
    return data;
  }

  async login(phone: string, password: string): Promise<{ accessToken: string; user: { id: string; role: string; full_name: string; phone: string; email?: string | null } }> {
    const response = await fetch(this.baseUrl + "/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, password })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Login failed");
    this.setAccessToken(data.accessToken);
    return data;
  }

  async registerDeviceToken(token: string, platform: "IOS" | "ANDROID"): Promise<void> {
    const response = await fetch(this.baseUrl + "/api/notifications/device-token", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ token, platform })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to register notification device");
  }

  async rateDelivery(deliveryId: string, stars: number, comment?: string): Promise<void> {
    const response = await fetch(this.baseUrl + `/api/deliveries/${encodeURIComponent(deliveryId)}/rating`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ stars, comment })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to save rating");
  }

  async rateSender(deliveryId: string, stars: number, comment?: string): Promise<void> {
    const response = await fetch(this.baseUrl + `/api/deliveries/${encodeURIComponent(deliveryId)}/rating/driver`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ stars, comment })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to save rating");
  }

  async notifications(): Promise<Array<{ id: string; delivery_id?: string | null; title: string; body: string; type: string; read_at?: string | null; created_at: string }>> {
    const response = await fetch(this.baseUrl + "/api/notifications", { headers: this.headers() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to load notifications");
    return data.notifications ?? [];
  }

  async markNotificationRead(id: string): Promise<void> {
    const response = await fetch(this.baseUrl + "/api/notifications/" + encodeURIComponent(id) + "/read", { method: "POST", headers: this.headers() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to mark notification as read");
  }

  async health(): Promise<{ ok: boolean }> {
    const response = await fetch(this.baseUrl + "/health");
    if (!response.ok) throw new Error("API health check failed");
    return response.json() as Promise<{ ok: boolean }>;
  }

  async searchLocations(query: string): Promise<Array<{ id?: string; formattedAddress?: string; latitude: number; longitude: number }>> {
    const response = await fetch(this.baseUrl + "/api/locations/search?q=" + encodeURIComponent(query), {
      headers: this.headers()
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Location search failed");
    return data.results ?? [];
  }

  async quote(input: {
    pickup: { latitude: number; longitude: number };
    dropoff: { latitude: number; longitude: number };
  }): Promise<{
    currency: string; distanceMeters: number; durationSeconds: number;
    baseFareMinor: number; distanceFareMinor: number; serviceFeeMinor: number; totalMinor: number;
  }> {
    const response = await fetch(this.baseUrl + "/api/quotes", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(input)
    });
    if (!response.ok) throw new Error("Unable to calculate delivery quote");
    return response.json();
  }

  async paymentStatus(deliveryId: string): Promise<{ payment: { status: string; amountMinor: number; currency: string; providerReference?: string | null } }> {
    const response = await fetch(this.baseUrl + `/api/deliveries/${deliveryId}/payment/status`, {
      headers: this.headers()
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to read payment status");
    return data;
  }

  async initializePayment(deliveryId: string, email: string): Promise<{ authorizationUrl: string; reference: string; amountMinor: number }> {
    const response = await fetch(this.baseUrl + `/api/deliveries/${deliveryId}/payment/initialize`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ email })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Payment initialization failed");
    return data;
  }

  async createDelivery(input: CreateDeliveryInput): Promise<ApiDelivery> {
    const response = await fetch(this.baseUrl + "/api/deliveries", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(input)
    });
    if (!response.ok) throw new Error("Unable to create delivery");
    return response.json() as Promise<ApiDelivery>;
  }

  async createTrackingSession(trackingCode: string, receiverPhone: string): Promise<{ deliveryId: string; trackingToken: string }> {
    const response = await fetch(this.baseUrl + "/api/track/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackingCode, receiverPhone })
    });
    if (!response.ok) throw new Error("Unable to start tracking session");
    return response.json() as Promise<{ deliveryId: string; trackingToken: string }>;
  }

  async track(trackingCode: string, receiverPhone: string): Promise<ApiDelivery> {
    const response = await fetch(
      this.baseUrl + "/api/track/" + encodeURIComponent(trackingCode) + "?receiverPhone=" + encodeURIComponent(receiverPhone)
    );
    if (!response.ok) throw new Error("Tracking code not found");
    return response.json() as Promise<ApiDelivery>;
  }

  connectToTracking(
    deliveryId: string,
    trackingToken: string,
    onLocation: (location: ApiDelivery["latestLocation"]) => void,
    onDeliveryUpdate?: (delivery: Partial<ApiDelivery>) => void
  ): WebSocket {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    const socket = new WebSocket(
      wsBase + "/ws?deliveryId=" + encodeURIComponent(deliveryId) + "&token=" + encodeURIComponent(trackingToken)
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

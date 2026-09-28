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
  weightKg: number;
  dimensionsCm: { length: number; width: number; height: number };
  isPerishable: boolean;
  pickup: { label: string; formattedAddress: string; latitude: number; longitude: number };
  dropoff: { label: string; formattedAddress: string; latitude: number; longitude: number };
  pickupDropOffLocationId?: string;
  dropoffDropOffLocationId?: string;
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
    fullName: string; phone: string; email?: string; password: string; role: "CUSTOMER" | "DRIVER" | "AGENT";
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

  async confirmReceiver(deliveryId: string, receiverPhone: string, receiverPin: string): Promise<{ delivery: ApiDelivery; payoutAmountMinor: number; escrowStatus: string }> {
    const response = await fetch(this.baseUrl + `/api/deliveries/${encodeURIComponent(deliveryId)}/receiver-confirm`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiverPhone, receiverPin })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to confirm receipt");
    return data;
  }

  async rateReceiverDelivery(deliveryId: string, receiverPhone: string, receiverPin: string, stars: number, comment?: string): Promise<void> {
    const response = await fetch(this.baseUrl + `/api/deliveries/${encodeURIComponent(deliveryId)}/rating/receiver`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiverPhone, receiverPin, stars, comment })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to save receiver rating");
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

  async createSupportTicket(input: { category: "ORDER" | "APP"; subject: string; message: string; deliveryId?: string }): Promise<any> {
    const response = await fetch(this.baseUrl + "/api/support/tickets", {
      method: "POST", headers: this.headers(true), body: JSON.stringify(input)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to create support request");
    return data.ticket;
  }

  async supportTickets(): Promise<any[]> {
    const response = await fetch(this.baseUrl + "/api/support/tickets", { headers: this.headers() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to load support requests");
    return data.tickets ?? [];
  }

  async createReceiverDispute(trackingCode: string, receiverPhone: string, receiverPin: string, reason: string, description?: string): Promise<any> {
    const response = await fetch(this.baseUrl + "/api/track/" + encodeURIComponent(trackingCode) + "/dispute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverPhone, receiverPin, reason, description })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to open dispute");
    return data.dispute;
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

  async nearbyDropOffLocations(latitude:number,longitude:number,radiusKm=25):Promise<any[]> {
    const response=await fetch(this.baseUrl+"/api/drop-off/locations?latitude="+latitude+"&longitude="+longitude+"&radiusKm="+radiusKm,{headers:this.headers()});
    const data=await response.json(); if(!response.ok) throw new Error(data.error??"Unable to load drop-off locations"); return data.locations??[];
  }
  async applyDropOffLocation(input:any):Promise<any>{
    const response=await fetch(this.baseUrl+"/api/drop-off/applications",{method:"POST",headers:this.headers(true),body:JSON.stringify(input)});
    const data=await response.json(); if(!response.ok) throw new Error(data.error??"Unable to submit drop-off application"); return data.location;
  }
  async uploadDropOffDocument(locationId:string,documentType:string,dataUrl:string):Promise<any>{
    const response=await fetch(this.baseUrl+"/api/drop-off/locations/"+encodeURIComponent(locationId)+"/documents",{method:"POST",headers:this.headers(true),body:JSON.stringify({documentType,dataUrl})});
    const data=await response.json(); if(!response.ok) throw new Error(data.error??"Unable to upload document"); return data.document;
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
    weightKg: number;
    dimensionsCm: { length: number; width: number; height: number };
    isPerishable: boolean;
  }): Promise<{
    currency: string; distanceMeters: number; durationSeconds: number;
    baseFareMinor: number; distanceFareMinor: number; weightFareMinor: number; sizeFareMinor: number;
    perishableSurchargeMinor: number; serviceFeeMinor: number; totalMinor: number;
  }> {
    const response = await fetch(this.baseUrl + "/api/quotes", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(input)
    });
    if (!response.ok) throw new Error("Unable to calculate delivery quote");
    return response.json();
  }

  async paymentStatus(deliveryId: string): Promise<{ payment: { status: string; escrowStatus?: string; amountMinor: number; currency: string; providerReference?: string | null } }> {
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

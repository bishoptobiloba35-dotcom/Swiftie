export type ApiDelivery = {
  id: string;
  trackingCode: string;
  senderId?: string;
  receiverName: string;
  receiverPhone: string;
  weightKg: number;
  dimensionsCm: { length: number; width: number; height: number };
  isPerishable: boolean;
  declaredValueMinor: number;
  pickup: { label: string; formattedAddress: string; location?: { latitude: number; longitude: number; recordedAt?: string } };
  dropoff: { label: string; formattedAddress: string; location?: { latitude: number; longitude: number; recordedAt?: string } };
  pickupInstructions?: string;
  dropoffInstructions?: string;
  quote?: {
    currency: string;
    distanceMeters: number;
    durationSeconds: number;
    baseFareMinor: number;
    distanceFareMinor: number;
    weightFareMinor: number;
    sizeFareMinor: number;
    perishableSurchargeMinor: number;
    fuelReferenceMinor: number;
    protectionReserveMinor: number;
    pricingVersion: number;
    serviceFeeMinor: number;
    totalMinor: number;
  };
  status: string;
  paymentMode?: "SENDER_ESCROW" | "RECEIVER_ON_DELIVERY";
  receiverConfirmedAt?: string;
  exceptionStatus?: "NONE" | "FAILED_ATTEMPT" | "RESCHEDULED" | "RETURN_REQUESTED" | "RETURN_IN_TRANSIT" | "RETURNED";
  nextDeliveryAt?: string | null;
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
  paymentMode?: "SENDER_ESCROW" | "RECEIVER_ON_DELIVERY";
  receiverPin: string;
  receiverName: string;
  receiverPhone: string;
  weightKg: number;
  dimensionsCm: { length: number; width: number; height: number };
  isPerishable: boolean;
  declaredValueMinor: number;
  pickup: { label: string; formattedAddress: string; latitude: number; longitude: number };
  dropoff: { label: string; formattedAddress: string; latitude: number; longitude: number };
  pickupDropOffLocationId?: string;
  dropoffDropOffLocationId?: string;
  pickupInstructions?: string;
  dropoffInstructions?: string;
  quote: {
    currency: "NGN";
    distanceMeters: number;
    durationSeconds: number;
    baseFareMinor: number;
    distanceFareMinor: number;
    weightFareMinor: number;
    sizeFareMinor: number;
    perishableSurchargeMinor: number;
    fuelReferenceMinor: number;
    protectionReserveMinor: number;
    pricingVersion: number;
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

  async confirmReceiver(deliveryId: string, receiverPhone: string, receiverPin: string): Promise<{ delivery: ApiDelivery; payoutAmountMinor?: number; escrowStatus?: string; paymentMode?: string; paymentRequired?: boolean; amountMinor?: number }> {
    const response = await fetch(this.baseUrl + `/api/deliveries/${encodeURIComponent(deliveryId)}/receiver-confirm`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiverPhone, receiverPin })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to confirm receipt");
    return data;
  }

  async initializeReceiverPayment(deliveryId: string, receiverPhone: string, receiverPin: string, email: string): Promise<{ paymentId: string; reference: string; authorizationUrl: string; accessCode?: string; amountMinor: number }> {
    const response = await fetch(this.baseUrl + `/api/deliveries/${encodeURIComponent(deliveryId)}/receiver-payment/initialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiverPhone, receiverPin, email })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Receiver payment initialization failed");
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


  async marketplaceListings(query = ""): Promise<any[]> {
    const response = await fetch(this.baseUrl + "/api/marketplace/listings" + (query ? "?q=" + encodeURIComponent(query) : ""));
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Unable to load SwiftDrop marketplace");
    return data.listings ?? [];
  }
  async marketplaceSeller(sellerId: string): Promise<any> {
    const response = await fetch(this.baseUrl + "/api/marketplace/sellers/" + encodeURIComponent(sellerId));
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Unable to load seller profile");
    return data.seller;
  }
  async marketplaceSellerReview(orderId: string, stars: number, comment?: string): Promise<any> {
    const response = await fetch(this.baseUrl + "/api/marketplace/orders/" + encodeURIComponent(orderId) + "/review", {
      method: "POST", headers: this.headers(true), body: JSON.stringify({ stars, comment })
    });
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Unable to save seller review");
    return data.review;
  }
  async marketplaceListing(id: string): Promise<{ listing: any; recommended: any[] }> {
    const response = await fetch(this.baseUrl + "/api/marketplace/listings/" + encodeURIComponent(id));
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Unable to load marketplace listing");
    return data;
  }
  async marketplaceMyListings(): Promise<any[]> {
    const response = await fetch(this.baseUrl + "/api/marketplace/my-listings", { headers: this.headers() });
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Unable to load your listings");
    return data.listings ?? [];
  }
  async updateMarketplaceListing(id: string, input: any): Promise<any> {
    const response = await fetch(this.baseUrl + "/api/marketplace/listings/" + encodeURIComponent(id), {
      method: "PATCH", headers: this.headers(true), body: JSON.stringify(input)
    });
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Unable to update listing");
    return data.listing;
  }

  async createMarketplaceListing(input: {
    displayName: string; bio?: string; locationLabel?: string; title: string; description: string;
    condition: "NEW" | "LIKE_NEW" | "GOOD" | "FAIR" | "USED" | "FOR_PARTS"; useDescription: string;
    usageInstructions?: string; category: string; priceMinor: number; deliveryFeeMinor: number;
    deliveryMode: "SAME_STATE" | "INTER_STATE" | "EXPRESS" | "PICKUP"; stockQuantity: number;
    pickupAddress: string; pickupLatitude: number; pickupLongitude: number;
    weightKg: number; lengthCm: number; widthCm: number; heightCm: number; isPerishable?: boolean;
    media?: string[];
  }): Promise<any> {
    const response = await fetch(this.baseUrl + "/api/marketplace/listings", {
      method: "POST", headers: this.headers(true), body: JSON.stringify(input)
    });
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Unable to publish marketplace listing");
    return data;
  }
  async cancelMarketplaceOrder(orderId: string): Promise<any> {
    const response = await fetch(this.baseUrl + "/api/marketplace/orders/" + encodeURIComponent(orderId) + "/cancel", {
      method: "POST", headers: this.headers(true)
    });
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Unable to cancel marketplace order");
    return data;
  }
  async fulfillMarketplaceOrder(orderId: string, input: { receiverName: string; receiverPhone: string; receiverPin: string; dropoffAddress: string; dropoffLatitude: number; dropoffLongitude: number }): Promise<any> {
    const response = await fetch(this.baseUrl + "/api/marketplace/orders/" + encodeURIComponent(orderId) + "/fulfill", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(input)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to initialize marketplace delivery");
    return data;
  }
  async checkoutMarketplaceListing(id: string, quantity = 1, requestedDeliveryAt?: string, idempotencyKey?: string): Promise<any> {
    const response = await fetch(this.baseUrl + "/api/marketplace/listings/" + encodeURIComponent(id) + "/checkout", { method: "POST", headers: this.headers(true), body: JSON.stringify({ quantity, requestedDeliveryAt, idempotencyKey: idempotencyKey ?? `${Date.now()}-${Math.random().toString(36).slice(2, 18)}` }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Unable to create checkout");
    return data;
  }
  async initializeMarketplacePayment(orderId: string, email: string): Promise<{ authorizationUrl: string; accessCode?: string | null; reference: string; payment: any }> {
    const response = await fetch(this.baseUrl + "/api/marketplace/orders/" + encodeURIComponent(orderId) + "/payment/initialize", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ email })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to initialize marketplace payment");
    return data;
  }
  async marketplaceSales(): Promise<any[]> {
    const response = await fetch(this.baseUrl + "/api/marketplace/sales", { headers: this.headers() });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error ?? "Unable to load marketplace sales");
    return payload.sales ?? [];
  }

  async markMarketplaceOrderReady(orderId: string, preparationMinutes = 0, busyMode = false): Promise<any> {
    const response = await fetch(this.baseUrl + "/api/marketplace/orders/" + encodeURIComponent(orderId) + "/mark-ready", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ preparationMinutes, busyMode })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to mark marketplace order ready");
    return data.order;
  }

  async marketplaceOrders(): Promise<any[]> {
    const response = await fetch(this.baseUrl + "/api/marketplace/orders", { headers: this.headers() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to load marketplace orders");
    return data.orders ?? [];
  }
  async verifyMarketplacePayment(orderId: string): Promise<any> {
    const response = await fetch(this.baseUrl + "/api/marketplace/orders/" + encodeURIComponent(orderId) + "/payment/verify", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to verify marketplace payment");
    return data;
  }

  async marketplaceOrder(orderId: string): Promise<any> {
    const response = await fetch(this.baseUrl + "/api/marketplace/orders/" + encodeURIComponent(orderId), { headers: this.headers() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to load marketplace order");
    return data.order;
  }
  async marketplacePayment(orderId: string): Promise<any> {
    const response = await fetch(this.baseUrl + "/api/marketplace/orders/" + encodeURIComponent(orderId) + "/payment", { headers: this.headers() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to load marketplace payment");
    return data.payment;
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
    declaredValueMinor: number;
  }): Promise<{
    currency: string; distanceMeters: number; durationSeconds: number;
    baseFareMinor: number; distanceFareMinor: number; weightFareMinor: number; sizeFareMinor: number;
    perishableSurchargeMinor: number; fuelReferenceMinor: number; protectionReserveMinor: number; pricingVersion: number; serviceFeeMinor: number; totalMinor: number;
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

  async createShareableTrackingLink(deliveryId: string): Promise<{ url: string; expiresAt: string }> {
    const response = await fetch(this.baseUrl + "/api/deliveries/" + encodeURIComponent(deliveryId) + "/share-tracking", {
      method: "POST",
      headers: this.headers(true)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to create shareable tracking link");
    return data;
  }

  async publicTrack(token: string): Promise<ApiDelivery> {
    const response = await fetch(this.baseUrl + "/api/public/track/" + encodeURIComponent(token));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Tracking link not found or expired");
    return data;
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



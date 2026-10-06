import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as WebBrowser from "expo-web-browser";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import * as ImagePicker from "expo-image-picker";
import Constants from "expo-constants";
import { SafeAreaView, View, Text, TextInput, Pressable, StyleSheet, Alert, ScrollView, Platform, Image } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { SwiftDropApi, type ApiDelivery } from "../../packages/shared/src/api";
import { haversineDistanceMeters, etaMinutes } from "./src/trackingMath";
import Phase1Home from "./src/Phase1Home";
import OrderHistory from "./src/OrderHistory";
import EscrowPaymentScreen from "./src/EscrowPaymentScreen";
import WalletScreen from "./src/WalletScreen";
import PayoutRequestScreen from "./src/PayoutRequestScreen";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";
const api = new SwiftDropApi(API_URL);

export default function App() {
  const [signedIn, setSignedIn] = React.useState(false);
  const [homeSection, setHomeSection] = React.useState<"HOME" | "ORDER" | "ERRAND" | "TRACK" | "SHOP" | "LOCATIONS" | "HISTORY" | "WALLET" | "ESCROW" | "PAYOUT">("HOME");
  const [errandDraft, setErrandDraft] = React.useState({
    errandType: "GENERAL_ERRAND" as "GENERAL_ERRAND" | "PURCHASE_AND_DELIVER" | "SHOP_FOR_ME",
    description: "",
    itemDescription: "",
    spendingCeiling: "",
    requestedPrice: "",
    replacementPolicy: "EXACT_ONLY" as "EXACT_ONLY" | "BEST_MATCH" | "APPROVED_ALTERNATIVES" | "REFUND_IF_UNAVAILABLE",
    maxPriceDelta: "0",
    merchantName: "",
    merchantAddress: "",
    instructions: "",
    requestedCompletionAt: "",
    receiverName: "",
    receiverPhone: "",
    receiverPin: "",
    destinationAddress: "",
    destinationLat: "",
    destinationLng: ""
  });
  const [errandBusy, setErrandBusy] = React.useState(false);
  const [errandStops, setErrandStops] = React.useState<Array<{ stopType: "TASK"|"PICKUP"|"PURCHASE"|"INSPECT"|"DROP_OFF"; label: string; address: string; latitude: string; longitude: string; instructions: string }>>([]);
  const [myErrands, setMyErrands] = React.useState<any[]>([]);
  const [selectedErrand, setSelectedErrand] = React.useState<any | null>(null);
  const [errandDetail, setErrandDetail] = React.useState<any | null>(null);
  const [errandDetailBusy, setErrandDetailBusy] = React.useState(false);
  const updateErrand = (patch: Partial<typeof errandDraft>) => setErrandDraft(prev => ({ ...prev, ...patch }));
  const [marketplaceListings, setMarketplaceListings] = React.useState<any[]>([]);
  const [marketplaceSales, setMarketplaceSales] = React.useState<any[]>([]);
  const [marketplaceMyListings, setMarketplaceMyListings] = React.useState<any[]>([]);
  const [selectedListing, setSelectedListing] = React.useState<any | null>(null);
  const [recommendedListings, setRecommendedListings] = React.useState<any[]>([]);
  const [selectedSellerTrust, setSelectedSellerTrust] = React.useState<any | null>(null);
  const [marketplaceDeliveryAt, setMarketplaceDeliveryAt] = React.useState("");
  const [marketplaceSearch, setMarketplaceSearch] = React.useState("");
  const [marketplaceLoading, setMarketplaceLoading] = React.useState(false);
  const [marketplaceOrders, setMarketplaceOrders] = React.useState<any[]>([]);
  const [showSellerForm, setShowSellerForm] = React.useState(false);
  const [sellerTitle, setSellerTitle] = React.useState("");
  const [sellerDescription, setSellerDescription] = React.useState("");
  const [sellerCategory, setSellerCategory] = React.useState("");
  const [sellerCondition, setSellerCondition] = React.useState<"NEW" | "LIKE_NEW" | "GOOD" | "FAIR" | "USED" | "FOR_PARTS">("NEW");
  const [sellerUseDescription, setSellerUseDescription] = React.useState("");
  const [sellerUsageInstructions, setSellerUsageInstructions] = React.useState("");
  const [sellerMedia, setSellerMedia] = React.useState<string[]>([]);
  const [sellerPrice, setSellerPrice] = React.useState("");
  const [sellerDeliveryFee, setSellerDeliveryFee] = React.useState("");
  const [sellerDeliveryMode, setSellerDeliveryMode] = React.useState<"SAME_STATE" | "INTER_STATE" | "EXPRESS" | "PICKUP">("SAME_STATE");
  const [sellerStock, setSellerStock] = React.useState("1");
  const [sellerPickupAddress, setSellerPickupAddress] = React.useState("");
  const [sellerPickupLat, setSellerPickupLat] = React.useState("");
  const [sellerPickupLng, setSellerPickupLng] = React.useState("");
  const [sellerWeightKg, setSellerWeightKg] = React.useState("");
  const [sellerLengthCm, setSellerLengthCm] = React.useState("");
  const [sellerWidthCm, setSellerWidthCm] = React.useState("");
  const [sellerHeightCm, setSellerHeightCm] = React.useState("");
  const [sellerPerishable, setSellerPerishable] = React.useState(false);
  const [marketplaceReceiverName, setMarketplaceReceiverName] = React.useState("");
  const [marketplaceReceiverPhone, setMarketplaceReceiverPhone] = React.useState("");
  const [marketplaceReceiverPin, setMarketplaceReceiverPin] = React.useState("");
  const [marketplaceDropoffAddress, setMarketplaceDropoffAddress] = React.useState("");
  const [marketplaceDropoffLat, setMarketplaceDropoffLat] = React.useState("");
  const [marketplaceDropoffLng, setMarketplaceDropoffLng] = React.useState("");
  const [sellerPublishing, setSellerPublishing] = React.useState(false);
  const [authMode, setAuthMode] = React.useState<"login" | "register">("login");
  const [authName, setAuthName] = React.useState("");
  const [authPhone, setAuthPhone] = React.useState("");
  const [authEmail, setAuthEmail] = React.useState("");
  const [authPassword, setAuthPassword] = React.useState("");
  const [legalConsent, setLegalConsent] = React.useState(false);
  const [pickup, setPickup] = React.useState("");
  const [dropoff, setDropoff] = React.useState("");
  const [pickupLat, setPickupLat] = React.useState("");
  const [pickupLng, setPickupLng] = React.useState("");
  const [pickupResults, setPickupResults] = React.useState<Array<{ formattedAddress?: string; latitude: number; longitude: number }>>([]);
  const [dropoffResults, setDropoffResults] = React.useState<Array<{ formattedAddress?: string; latitude: number; longitude: number }>>([]);
  const [dropoffLat, setDropoffLat] = React.useState("");
  const [dropoffLng, setDropoffLng] = React.useState("");
  const [pickupDropOffId, setPickupDropOffId] = React.useState("");
  const [pickupInstructions, setPickupInstructions] = React.useState("");
  const [dropoffInstructions, setDropoffInstructions] = React.useState("");
  const [dropoffDropOffId, setDropoffDropOffId] = React.useState("");
  const [pickupDropOffLocations, setPickupDropOffLocations] = React.useState<any[]>([]);
  const [dropoffDropOffLocations, setDropoffDropOffLocations] = React.useState<any[]>([]);
  const [receiver, setReceiver] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [receiverPin, setReceiverPin] = React.useState("");
  const [weightKg, setWeightKg] = React.useState("");
  const [declaredValue, setDeclaredValue] = React.useState("");
  const [lengthCm, setLengthCm] = React.useState("");
  const [widthCm, setWidthCm] = React.useState("");
  const [heightCm, setHeightCm] = React.useState("");
  const [isPerishable, setIsPerishable] = React.useState(false);
  const paymentMode = "SENDER_ESCROW" as const;
  const [receiverConfirmPin, setReceiverConfirmPin] = React.useState("");
  const [receiverRatingStars, setReceiverRatingStars] = React.useState(0);
  const [receiverRatingComment, setReceiverRatingComment] = React.useState("");
  const [receiverRatingSubmitted, setReceiverRatingSubmitted] = React.useState(false);
  const [receiverMode, setReceiverMode] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [quote, setQuote] = React.useState<Awaited<ReturnType<typeof api.quote>> | null>(null);
  const [includeProtection, setIncludeProtection] = React.useState(true);
  const [delivery, setDelivery] = React.useState<ApiDelivery | null>(null);
  const [trackingCode, setTrackingCode] = React.useState("");
  const [trackingPhone, setTrackingPhone] = React.useState("");
  const [location, setLocation] = React.useState<ApiDelivery["latestLocation"]>(null);
  const [ratingStars, setRatingStars] = React.useState(0);
  const [ratingComment, setRatingComment] = React.useState("");
  const [ratingSubmitted, setRatingSubmitted] = React.useState(false);
  const [notifications, setNotifications] = React.useState<Array<{ id: string; title: string; body: string; type: string; read_at?: string | null; created_at: string }>>([]);
  const [showNotifications, setShowNotifications] = React.useState(false);
  const [showSupport, setShowSupport] = React.useState(false);
  const [supportCategory, setSupportCategory] = React.useState<"ORDER" | "APP">("ORDER");
  const [supportSubject, setSupportSubject] = React.useState("");
  const [supportMessage, setSupportMessage] = React.useState("");
  const [rescheduleAt, setRescheduleAt] = React.useState("");
  const [supportTickets, setSupportTickets] = React.useState<any[]>([]);
  const [disputeReason, setDisputeReason] = React.useState("");
  const [disputeDescription, setDisputeDescription] = React.useState("");
  const [disputeSubmitted, setDisputeSubmitted] = React.useState(false);
  const [swiftAiQuestion, setSwiftAiQuestion] = React.useState("");
  const [swiftAiAnswer, setSwiftAiAnswer] = React.useState("");
  const [swiftAiBusy, setSwiftAiBusy] = React.useState(false);
  const socketRef = React.useRef<WebSocket | null>(null);

  async function registerPushNotifications() {
    try {
      const permission = await Notifications.getPermissionsAsync();
      let status = permission.status;
      if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
      if (status !== "granted") return;
      const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
      const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      await api.registerDeviceToken(token.data, Platform.OS === "ios" ? "IOS" : "ANDROID");
    } catch {}
  }

  React.useEffect(() => {
    if (Platform.OS === "web" && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  React.useEffect(() => {
    AsyncStorage.getItem("swiftdrop.customerAccessToken").then(token => {
      if (token) {
        api.setAccessToken(token);
        setSignedIn(true);
        void registerPushNotifications();
        void loadNotifications();
      }
    });
    return () => socketRef.current?.close();
  }, []);

  async function signIn() {
    try {
      const data = await api.login(authPhone.trim(), authPassword);
      if (data.user.role !== "CUSTOMER") throw new Error("This account is not a customer account.");
      await AsyncStorage.setItem("swiftdrop.customerAccessToken", data.accessToken);
      setSignedIn(true);
      void registerPushNotifications();
      void loadNotifications();
    } catch (error) {
      Alert.alert("Sign in failed", error instanceof Error ? error.message : "Unable to sign in");
    }
  }

  async function registerCustomer() {
    try {
      if (!legalConsent) throw new Error("Please accept the Terms, Privacy Notice, and Acceptable Use Policy to create an account.");
      const data = await api.register({
        fullName: authName.trim(),
        phone: authPhone.trim(),
        email: authEmail.trim() || undefined,
        password: authPassword,
        role: "CUSTOMER",
        termsAccepted: true,
        privacyAccepted: true,
        acceptableUseAccepted: true
      });
      await AsyncStorage.setItem("swiftdrop.customerAccessToken", data.accessToken);
      setSignedIn(true);
      void registerPushNotifications();
      void loadNotifications();
    } catch (error) {
      Alert.alert("Registration failed", error instanceof Error ? error.message : "Unable to register");
    }
  }

  async function loadNotifications() {
    try { setNotifications(await api.notifications()); } catch {}
  }

  async function openNearbyDropOffLocations() {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") throw new Error("Location permission is required to find nearby SwiftDrop partner locations.");
      const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setPickupLat(String(current.coords.latitude)); setPickupLng(String(current.coords.longitude));
      const locations = await api.nearbyDropOffLocations(current.coords.latitude, current.coords.longitude, 25);
      setPickupDropOffLocations(locations);
      setHomeSection("LOCATIONS");
    } catch (error) { Alert.alert("Drop-off locations", error instanceof Error ? error.message : "Unable to load nearby locations"); }
  }

  async function loadMarketplaceOrders() {
    try { setMarketplaceOrders(await api.marketplaceOrders()); } catch {}
  }

  async function loadMarketplaceSales() {
    try { setMarketplaceSales(await api.marketplaceSales()); }
    catch (error) { Alert.alert("Marketplace sales", error instanceof Error ? error.message : "Unable to load your sales"); }
  }

  async function loadMarketplaceMyListings() {
    try { setMarketplaceMyListings(await api.marketplaceMyListings()); }
    catch (error) { Alert.alert("My listings", error instanceof Error ? error.message : "Unable to load your listings"); }
  }

  async function updateMarketplaceListingState(listing: any, patch: any) {
    try {
      await api.updateMarketplaceListing(String(listing.id), patch);
      await loadMarketplaceMyListings();
      await loadMarketplace(marketplaceSearch);
      Alert.alert("Listing updated", "Your marketplace listing has been updated.");
    } catch (error) {
      Alert.alert("Listing update failed", error instanceof Error ? error.message : "Unable to update listing");
    }
  }

  async function markMarketplaceSaleReady(sale: any) {
    const preparation = Number(sale.seller_preparation_minutes ?? 0);
    try {
      await api.markMarketplaceOrderReady(String(sale.id), preparation, Boolean(sale.seller_busy_mode));
      await loadMarketplaceSales();
      Alert.alert("Order ready", "The courier can now proceed with pickup.");
    } catch (error) {
      Alert.alert("Mark ready failed", error instanceof Error ? error.message : "Unable to mark the order ready");
    }
  }

  async function loadMarketplace(query = "") {
    setMarketplaceLoading(true);
    try { setMarketplaceListings(await api.marketplaceListings(query)); }
    catch (error) { Alert.alert("Shop", error instanceof Error ? error.message : "Unable to load SwiftDrop Shop"); }
    finally { setMarketplaceLoading(false); }
  }

  React.useEffect(() => {
    if (homeSection === "SHOP" && signedIn) {
      void loadMarketplaceOrders();
      void loadMarketplaceSales();
      void loadMarketplaceMyListings();
    }
  }, [homeSection, signedIn]);

  async function openMarketplaceListing(id: string) {
    try {
      const data = await api.marketplaceListing(id);
      setSelectedListing(data.listing);
      setMarketplaceDeliveryAt("");
      setRecommendedListings(data.recommended ?? []);
      try { setSelectedSellerTrust(await api.marketplaceSeller(String(data.listing.seller_id ?? data.listing.seller_user_id))); } catch { setSelectedSellerTrust(null); }
    } catch (error) { Alert.alert("Shop", error instanceof Error ? error.message : "Unable to open this product"); }
  }

  async function pickSellerMedia() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Product photos", "Allow SwiftDrop access to your photos so you can add product images.");
      return;
    }
    const remaining = Math.max(0, 8 - sellerMedia.length);
    if (remaining === 0) {
      Alert.alert("Product photos", "You can add up to 8 product images.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 0.75,
      base64: true,
      exif: false
    });
    if (result.canceled) return;
    const selected = result.assets
      .filter(asset => asset.mimeType === "image/jpeg" || asset.mimeType === "image/png" || asset.mimeType === "image/webp")
      .map(asset => asset.base64 ? "data:" + (asset.mimeType ?? "image/jpeg") + ";base64," + asset.base64 : "")
      .filter(Boolean);
    if (!selected.length) {
      Alert.alert("Product photos", "Please choose JPEG, PNG, or WebP images.");
      return;
    }
    setSellerMedia(current => [...current, ...selected].slice(0, 8));
  }

  async function publishMarketplaceListing() {
    const price = Number(sellerPrice);
    const deliveryFee = Number(sellerDeliveryFee || 0);
    const stock = Number(sellerStock);
    if (!sellerTitle.trim() || sellerDescription.trim().length < 10 || sellerCategory.trim().length < 2 || sellerUseDescription.trim().length < 5) {
      Alert.alert("Sell an item", "Add a title, at least 10 characters of description, category, and explain the item's ordinary use.");
      return;
    }
    if (!Number.isSafeInteger(Math.round(price * 100)) || price <= 0 || !Number.isFinite(deliveryFee) || deliveryFee < 0 || !Number.isInteger(stock) || stock < 0) {
      Alert.alert("Sell an item", "Enter valid price, delivery fee, and stock values.");
      return;
    }
    const pickupLatitude = Number(sellerPickupLat);
    const pickupLongitude = Number(sellerPickupLng);
    const weight = Number(sellerWeightKg);
    const length = Number(sellerLengthCm);
    const width = Number(sellerWidthCm);
    const height = Number(sellerHeightCm);
    if (sellerDeliveryMode !== "PICKUP" && (!sellerPickupAddress.trim() || !Number.isFinite(pickupLatitude) || !Number.isFinite(pickupLongitude) || !Number.isFinite(weight) || weight <= 0 || !Number.isFinite(length) || length <= 0 || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0)) {
      Alert.alert("Sell an item", "Courier-delivered items need the seller pickup address, GPS coordinates, weight and dimensions.");
      return;
    }
    setSellerPublishing(true);
    try {
      await api.createMarketplaceListing({
        displayName: authName.trim() || "SwiftDrop Seller",
        bio: "SwiftDrop marketplace seller",
        title: sellerTitle.trim(),
        description: sellerDescription.trim(),
        condition: sellerCondition,
        useDescription: sellerUseDescription.trim(),
        usageInstructions: sellerUsageInstructions.trim() || undefined,
        category: sellerCategory.trim(),
        priceMinor: Math.round(price * 100),
        deliveryFeeMinor: Math.round(deliveryFee * 100),
        deliveryMode: sellerDeliveryMode,
        stockQuantity: stock,
        pickupAddress: sellerPickupAddress.trim(),
        pickupLatitude: Number.isFinite(pickupLatitude) ? pickupLatitude : 0,
        pickupLongitude: Number.isFinite(pickupLongitude) ? pickupLongitude : 0,
        weightKg: Number.isFinite(weight) ? weight : 1,
        lengthCm: Number.isFinite(length) ? length : 1,
        widthCm: Number.isFinite(width) ? width : 1,
        heightCm: Number.isFinite(height) ? height : 1,
        isPerishable: sellerPerishable,
        media: sellerMedia
      });
      setSellerTitle(""); setSellerDescription(""); setSellerCategory(""); setSellerUseDescription(""); setSellerUsageInstructions(""); setSellerMedia([]);
      setSellerPrice(""); setSellerDeliveryFee(""); setSellerStock("1");
      setSellerPickupAddress(""); setSellerPickupLat(""); setSellerPickupLng(""); setSellerWeightKg(""); setSellerLengthCm(""); setSellerWidthCm(""); setSellerHeightCm(""); setSellerPerishable(false);
      setShowSellerForm(false);
      await loadMarketplace(marketplaceSearch);
      Alert.alert("Published", "Your item is now listed for sale on SwiftDrop Shop.");
    } catch (error) {
      Alert.alert("Publish failed", error instanceof Error ? error.message : "Unable to publish your item");
    } finally {
      setSellerPublishing(false);
    }
  }

  async function checkoutMarketplaceListing() {
    if (!selectedListing) return;
    if (!authEmail.trim()) {
      Alert.alert("Payment email", "Add your email to your account before paying for a marketplace order.");
      return;
    }
    try {
      const requestedDeliveryAt = marketplaceDeliveryAt.trim() || undefined;
      if (requestedDeliveryAt && Number.isNaN(new Date(requestedDeliveryAt).getTime())) {
        Alert.alert("Delivery time", "Enter a valid date/time, for example 2026-10-05T14:00:00+01:00.");
        return;
      }
      const checkoutIdempotencyKey = `mkt-${selectedListing.id}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
      const data = await api.checkoutMarketplaceListing(selectedListing.id, 1, requestedDeliveryAt, checkoutIdempotencyKey);
      const payment = await api.initializeMarketplacePayment(data.order.id, authEmail.trim());
      await WebBrowser.openBrowserAsync(payment.authorizationUrl);
      let verification: any = null;
      try { verification = await api.verifyMarketplacePayment(data.order.id); } catch {}
      if (verification?.status === "AUTHORIZED" && selectedListing.delivery_mode !== "PICKUP") {
        const lat = Number(marketplaceDropoffLat);
        const lng = Number(marketplaceDropoffLng);
        if (marketplaceReceiverName.trim() && marketplaceReceiverPhone.trim() && /^\d{6}$/.test(marketplaceReceiverPin) && marketplaceDropoffAddress.trim() && Number.isFinite(lat) && Number.isFinite(lng)) {
          await api.fulfillMarketplaceOrder(data.order.id, {
            receiverName: marketplaceReceiverName.trim(),
            receiverPhone: marketplaceReceiverPhone.trim(),
            receiverPin: marketplaceReceiverPin,
            dropoffAddress: marketplaceDropoffAddress.trim(),
            dropoffLatitude: lat,
            dropoffLongitude: lng
          });
        }
      }
      await loadMarketplaceOrders();
      Alert.alert(
        "Payment submitted",
        "SwiftDrop has checked the payment status. If Paystack is still processing, refresh My marketplace orders shortly. Final price including delivery: ₦" +
          (Number(data.order.total_minor) / 100).toLocaleString()
      );
    } catch (error) {
      Alert.alert("Checkout", error instanceof Error ? error.message : "Unable to start marketplace payment");
    }
  }

  async function fulfillExistingMarketplaceOrder(orderId: string) {
    const lat = Number(marketplaceDropoffLat);
    const lng = Number(marketplaceDropoffLng);
    if (!marketplaceReceiverName.trim() || !marketplaceReceiverPhone.trim() || !/^\d{6}$/.test(marketplaceReceiverPin) || !marketplaceDropoffAddress.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      Alert.alert("Delivery details", "Enter receiver name, phone, a 6-digit PIN, and a valid drop-off address with GPS coordinates.");
      return;
    }
    try {
      await api.fulfillMarketplaceOrder(orderId, {
        receiverName: marketplaceReceiverName.trim(),
        receiverPhone: marketplaceReceiverPhone.trim(),
        receiverPin: marketplaceReceiverPin,
        dropoffAddress: marketplaceDropoffAddress.trim(),
        dropoffLatitude: lat,
        dropoffLongitude: lng
      });
      await loadMarketplaceOrders();
      setMarketplaceReceiverName(""); setMarketplaceReceiverPhone(""); setMarketplaceReceiverPin("");
      setMarketplaceDropoffAddress(""); setMarketplaceDropoffLat(""); setMarketplaceDropoffLng("");
      Alert.alert("Delivery initialized", "Your marketplace order is now connected to SwiftDrop tracking.");
    } catch (error) {
      Alert.alert("Delivery setup failed", error instanceof Error ? error.message : "Unable to initialize marketplace delivery");
    }
  }

  async function loadSupportTickets() {
    try { setSupportTickets(await api.supportTickets()); } catch {}
  }

  async function rescheduleDelivery() {
    if (!delivery || !rescheduleAt.trim()) {
      Alert.alert("Reschedule", "Enter a future date and time in ISO format, for example 2026-10-01T14:00:00Z.");
      return;
    }
    try {
      const response = await fetch(API_URL + "/api/deliveries/" + encodeURIComponent(delivery.id) + "/reschedule", {
        method: "POST",
        headers: { authorization: "Bearer " + (await AsyncStorage.getItem("swiftdrop.customerAccessToken") ?? ""), "content-type": "application/json" },
        body: JSON.stringify({ nextDeliveryAt: rescheduleAt.trim() })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to reschedule delivery");
      setDelivery({ ...delivery, exceptionStatus: data.exceptionStatus, nextDeliveryAt: data.nextDeliveryAt });
      Alert.alert("Delivery rescheduled", new Date(data.nextDeliveryAt).toLocaleString());
    } catch (error) {
      Alert.alert("Reschedule failed", error instanceof Error ? error.message : "Unable to reschedule delivery");
    }
  }

  async function requestReturnToSender() {
    if (!delivery) return;
    try {
      const response = await fetch(API_URL + "/api/deliveries/" + encodeURIComponent(delivery.id) + "/return-to-sender", {
        method: "POST",
        headers: { authorization: "Bearer " + (await AsyncStorage.getItem("swiftdrop.customerAccessToken") ?? ""), "content-type": "application/json" }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to request return");
      setDelivery({ ...delivery, exceptionStatus: data.exceptionStatus });
      Alert.alert("Return requested", "SwiftDrop operations will move the parcel into the return workflow.");
    } catch (error) {
      Alert.alert("Return request failed", error instanceof Error ? error.message : "Unable to request return");
    }
  }

  async function askSwiftAi() {
    const question = swiftAiQuestion.trim();
    if (!question) return;
    setSwiftAiBusy(true);
    try {
      const token = await AsyncStorage.getItem("swiftdrop.customerAccessToken");
      const response = await fetch(API_URL + "/api/ai/query", {
        method: "POST",
        headers: { authorization: "Bearer " + (token ?? ""), "content-type": "application/json" },
        body: JSON.stringify({ question })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Swift AI is unavailable");
      setSwiftAiAnswer(String(data.answer ?? "No answer was returned."));
    } catch (error) {
      Alert.alert("Swift AI", error instanceof Error ? error.message : "Unable to reach Swift AI");
    } finally {
      setSwiftAiBusy(false);
    }
  }

  async function runSwiftAiAction(action: "RESCHEDULE_DELIVERY" | "REQUEST_RETURN_TO_SENDER") {
    if (!delivery) return;
    setSwiftAiBusy(true);
    try {
      const token = await AsyncStorage.getItem("swiftdrop.customerAccessToken");
      const input = action === "RESCHEDULE_DELIVERY"
        ? { deliveryId: delivery.id, nextDeliveryAt: rescheduleAt.trim() }
        : { deliveryId: delivery.id };
      const response = await fetch(API_URL + "/api/ai/action", {
        method: "POST",
        headers: { authorization: "Bearer " + (token ?? ""), "content-type": "application/json" },
        body: JSON.stringify({ action, input })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Swift AI action was not completed");
      setDelivery(prev => prev ? {
        ...prev,
        exceptionStatus: data.exceptionStatus,
        nextDeliveryAt: data.nextDeliveryAt ?? prev.nextDeliveryAt
      } : prev);
      Alert.alert(
        "Swift AI completed the action",
        action === "RESCHEDULE_DELIVERY"
          ? new Date(data.nextDeliveryAt).toLocaleString()
          : "The parcel is now in the return-request workflow."
      );
    } catch (error) {
      Alert.alert("Swift AI action", error instanceof Error ? error.message : "Unable to complete the AI action");
    } finally {
      setSwiftAiBusy(false);
    }
  }

  async function refreshErrand(errandId: string) {
    try {
      setErrandDetailBusy(true);
      const detail = await api.errand(errandId);
      setSelectedErrand(detail.errand);
      setErrandDetail(detail);
      setMyErrands(prev => prev.map(item => item.id === errandId ? detail.errand : item));
      return detail;
    } catch (error) {
      Alert.alert("Errand", error instanceof Error ? error.message : "Unable to refresh errand");
      return null;
    } finally {
      setErrandDetailBusy(false);
    }
  }

  async function createErrand() {
    try {
      const d = errandDraft;
      if (!d.description.trim() || !d.receiverName.trim() || !d.receiverPhone.trim() || !/^\d{4,6}$/.test(d.receiverPin)) {
        throw new Error("Complete the errand description and receiver details, including a 4-6 digit PIN.");
      }
      if (d.errandType !== "GENERAL_ERRAND" && !(Number(d.spendingCeiling) > 0)) {
        throw new Error("Shopping errands require a positive spending ceiling.");
      }
      const lat = Number(d.destinationLat), lng = Number(d.destinationLng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw new Error("Enter valid destination coordinates.");
      }
      for (const [index, stop] of errandStops.entries()) {
        const stopLat = Number(stop.latitude), stopLng = Number(stop.longitude);
        if (!stop.label.trim() || !stop.address.trim() || !Number.isFinite(stopLat) || !Number.isFinite(stopLng) || stopLat < -90 || stopLat > 90 || stopLng < -180 || stopLng > 180) {
          throw new Error("Complete the label, address and valid GPS coordinates for every errand stop.");
        }
        if (index >= 10) throw new Error("You can add up to 10 errand stops.");
      }
      setErrandBusy(true);
      const result = await api.createErrand({
        errandType: d.errandType,
        description: d.description.trim(),
        items: [{
          description: d.itemDescription.trim() || d.description.trim(),
          quantity: 1,
          maxAuthorizedMinor: Math.round(Number(d.spendingCeiling || 0) * 100),
          requestedPriceMinor: d.requestedPrice.trim() ? Math.round(Number(d.requestedPrice) * 100) : undefined,
          replacementPolicy: d.replacementPolicy
        }],
        spendingCeilingMinor: Math.round(Number(d.spendingCeiling || 0) * 100),
        merchantName: d.merchantName.trim() || undefined,
        merchantAddress: d.merchantAddress.trim() || undefined,
        replacementPolicy: d.replacementPolicy,
        maxPriceDeltaMinor: Math.round(Number(d.maxPriceDelta || 0) * 100),
        instructions: d.instructions.trim() || undefined,
        requestedCompletionAt: d.requestedCompletionAt.trim() || undefined,
        receiverName: d.receiverName.trim(),
        receiverPhone: d.receiverPhone.trim(),
        receiverPin: d.receiverPin,
        destinationAddress: d.destinationAddress.trim(),
        destinationLat: lat,
        destinationLng: lng,
        stops: errandStops.map(stop => ({ stopType: stop.stopType, label: stop.label.trim(), address: stop.address.trim(), latitude: Number(stop.latitude), longitude: Number(stop.longitude), instructions: stop.instructions.trim() || undefined }))
      });
      setMyErrands(prev => [result.errand, ...prev]);
      setErrandStops([]);
      try {
        const payment = await api.initializeErrandPayment(result.errand.id);
        if (payment.authorizationUrl) {
          await WebBrowser.openBrowserAsync(payment.authorizationUrl);
          Alert.alert("Payment started", "Complete the Paystack payment. SwiftDrop will verify the payment before an agent can accept the errand.");
        } else {
          Alert.alert("Errand created", "Your errand is saved. Payment is already authorized or awaiting reconciliation.");
        }
      } catch (paymentError) {
        Alert.alert("Errand created — payment still required", paymentError instanceof Error ? paymentError.message : "Open this errand again to complete payment before an agent can accept it.");
      }
      setErrandDraft(prev => ({ ...prev, description: "", itemDescription: "", instructions: "", receiverPin: "" }));
    } catch (error) {
      Alert.alert("Errand failed", error instanceof Error ? error.message : "Unable to create errand.");
    } finally {
      setErrandBusy(false);
    }
  }

  async function submitSupportTicket() {
    try {
      if (supportSubject.trim().length < 3 || supportMessage.trim().length < 5) throw new Error("Enter a clear subject and describe the help you need.");
      await api.createSupportTicket({ category: supportCategory, subject: supportSubject.trim(), message: supportMessage.trim(), deliveryId: supportCategory === "ORDER" ? delivery?.id : undefined });
      setSupportSubject(""); setSupportMessage("");
      await loadSupportTickets();
      Alert.alert("Support request sent", "Our support team can now review your request and order details.");
    } catch (error) { Alert.alert("Support request failed", error instanceof Error ? error.message : "Unable to contact support"); }
  }

  async function markNotificationRead(id: string) {
    try { await api.markNotificationRead(id); setNotifications(items => items.map(item => item.id === id ? { ...item, read_at: new Date().toISOString() } : item)); } catch {}
  }

  async function searchAddress(query: string, target: "pickup" | "dropoff") {
    try {
      if (query.trim().length < 3) {
        target === "pickup" ? setPickupResults([]) : setDropoffResults([]);
        return;
      }
      const results = await api.searchLocations(query);
      target === "pickup" ? setPickupResults(results) : setDropoffResults(results);
    } catch {}
  }

  function chooseAddress(result: { formattedAddress?: string; latitude: number; longitude: number }, target: "pickup" | "dropoff") {
    const address = result.formattedAddress ?? "";
    if (target === "pickup") {
      setPickup(address); setPickupLat(String(result.latitude)); setPickupLng(String(result.longitude)); setPickupResults([]);
    } else {
      setDropoff(address); setDropoffLat(String(result.latitude)); setDropoffLng(String(result.longitude)); setDropoffResults([]);
    }
  }

  async function loadNearbyDropOffs(target: "pickup" | "dropoff") {
    try {
      const lat = Number(target === "pickup" ? pickupLat : dropoffLat);      const lng = Number(target === "pickup" ? pickupLng : dropoffLng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("Select or enter a valid location first.");
      const locations = await api.nearbyDropOffLocations(lat, lng, 25);
      target === "pickup" ? setPickupDropOffLocations(locations) : setDropoffDropOffLocations(locations);
    } catch (error) {
      Alert.alert("Drop-off locations", error instanceof Error ? error.message : "Unable to load nearby SwiftDrop drop-off locations.");
    }
  }

  function chooseDropOffLocation(location: any, target: "pickup" | "dropoff") {
    const address = String(location.address ?? location.name ?? "");
    if (target === "pickup") {
      setPickupDropOffId(String(location.id)); setPickup(address); setPickupLat(String(location.latitude)); setPickupLng(String(location.longitude)); setPickupDropOffLocations([]);
    } else {
      setDropoffDropOffId(String(location.id)); setDropoff(address); setDropoffLat(String(location.latitude)); setDropoffLng(String(location.longitude)); setDropoffDropOffLocations([]);
    }
  }

  function coordinates() {
    const values = [pickupLat, pickupLng, dropoffLat, dropoffLng].map(Number);
    if (values.some(Number.isNaN) || values[0] < -90 || values[0] > 90 || values[2] < -90 || values[2] > 90 || values[1] < -180 || values[1] > 180 || values[3] < -180 || values[3] > 180) {
      throw new Error("Enter valid pickup and drop-off coordinates.");
    }
    return { pickup: { latitude: values[0], longitude: values[1] }, dropoff: { latitude: values[2], longitude: values[3] } };
  }

  async function useCurrentPickupLocation() {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") throw new Error("Location permission is required to use your current position.");
      const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setPickupLat(String(current.coords.latitude));
      setPickupLng(String(current.coords.longitude));
      setPickup(prev => prev || "Current location");
      Alert.alert("Pickup location set", "Your current GPS coordinates are now selected as the pickup point.");
    } catch (error) {
      Alert.alert("Location unavailable", error instanceof Error ? error.message : "Unable to read your location.");
    }
  }

  async function getQuote() {
    try {
      if (![weightKg, lengthCm, widthCm, heightCm].every(value => Number(value) > 0)) throw new Error("Enter parcel weight and all three dimensions first.");
      const coords = coordinates();
      setQuote(await api.quote({ ...coords, weightKg: Number(weightKg), dimensionsCm: { length: Number(lengthCm), width: Number(widthCm), height: Number(heightCm) }, isPerishable, declaredValueMinor: Math.round(Number(declaredValue) * 100), includeProtection }));
    } catch (error) {
      Alert.alert("Quote unavailable", error instanceof Error ? error.message : "Enter valid locations.");
    }
  }

  async function createDelivery() {
    try {
      if (!pickup.trim() || !dropoff.trim() || !receiver.trim() || !phone.trim() || !/^\d{4}$/.test(receiverPin)) throw new Error("Complete the delivery details and enter a 4-digit receiver PIN.");
      if (paymentMode === "SENDER_ESCROW" && !email.trim()) throw new Error("Enter your payment email for sender-paid escrow.");
      const coords = coordinates();
      if (![weightKg, lengthCm, widthCm, heightCm].every(value => Number(value) > 0)) throw new Error("Enter parcel weight and all three dimensions.");
      if (!(Number(declaredValue) > 0)) throw new Error("Enter the actual value of the goods before placing the order.");
      const serverQuote = await api.quote({ ...coords, weightKg: Number(weightKg), dimensionsCm: { length: Number(lengthCm), width: Number(widthCm), height: Number(heightCm) }, isPerishable, declaredValueMinor: Math.round(Number(declaredValue) * 100), includeProtection });
      setQuote(serverQuote);
      const created = await api.createDelivery({
        receiverName: receiver.trim(),
        receiverPhone: phone.trim(),
        receiverPin,
        paymentMode,
        declaredValueMinor: Math.round(Number(declaredValue) * 100),
        includeProtection,
        weightKg: Number(weightKg),
        dimensionsCm: { length: Number(lengthCm), width: Number(widthCm), height: Number(heightCm) },
        isPerishable,
        pickup: { label: pickupDropOffId ? "SwiftDrop drop-off point" : "Pickup", formattedAddress: pickup.trim(), ...coords.pickup },
        dropoff: { label: dropoffDropOffId ? "SwiftDrop drop-off point" : "Drop-off", formattedAddress: dropoff.trim(), ...coords.dropoff },
        pickupDropOffLocationId: pickupDropOffId || undefined,
        pickupInstructions: pickupInstructions.trim() || undefined,
        dropoffInstructions: dropoffInstructions.trim() || undefined,
        dropoffDropOffLocationId: dropoffDropOffId || undefined,
        quote: { ...serverQuote, currency: "NGN" }
      });
      setDelivery(created);
      setTrackingCode(created.trackingCode);
      const escrow = await api.createEscrow(created.id, serverQuote.totalMinor);
      const payment = await api.payEscrow(created.id, "PAYSTACK_CARD", crypto.randomUUID());
      if (payment?.authorizationUrl) await WebBrowser.openBrowserAsync(payment.authorizationUrl);
      Alert.alert("Payment", "Complete payment. SwiftDrop will verify escrow from the payment provider webhook.");
      void escrow;
    } catch (error) {
      Alert.alert("Delivery failed", error instanceof Error ? error.message : "Unable to create delivery.");
    }
  }

  async function track() {
    try {
      socketRef.current?.close();
      if (!trackingPhone.trim()) throw new Error("Enter the receiver phone number used for this delivery.");
      const tracked = await api.track(trackingCode.trim().toUpperCase(), trackingPhone.trim());
      setDelivery(tracked);
      setLocation(tracked.latestLocation ?? null);
      const session = await api.createTrackingSession(tracked.trackingCode, trackingPhone.trim());
      socketRef.current = api.connectToTracking(session.deliveryId, session.trackingToken, next => setLocation(next), update => setDelivery(prev => prev ? { ...prev, ...update } : prev));
    } catch (error) {
      Alert.alert("Tracking failed", error instanceof Error ? error.message : "Tracking code not found.");
    }
  }

  async function confirmReceipt() {
    if (!delivery || !trackingPhone.trim() || receiverConfirmPin.length !== 6) {
      Alert.alert("Receipt confirmation", "Enter the receiver phone number and six-digit PIN.");
      return;
    }
    try {
      const result = await api.confirmReceiver(delivery.id, trackingPhone.trim(), receiverConfirmPin);
      setDelivery(result.delivery);
      if (result.paymentRequired) {
        if (!email.trim()) {
          Alert.alert("Receiver payment", "Package confirmed. Enter the receiver's payment email and tap Pay receiver amount to complete payment.");
          return;
        }
        const payment = await api.initializeReceiverPayment(delivery.id, trackingPhone.trim(), receiverConfirmPin, email.trim());
        await WebBrowser.openBrowserAsync(payment.authorizationUrl);
        Alert.alert("Receiver payment", "Complete payment. SwiftDrop will verify the provider webhook and then complete the order.");
      } else {
        Alert.alert("Receipt confirmed", "The delivery is complete and the held payment has been released for courier payout.");
      }
    } catch (error) {
      Alert.alert("Confirmation failed", error instanceof Error ? error.message : "Unable to confirm receipt");
    }
  }

  async function submitReceiverRating() {
    if (!delivery || receiverRatingStars < 1) {
      Alert.alert("Rating", "Please select a rating from 1 to 5 stars.");
      return;
    }
    try {
      await api.rateReceiverDelivery(delivery.id, trackingPhone.trim(), receiverConfirmPin, receiverRatingStars, receiverRatingComment.trim() || undefined);
      setReceiverRatingSubmitted(true);
    } catch (error) {
      Alert.alert("Rating failed", error instanceof Error ? error.message : "Unable to save receiver rating");
    }
  }

  async function submitRating() {
    if (!delivery || ratingStars < 1) {
      Alert.alert("Rating", "Please select a rating from 1 to 5 stars.");
      return;
    }
    try {
      await api.rateDelivery(delivery.id, ratingStars, ratingComment.trim() || undefined);
      setRatingSubmitted(true);
      Alert.alert("Thank you", "Your delivery rating has been saved.");
    } catch (error) {
      Alert.alert("Rating failed", error instanceof Error ? error.message : "Unable to save rating.");
    }
  }

  async function signOut() {
    socketRef.current?.close();
    await AsyncStorage.removeItem("swiftdrop.customerAccessToken");
    setSignedIn(false);
    setDelivery(null);
  }

  if (!signedIn && receiverMode) {
    return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.auth}>
      <Text style={styles.logo}>SwiftDrop</Text><Text style={styles.brandTag}>MOVE WITH CONFIDENCE</Text><Text style={styles.eyebrow}>RECEIVER</Text>
      <Text style={styles.subtitle}>Confirm receipt with your PIN. If the sender selected receiver payment, you will pay the order amount immediately after confirmation.</Text>
      <TextInput style={styles.input} placeholder="Tracking code" value={trackingCode} onChangeText={setTrackingCode} autoCapitalize="characters" />
      <TextInput style={styles.input} placeholder="Receiver phone number" value={trackingPhone} onChangeText={setTrackingPhone} keyboardType="phone-pad" />
      <TextInput style={styles.input} placeholder="Six-digit receiver PIN" value={receiverConfirmPin} onChangeText={setReceiverConfirmPin} keyboardType="number-pad" secureTextEntry maxLength={4} />
      <TextInput style={styles.input} placeholder="Payment email (required if receiver pays)" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
      <Pressable style={styles.primary} onPress={() => void (async () => {
        try {
          const tracked = await api.track(trackingCode.trim().toUpperCase(), trackingPhone.trim());
          setDelivery(tracked);
          if (tracked.status !== "ARRIVED") throw new Error("The courier has not marked the parcel as arrived yet.");
          const result = await api.confirmReceiver(tracked.id, trackingPhone.trim(), receiverConfirmPin);
          setDelivery(result.delivery);
          if (result.paymentRequired) {
            if (!email.trim()) throw new Error("Enter the receiver payment email before paying.");
            const payment = await api.initializeReceiverPayment(tracked.id, trackingPhone.trim(), receiverConfirmPin, email.trim());
            await WebBrowser.openBrowserAsync(payment.authorizationUrl);
            Alert.alert("Payment started", "Complete the receiver payment. SwiftDrop will verify it before marking the order delivered.");
          } else {
            Alert.alert("Delivery complete", "Receipt confirmed. Courier payment has been released for payout.");
          }
        } catch (error) {
          Alert.alert("Unable to complete", error instanceof Error ? error.message : "Please check the tracking details.");
        }
      })()}><Text style={styles.primaryText}>I received the parcel</Text></Pressable>
            {delivery && !disputeSubmitted && <View style={styles.ratingBox}>
        <Text style={styles.photoTitle}>Need help with this delivery?</Text>
        <Text style={styles.muted}>If the parcel was not received or something went wrong, file a dispute for SwiftDrop to review. A refund may be considered based on the circumstances.</Text>
        <TextInput style={styles.input} placeholder="Dispute reason" value={disputeReason} onChangeText={setDisputeReason} maxLength={120} />
        <TextInput style={[styles.input, styles.multiline]} placeholder="Explain what happened" value={disputeDescription} onChangeText={setDisputeDescription} maxLength={2000} multiline />
        <Pressable style={styles.dangerButton} onPress={() => void (async () => { try { await api.createReceiverDispute(trackingCode.trim().toUpperCase(), trackingPhone.trim(), receiverConfirmPin, disputeReason.trim(), disputeDescription.trim()); setDisputeSubmitted(true); Alert.alert("Dispute submitted", "SwiftDrop support will review the circumstances."); } catch (error) { Alert.alert("Dispute failed", error instanceof Error ? error.message : "Unable to file dispute"); } })()}><Text style={styles.primaryText}>File a delivery dispute</Text></Pressable>
      </View>}
      {disputeSubmitted && <Text style={styles.done}>✓ Dispute submitted for review</Text>}
{delivery?.status === "DELIVERED" && <View style={styles.ratingBox}>
        <Text style={styles.photoTitle}>Review your courier</Text>
        {receiverRatingSubmitted ? <Text style={styles.done}>✓ Review submitted</Text> : <>
          <Text style={styles.muted}>Choose one review level:</Text>
          <View style={styles.reviewRow}>
            <Pressable style={[styles.reviewButton, styles.reviewBad]} onPress={() => { setReceiverRatingStars(1); void api.rateReceiverDelivery(delivery!.id, trackingPhone.trim(), receiverConfirmPin, 1).then(() => setReceiverRatingSubmitted(true)).catch(error => Alert.alert("Rating failed", error instanceof Error ? error.message : "Unable to save review")); }}><Text style={styles.reviewButtonText}>Bad</Text></Pressable>
            <Pressable style={[styles.reviewButton, styles.reviewFair]} onPress={() => { setReceiverRatingStars(3); void api.rateReceiverDelivery(delivery!.id, trackingPhone.trim(), receiverConfirmPin, 3).then(() => setReceiverRatingSubmitted(true)).catch(error => Alert.alert("Rating failed", error instanceof Error ? error.message : "Unable to save review")); }}><Text style={styles.reviewButtonText}>Fair</Text></Pressable>
            <Pressable style={[styles.reviewButton, styles.reviewExcellent]} onPress={() => { setReceiverRatingStars(5); void api.rateReceiverDelivery(delivery!.id, trackingPhone.trim(), receiverConfirmPin, 5).then(() => setReceiverRatingSubmitted(true)).catch(error => Alert.alert("Rating failed", error instanceof Error ? error.message : "Unable to save review")); }}><Text style={styles.reviewButtonText}>Excellent</Text></Pressable>
          </View>
        </>}
      </View>}
      <Pressable style={styles.secondary} onPress={() => setReceiverMode(false)}><Text>Back to customer sign in</Text></Pressable>
    </ScrollView></SafeAreaView>;
  }

  if (!signedIn) {
    return <SafeAreaView style={styles.safe}><View style={styles.auth}>
      <Text style={styles.logo}>SwiftDrop</Text>
      <Text style={styles.subtitle}>{authMode === "login" ? "Sign in to send and track parcels." : "Create your customer account."}</Text>
      {authMode === "register" && <TextInput style={styles.input} placeholder="Full name" value={authName} onChangeText={setAuthName} />}
      <TextInput style={styles.input} placeholder="Phone number" value={authPhone} onChangeText={setAuthPhone} keyboardType="phone-pad" />
      {authMode === "register" && <TextInput style={styles.input} placeholder="Email (optional)" value={authEmail} onChangeText={setAuthEmail} keyboardType="email-address" autoCapitalize="none" />}
      <TextInput style={styles.input} placeholder="Password" value={authPassword} onChangeText={setAuthPassword} secureTextEntry />
      {authMode === "register" && <Pressable onPress={() => setLegalConsent(v => !v)} style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}><Text style={{ fontSize: 20, marginRight: 8 }}>{legalConsent ? "☑" : "☐"}</Text><Text style={{ flex: 1 }}>I accept the SwiftDrop Terms of Service, Privacy Notice, and Acceptable Use Policy.</Text></Pressable>}
      <Pressable style={styles.primary} onPress={() => void (authMode === "login" ? signIn() : registerCustomer())}><Text style={styles.primaryText}>{authMode === "login" ? "Sign in" : "Create account"}</Text></Pressable>
      <Pressable onPress={() => setAuthMode(authMode === "login" ? "register" : "login")}><Text style={styles.link}>{authMode === "login" ? "Create an account" : "Already have an account? Sign in"}</Text></Pressable>
      <Pressable onPress={() => setReceiverMode(true)}><Text style={styles.link}>I am a receiver — confirm a delivery</Text></Pressable>
    </View></SafeAreaView>;
  }

  if (homeSection === "HOME") {
    return <SafeAreaView style={styles.safe}>
      <Phase1Home
        delivery={delivery}
        notifications={notifications}
        setHomeSection={setHomeSection}
        openNotifications={() => { setShowNotifications(v => !v); void loadNotifications(); }}
        signOut={() => void signOut()}
      />
    </SafeAreaView>;
  }

  if (homeSection === "HISTORY") {
    return <SafeAreaView style={styles.safe}><OrderHistory api={api} onBack={() => setHomeSection("HOME")} onTrack={(trackingCode) => { setTrackingCode(trackingCode); setHomeSection("TRACK"); }} /></SafeAreaView>;
  }

  if (homeSection === "WALLET") {
    return <SafeAreaView style={styles.safe}><WalletScreen api={api} onBack={() => setHomeSection("HOME")} onPayout={() => setHomeSection("PAYOUT")} /></SafeAreaView>;
  }

  if (homeSection === "PAYOUT") {
    return <SafeAreaView style={styles.safe}><PayoutRequestScreen api={api} onBack={() => setHomeSection("WALLET")} /></SafeAreaView>;
  }

  if (homeSection === "ESCROW") {
    const escrowAmount = Number(delivery?.quote?.totalMinor ?? quote?.totalMinor ?? 0);
    if (!delivery || !escrowAmount) return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.homeContainer}><View style={styles.card}><Text style={styles.homeHeading}>Escrow Payment</Text><Text style={styles.muted}>Create an order first. Every payment is secured through in-app escrow; cash is not accepted.</Text><Pressable style={styles.primary} onPress={() => setHomeSection("ORDER")}><Text style={styles.primaryText}>Place your order</Text></Pressable></View></ScrollView></SafeAreaView>;
    return <SafeAreaView style={styles.safe}><EscrowPaymentScreen api={api} orderId={delivery.id} amountMinor={escrowAmount} onBack={() => setHomeSection("HOME")} /></SafeAreaView>;
  }

  if (homeSection === "LOCATIONS") {
    return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.homeContainer}>
      <View style={styles.header}><View><Text style={styles.logo}>Nearby locations</Text><Text style={styles.subtitle}>SwiftDrop merchant and partner pickup / drop-off points around you.</Text></View><Pressable onPress={() => setHomeSection("HOME")}><Text style={styles.link}>Home</Text></Pressable></View>
      {pickupDropOffLocations.length === 0 ? <View style={styles.card}><Text style={styles.homeHeading}>No active partner locations found nearby.</Text><Text style={styles.muted}>Try again later or use your address for a direct pickup.</Text><Pressable style={styles.primary} onPress={() => void openNearbyDropOffLocations()}><Text style={styles.primaryText}>Search again</Text></Pressable></View> : pickupDropOffLocations.map(item => <Pressable key={item.id} style={styles.locationCard} onPress={() => { chooseDropOffLocation(item,"pickup"); setHomeSection("ORDER"); }}><Text style={styles.homeHeading}>{item.name}</Text><Text>{item.address}</Text><Text style={styles.muted}>{item.business_name ?? "SwiftDrop merchant partner"} · {Number(item.distanceKm).toFixed(1)} km away</Text><Text style={styles.done}>Capacity {item.capacity} · Tap to use for pickup</Text></Pressable>)}
      <Pressable style={styles.secondary} onPress={() => setHomeSection("ORDER")}><Text style={styles.secondaryText}>Use a regular address instead</Text></Pressable>
    </ScrollView></SafeAreaView>;
  }

  if (homeSection === "TRACK") {
    return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.homeContainer}>
      <View style={styles.header}><View><Text style={styles.logo}>Track Your Order</Text><Text style={styles.subtitle}>Follow pickup evidence, GPS movement, arrival and receiver confirmation.</Text></View><Pressable onPress={() => setHomeSection("HOME")}><Text style={styles.link}>Home</Text></Pressable></View>
      <TextInput style={styles.input} placeholder="Tracking code" value={trackingCode} onChangeText={setTrackingCode} autoCapitalize="characters" />
      <TextInput style={styles.input} placeholder="Receiver phone number" value={trackingPhone} onChangeText={setTrackingPhone} keyboardType="phone-pad" />
      <Pressable style={styles.primary} onPress={() => void track()}><Text style={styles.primaryText}>Track order</Text></Pressable>
      {delivery && <View style={styles.card}><Text style={styles.eyebrow}>LIVE TRACKING</Text><Text style={styles.heroTitle}>{delivery.status.replaceAll("_"," ")}</Text><Text>Pickup: {delivery.pickup.formattedAddress}</Text><Text>Destination: {delivery.dropoff.formattedAddress}</Text>{delivery.pickupPhotoUrl && <Text style={styles.done}>✓ Pickup evidence recorded</Text>}{location && <Text style={styles.done}>✓ GPS movement available</Text>}{delivery.status === "ARRIVED" && <Text style={styles.muted}>Arrival recorded. Receiver PIN confirmation is required for completion.</Text>}{delivery.status === "DELIVERED" && <Text style={styles.done}>✓ Delivered and receiver PIN verified</Text>}</View>}
      <Pressable style={styles.secondary} onPress={() => setHomeSection("HOME")}><Text style={styles.secondaryText}>Back to home</Text></Pressable>
    </ScrollView></SafeAreaView>;
  }

  if (homeSection === "SHOP") {
    return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.homeContainer}>
      <View style={styles.header}><View><Text style={styles.logo}>SwiftDrop Shop</Text><Text style={styles.subtitle}>Marketplace with seller-anchored product pages.</Text></View><Pressable onPress={() => setHomeSection("HOME")}><Text style={styles.link}>Home</Text></Pressable></View>
      {signedIn && <View style={styles.card}>
        <View style={styles.rowBetween}><Text style={styles.homeHeading}>My seller sales</Text><Pressable onPress={() => void loadMarketplaceSales()}><Text style={styles.link}>Refresh</Text></Pressable></View>
        {marketplaceSales.length === 0 ? <Text style={styles.muted}>No marketplace sales yet.</Text> : marketplaceSales.map((sale:any) => <View key={sale.id} style={styles.notification}>
          <Text style={styles.notificationTitle}>{sale.title} · ×{sale.quantity}</Text>
          <Text>₦{(Number(sale.total_minor) / 100).toLocaleString()} · {String(sale.status).replaceAll("_"," ")}</Text>
          <Text style={styles.muted}>{sale.fulfillment_status?.replaceAll("_"," ")}{sale.delivery_status ? " · Delivery " + sale.delivery_status.replaceAll("_"," ") : ""}</Text>
          {sale.tracking_code && <Text style={styles.code}>Tracking: {sale.tracking_code}</Text>}
          {sale.fulfillment_status === "PREPARING" && sale.status === "PROCESSING" && (
            <View style={styles.row}>
              <Pressable style={styles.primary} onPress={() => void markMarketplaceSaleReady(sale)}>
                <Text style={styles.primaryText}>Mark ready for courier</Text>
              </Pressable>
            </View>
          )}
        </View>)}
      </View>}
      {signedIn && <View style={styles.card}>
        <View style={styles.rowBetween}><Text style={styles.homeHeading}>My listings</Text><Pressable onPress={() => void loadMarketplaceMyListings()}><Text style={styles.link}>Refresh</Text></Pressable></View>
        <Text style={styles.muted}>Manage stock and whether your everyday goods are visible to new buyers.</Text>
        {marketplaceMyListings.length === 0 ? <Text style={styles.muted}>No listings yet. Use “Sell an item” to publish your first product.</Text> : marketplaceMyListings.map((listing:any) =>
          <View key={listing.id} style={styles.notification}>
            <Text style={styles.notificationTitle}>{listing.title}</Text>
            <Text>₦{(Number(listing.price_minor) / 100).toLocaleString()} · Stock {listing.stock_quantity} · {listing.order_count ?? 0} orders</Text>
            <Text style={styles.muted}>{listing.is_active ? "Visible in SwiftDrop Shop" : "Hidden from new buyers"} · {String(listing.delivery_mode).replaceAll("_"," ")}</Text>
            <View style={styles.row}>
              <Pressable style={styles.secondary} onPress={() => void updateMarketplaceListingState(listing, { stockQuantity: Math.max(0, Number(listing.stock_quantity) - 1) })}><Text style={styles.secondaryText}>− Stock</Text></Pressable>
              <Pressable style={styles.secondary} onPress={() => void updateMarketplaceListingState(listing, { stockQuantity: Number(listing.stock_quantity) + 1 })}><Text style={styles.secondaryText}>+ Stock</Text></Pressable>
              <Pressable style={styles.secondary} onPress={() => void updateMarketplaceListingState(listing, { isActive: !listing.is_active })}><Text style={styles.secondaryText}>{listing.is_active ? "Hide" : "Publish"}</Text></Pressable>
            </View>
          </View>
        )}
      </View>}

      <TextInput style={styles.input} placeholder="Search products, categories or sellers" value={marketplaceSearch} onChangeText={setMarketplaceSearch} onSubmitEditing={() => void loadMarketplace(marketplaceSearch)} />
      <Pressable style={styles.primary} onPress={() => void loadMarketplace(marketplaceSearch)}><Text style={styles.primaryText}>{marketplaceLoading ? "Loading…" : "Search SwiftDrop Shop"}</Text></Pressable>
      <Pressable style={styles.secondary} onPress={() => setShowSellerForm(v => !v)}><Text style={styles.secondaryText}>{showSellerForm ? "Close selling form" : "Sell an item"}</Text></Pressable>
      <View style={styles.productDetail}>
        <View style={styles.rowBetween}><Text style={styles.homeHeading}>My marketplace orders</Text><Pressable onPress={() => void loadMarketplaceOrders()}><Text style={styles.link}>Refresh</Text></Pressable></View>
        {marketplaceOrders.length === 0 ? <Text style={styles.muted}>No marketplace orders yet.</Text> : marketplaceOrders.slice(0, 5).map(order =>
          <View key={order.id} style={styles.sellerCard}>
            <Text style={styles.homeHeading}>{order.title}</Text>
            <Text style={styles.muted}>Status: {String(order.status).replaceAll("_"," ")} · Payment: {String(order.payment_status ?? "NOT_STARTED").replaceAll("_"," ")}</Text>
            <Text>₦{(Number(order.total_minor) / 100).toLocaleString()} · Qty {order.quantity}</Text>
            {order.requested_delivery_at ? <Text style={styles.muted}>Requested delivery: {new Date(order.requested_delivery_at).toLocaleString()}</Text> : null}
            <Text style={styles.muted}>Seller: {order.seller_name}</Text>
            {order.delivery_id ? <View style={styles.card}>
              <Text style={styles.done}>✓ Connected to delivery · {order.fulfillment_status}</Text>
              {order.tracking_code ? <Text style={styles.code}>Tracking: {order.tracking_code}</Text> : null}
              {order.delivery_status ? <Text style={styles.muted}>Delivery status: {String(order.delivery_status).replaceAll("_"," ")}</Text> : null}
              <Pressable style={styles.secondary} onPress={async () => {
                if (!order.tracking_code || !order.receiver_phone) { Alert.alert("Tracking", "Receiver tracking details are not available yet."); return; }
                try {
                  const tracked = await api.track(order.tracking_code, order.receiver_phone);
                  setDelivery(tracked); setTrackingCode(order.tracking_code); setTrackingPhone(order.receiver_phone); setHomeSection("TRACK");
                } catch (error) { Alert.alert("Tracking", error instanceof Error ? error.message : "Unable to load delivery tracking"); }
              }}><Text style={styles.secondaryText}>Track this marketplace delivery</Text></Pressable>
            </View> : order.status === "PAID" && order.fulfillment_status === "NOT_STARTED" ? <View style={styles.card}>
              <Text style={styles.photoTitle}>Complete delivery details</Text>
              <Text style={styles.muted}>Your payment is authorized. Add the receiver and drop-off details to create the real SwiftDrop delivery and enable tracking.</Text>
              <TextInput style={styles.input} placeholder="Receiver full name" value={marketplaceReceiverName} onChangeText={setMarketplaceReceiverName} />
              <TextInput style={styles.input} placeholder="Receiver phone" keyboardType="phone-pad" value={marketplaceReceiverPhone} onChangeText={setMarketplaceReceiverPhone} />
              <TextInput style={styles.input} placeholder="4-digit receiver PIN" keyboardType="number-pad" maxLength={4} secureTextEntry value={marketplaceReceiverPin} onChangeText={setMarketplaceReceiverPin} />
              <TextInput style={styles.input} placeholder="Drop-off address" value={marketplaceDropoffAddress} onChangeText={setMarketplaceDropoffAddress} />
              <View style={styles.row}>
                <TextInput style={[styles.input, styles.half]} placeholder="Latitude" keyboardType="decimal-pad" value={marketplaceDropoffLat} onChangeText={setMarketplaceDropoffLat} />
                <TextInput style={[styles.input, styles.half]} placeholder="Longitude" keyboardType="decimal-pad" value={marketplaceDropoffLng} onChangeText={setMarketplaceDropoffLng} />
              </View>
              <Pressable style={styles.primary} onPress={() => void fulfillExistingMarketplaceOrder(order.id)}><Text style={styles.primaryText}>Start SwiftDrop delivery</Text></Pressable>
            </View> : order.status === "PENDING_PAYMENT" ? <View style={styles.card}>
              <Text style={styles.photoTitle}>Payment not completed</Text>
              <Text style={styles.muted}>This order is still awaiting payment. You can cancel it and return the reserved stock to the listing.</Text>
              <Pressable style={styles.dangerButton} onPress={() => void (async () => {
                try {
                  await api.cancelMarketplaceOrder(order.id);
                  await loadMarketplaceOrders();
                  Alert.alert("Order cancelled", "The unpaid marketplace order was cancelled and its stock was restored.");
                } catch (error) {
                  Alert.alert("Cancellation failed", error instanceof Error ? error.message : "Unable to cancel marketplace order");
                }
              })()}><Text style={styles.primaryText}>Cancel unpaid order</Text></Pressable>
            </View> : null}
          </View>
        )}
      </View>

      {showSellerForm && <View style={styles.productDetail}>
        <Text style={styles.homeHeading}>Sell your item</Text>
        <Text style={styles.muted}>Ordinary everyday goods are welcome. Categories help discovery but do not restrict what you can list. Regulated or prohibited goods remain subject to SwiftDrop rules.</Text>
        <TextInput style={styles.input} placeholder="Product title" value={sellerTitle} onChangeText={setSellerTitle} />
        <TextInput style={styles.input} placeholder="Category (free-form)" value={sellerCategory} onChangeText={setSellerCategory} />
        <TextInput style={styles.input} placeholder="Description" value={sellerDescription} onChangeText={setSellerDescription} multiline />
        <TextInput style={styles.input} placeholder="What is it normally used for?" value={sellerUseDescription} onChangeText={setSellerUseDescription} multiline />
        <TextInput style={styles.input} placeholder="Usage instructions (optional)" value={sellerUsageInstructions} onChangeText={setSellerUsageInstructions} multiline />
        <View style={styles.mediaPanel}>
          <Text style={styles.photoTitle}>Product photos / illustrations ({sellerMedia.length}/8)</Text>
          <Text style={styles.muted}>Add clear photos. For goods that need explanation, include a photo or illustration showing how the item is used.</Text>
          <Pressable style={styles.secondary} onPress={() => void pickSellerMedia()}><Text style={styles.secondaryText}>Add product photos</Text></Pressable>
          {sellerMedia.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.mediaRow}>
            {sellerMedia.map((uri, index) => <View key={index} style={styles.mediaThumbWrap}>
              <Image source={{ uri }} style={styles.mediaThumb} />
              <Pressable style={styles.mediaRemove} onPress={() => setSellerMedia(current => current.filter((_, i) => i !== index))}><Text style={styles.mediaRemoveText}>×</Text></Pressable>
            </View>)}
          </ScrollView>}
        </View>
        <TextInput style={styles.input} placeholder="Condition: NEW / LIKE_NEW / GOOD / FAIR / USED / FOR_PARTS" value={sellerCondition} onChangeText={v => setSellerCondition((v.trim().toUpperCase() || "NEW") as typeof sellerCondition)} />
        <TextInput style={styles.input} placeholder="Price (₦)" keyboardType="decimal-pad" value={sellerPrice} onChangeText={setSellerPrice} />
        <TextInput style={styles.input} placeholder="Delivery fee (₦)" keyboardType="decimal-pad" value={sellerDeliveryFee} onChangeText={setSellerDeliveryFee} />
        <TextInput style={styles.input} placeholder="Stock quantity" keyboardType="number-pad" value={sellerStock} onChangeText={setSellerStock} />
        <TextInput style={styles.input} placeholder="Delivery mode: SAME_STATE / INTER_STATE / EXPRESS / PICKUP" value={sellerDeliveryMode} onChangeText={v => setSellerDeliveryMode((v.trim().toUpperCase() || "SAME_STATE") as typeof sellerDeliveryMode)} />
        {sellerDeliveryMode !== "PICKUP" && <>
          <TextInput style={styles.input} placeholder="Seller pickup address" value={sellerPickupAddress} onChangeText={setSellerPickupAddress} />
          <View style={styles.row}><TextInput style={styles.half} placeholder="Pickup latitude" keyboardType="decimal-pad" value={sellerPickupLat} onChangeText={setSellerPickupLat} /><TextInput style={styles.half} placeholder="Pickup longitude" keyboardType="decimal-pad" value={sellerPickupLng} onChangeText={setSellerPickupLng} /></View>
          <View style={styles.row}><TextInput style={styles.half} placeholder="Weight (kg)" keyboardType="decimal-pad" value={sellerWeightKg} onChangeText={setSellerWeightKg} /><TextInput style={styles.half} placeholder="Length (cm)" keyboardType="decimal-pad" value={sellerLengthCm} onChangeText={setSellerLengthCm} /></View>
          <View style={styles.row}><TextInput style={styles.half} placeholder="Width (cm)" keyboardType="decimal-pad" value={sellerWidthCm} onChangeText={setSellerWidthCm} /><TextInput style={styles.half} placeholder="Height (cm)" keyboardType="decimal-pad" value={sellerHeightCm} onChangeText={setSellerHeightCm} /></View>
          <Pressable style={[styles.choice, sellerPerishable && styles.choiceActive]} onPress={() => setSellerPerishable(v => !v)}><Text style={styles.photoTitle}>{sellerPerishable ? "✓ Perishable / food" : "Mark as perishable / food"}</Text></Pressable>
        </>}
        <Pressable style={styles.primary} onPress={() => void publishMarketplaceListing()}><Text style={styles.primaryText}>{sellerPublishing ? "Publishing…" : "Publish item for sale"}</Text></Pressable>
      </View>}
      {selectedListing ? <View style={styles.productDetail}>
        {Array.isArray(selectedListing.media) && selectedListing.media.length > 0 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.mediaRow}>
          {selectedListing.media.map((media: any, index: number) => <Image key={media.id ?? index} source={{ uri: String(media.url).startsWith("http") ? String(media.url) : API_URL + String(media.url) }} style={styles.productDetailImage} resizeMode="cover" />)}
        </ScrollView> : <Text style={styles.productHero}>🛍️</Text>}
        <Text style={styles.heroTitle}>{selectedListing.title}</Text>
        <Text style={styles.muted}>{selectedListing.category} · {String(selectedListing.delivery_mode).replaceAll("_"," ")}</Text>
        <Text style={styles.productPrice}>₦{(Number(selectedListing.final_price_minor)/100).toLocaleString()}</Text>
        <Text style={styles.priceNote}>Final price includes delivery.</Text>
        <Text style={styles.productDescription}>{selectedListing.description}</Text>
        <Text style={styles.muted}>Condition: {selectedListing.condition} · Use: {selectedListing.use_description}</Text>
        {selectedListing.usage_instructions ? <Text style={styles.muted}>How to use: {selectedListing.usage_instructions}</Text> : null}
        <TextInput style={styles.input} placeholder="Preferred delivery date/time (optional), e.g. 2026-10-05T14:00:00+01:00" value={marketplaceDeliveryAt} onChangeText={setMarketplaceDeliveryAt} />
        {selectedListing.delivery_mode !== "PICKUP" && <View style={styles.sellerCard}>
          <Text style={styles.eyebrow}>DELIVERY DETAILS</Text>
          <Text style={styles.muted}>These details create the real SwiftDrop delivery after Paystack confirms payment.</Text>
          <TextInput style={styles.input} placeholder="Receiver full name" value={marketplaceReceiverName} onChangeText={setMarketplaceReceiverName} />
          <TextInput style={styles.input} placeholder="Receiver phone" keyboardType="phone-pad" value={marketplaceReceiverPhone} onChangeText={setMarketplaceReceiverPhone} />
          <TextInput style={styles.input} placeholder="4-digit receiver PIN" keyboardType="number-pad" maxLength={4} secureTextEntry value={marketplaceReceiverPin} onChangeText={setMarketplaceReceiverPin} />
          <TextInput style={styles.input} placeholder="Drop-off address" value={marketplaceDropoffAddress} onChangeText={setMarketplaceDropoffAddress} />
          <View style={styles.row}><TextInput style={styles.half} placeholder="Drop-off latitude" keyboardType="decimal-pad" value={marketplaceDropoffLat} onChangeText={setMarketplaceDropoffLat} /><TextInput style={styles.half} placeholder="Drop-off longitude" keyboardType="decimal-pad" value={marketplaceDropoffLng} onChangeText={setMarketplaceDropoffLng} /></View>
        </View>}
        {selectedListing.delivery_mode !== "PICKUP" && <View style={styles.sellerCard}>
          <Text style={styles.eyebrow}>DELIVERY DETAILS</Text>
          <Text style={styles.muted}>These details are used to create the real SwiftDrop delivery after Paystack confirms payment.</Text>
          <TextInput style={styles.input} placeholder="Receiver full name" value={marketplaceReceiverName} onChangeText={setMarketplaceReceiverName} />
          <TextInput style={styles.input} placeholder="Receiver phone" keyboardType="phone-pad" value={marketplaceReceiverPhone} onChangeText={setMarketplaceReceiverPhone} />
          <TextInput style={styles.input} placeholder="4-digit receiver PIN" keyboardType="number-pad" maxLength={4} secureTextEntry value={marketplaceReceiverPin} onChangeText={setMarketplaceReceiverPin} />
          <TextInput style={styles.input} placeholder="Drop-off address" value={marketplaceDropoffAddress} onChangeText={setMarketplaceDropoffAddress} />
          <View style={styles.row}><TextInput style={styles.half} placeholder="Drop-off latitude" keyboardType="decimal-pad" value={marketplaceDropoffLat} onChangeText={setMarketplaceDropoffLat} /><TextInput style={styles.half} placeholder="Drop-off longitude" keyboardType="decimal-pad" value={marketplaceDropoffLng} onChangeText={setMarketplaceDropoffLng} /></View>
        </View>}
        <View style={styles.sellerCard}><Text style={styles.eyebrow}>SELLER TRUST</Text><Text style={styles.homeHeading}>{selectedListing.seller_name}</Text><Text>{selectedListing.seller_bio || "SwiftDrop marketplace seller."}</Text><Text style={styles.muted}>{selectedListing.seller_location || "Nigeria"} · Member since {selectedSellerTrust?.memberSince ? new Date(selectedSellerTrust.memberSince).toLocaleDateString() : "recently"}</Text>
          {selectedSellerTrust?.trust && <View style={styles.rowBetween}><Text>Successful sales: {selectedSellerTrust.trust.successfulSales}</Text><Text>Delivery rate: {selectedSellerTrust.trust.deliveryRatePercent}%</Text></View>}
          {selectedSellerTrust?.trust && <View style={styles.rowBetween}><Text>Rating: {selectedSellerTrust.trust.averageRating == null ? "No ratings yet" : selectedSellerTrust.trust.averageRating + "/5"} ({selectedSellerTrust.trust.reviewCount})</Text><Text>Disputes: {selectedSellerTrust.trust.disputedOrders}</Text></View>}
        </View>
        <Pressable style={styles.primary} onPress={() => void checkoutMarketplaceListing()}><Text style={styles.primaryText}>Proceed to checkout</Text></Pressable>
        <Text style={styles.homeHeading}>More from this seller</Text>
        {recommendedListings.map(item => <Pressable key={item.id} style={styles.recommendCard} onPress={() => void openMarketplaceListing(item.id)}><Text style={styles.productName}>{item.title}</Text><Text>₦{(Number(item.final_price_minor)/100).toLocaleString()} · delivery included</Text></Pressable>)}
        <Pressable style={styles.secondary} onPress={() => { setSelectedListing(null); setSelectedSellerTrust(null); }}><Text style={styles.secondaryText}>Back to Shop</Text></Pressable>
      </View> : <View style={styles.shopGrid}>
        {marketplaceListings.length === 0 && <Text style={styles.muted}>No published products yet. Be the first seller to publish an everyday item.</Text>}
        {marketplaceListings.map(item => <Pressable key={item.id} style={styles.listingCard} onPress={() => void openMarketplaceListing(item.id)}>
          {Array.isArray(item.media) && item.media.length > 0 ? <Image source={{ uri: String(item.media[0].url).startsWith("http") ? String(item.media[0].url) : API_URL + String(item.media[0].url) }} style={styles.listingImage} resizeMode="cover" /> : <Text style={styles.productEmoji}>🛍️</Text>}<Text style={styles.productName}>{item.title}</Text><Text style={styles.muted}>{item.category}</Text><Text style={styles.productPrice}>₦{(Number(item.final_price_minor)/100).toLocaleString()}</Text><Text style={styles.priceNote}>Delivery included · {String(item.delivery_mode).replaceAll("_"," ")}</Text><Text style={styles.muted}>Seller: {item.seller_name}</Text>
        </Pressable>)}
      </View>}
      <Pressable style={styles.secondary} onPress={() => setHomeSection("HOME")}><Text style={styles.secondaryText}>Back to home</Text></Pressable>
    </ScrollView></SafeAreaView>;
  }

  if (homeSection === "ERRAND" && selectedErrand && errandDetail) {
    const e = selectedErrand;
    const pending = (errandDetail.items ?? []).filter((i: any) => i.status === "REPLACEMENT_PENDING");
    return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.homeContainer}>
      <View style={styles.header}><View><Text style={styles.logo}>Errand status</Text><Text style={styles.subtitle}>{String(e.errand_type ?? "").replaceAll("_"," ")}</Text></View><Pressable onPress={() => { setSelectedErrand(null); setErrandDetail(null); }}><Text style={styles.link}>All errands</Text></Pressable></View>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>CURRENT STAGE</Text><Text style={styles.heroTitle}>{String(e.status ?? "").replaceAll("_"," ")}</Text>
        <Text style={styles.muted}>{e.item_description}</Text>
        <Text>Spending ceiling: ₦{(Number(e.purchase_budget_minor ?? 0)/100).toLocaleString()}</Text>
        {e.agent && <Text>Errand agent: {e.agent.name}{e.agent.phone ? " · " + e.agent.phone : ""}</Text>}
        {e.delivery && <><Text style={styles.done}>Delivery: {String(e.delivery.status).replaceAll("_"," ")}</Text><Text style={styles.code}>Tracking: {e.delivery.trackingCode}</Text><Pressable style={styles.secondary} onPress={() => { setTrackingCode(e.delivery.trackingCode); setTrackingPhone(e.receiver_phone ?? ""); setHomeSection("TRACK"); }}><Text style={styles.secondaryText}>Open live delivery tracking</Text></Pressable></>}
      </View>
      {pending.length > 0 && <View style={styles.card}><Text style={styles.homeHeading}>Your approval is required</Text>{pending.map((item: any) => (item.replacements ?? []).filter((r: any) => r.status === "PENDING").map((r: any) => <View key={r.id} style={styles.locationCard}>
        <Text style={styles.photoTitle}>Replacement proposed</Text><Text>{r.description} × {r.quantity}</Text><Text>Proposed price: ₦{(Number(r.priceMinor)/100).toLocaleString()}</Text>{r.shopperNote && <Text style={styles.muted}>{r.shopperNote}</Text>}
        <View style={styles.row}><Pressable style={styles.primary} onPress={() => void api.decideErrandReplacement(e.id,r.id,"APPROVE").then(() => refreshErrand(e.id))}><Text style={styles.primaryText}>Approve</Text></Pressable><Pressable style={styles.dangerButton} onPress={() => void api.decideErrandReplacement(e.id,r.id,"REFUND").then(() => refreshErrand(e.id))}><Text style={styles.primaryText}>Refund</Text></Pressable></View>
      </View>))}</View>}
      <View style={styles.card}><Text style={styles.homeHeading}>Execution timeline</Text>{(errandDetail.events ?? []).map((event: any) => <View key={event.id} style={styles.notification}><Text style={styles.notificationTitle}>{String(event.eventType ?? "").replaceAll("_"," ")}</Text><Text style={styles.muted}>{new Date(event.createdAt).toLocaleString()}</Text></View>)}</View>
      {Array.isArray(errandDetail.stops) && errandDetail.stops.length > 0 && <View style={styles.card}><Text style={styles.homeHeading}>Errand route</Text>{errandDetail.stops.map((stop:any)=><View key={stop.id} style={styles.notification}><Text style={styles.notificationTitle}>Stop {stop.order}: {stop.label}</Text><Text>{stop.address}</Text><Text style={styles.muted}>{String(stop.stopType).replaceAll("_"," ")} · {String(stop.status).replaceAll("_"," ")}</Text>{stop.instructions ? <Text style={styles.muted}>{stop.instructions}</Text> : null}</View>)}</View>}
      {errandDetail.payment && <View style={styles.card}><Text style={styles.homeHeading}>Payment</Text><Text>Status: {String(errandDetail.payment.status ?? "").replaceAll("_"," ")}</Text><Text>Authorization: {String(errandDetail.payment.payment_status ?? "").replaceAll("_"," ")}</Text>{errandDetail.payment.refund_status && <Text>Refund: {String(errandDetail.payment.refund_status).replaceAll("_"," ")}</Text>}</View>}
      <Pressable style={styles.secondary} disabled={errandDetailBusy} onPress={() => void refreshErrand(e.id)}><Text style={styles.secondaryText}>{errandDetailBusy ? "Refreshing…" : "Refresh status"}</Text></Pressable>
    </ScrollView></SafeAreaView>;
  }

  if (homeSection === "ERRAND") {
    const d = errandDraft;
    return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.homeContainer}>
      <View style={styles.header}><View><Text style={styles.logo}>Hire an Errand</Text><Text style={styles.subtitle}>General errands, Purchase & Deliver, and Shop for Me — with spending controls.</Text></View><Pressable onPress={() => setHomeSection("HOME")}><Text style={styles.link}>Home</Text></Pressable></View>
      {myErrands.length > 0 && <View style={styles.card}>
        <Text style={styles.homeHeading}>Your errand requests</Text>
        {myErrands.slice(0,5).map(item => <Pressable key={item.id} style={styles.locationCard} onPress={() => void refreshErrand(item.id)}>
          <View style={styles.rowBetween}><Text style={styles.photoTitle}>{String(item.errand_type ?? "").replaceAll("_"," ")}</Text><Text style={styles.status}>{String(item.status ?? "").replaceAll("_"," ")}</Text></View>
          <Text style={styles.muted}>{item.item_description}</Text>
          <Text>Spending ceiling: ₦{(Number(item.purchase_budget_minor ?? 0)/100).toLocaleString()}</Text>
          {item.agent_id && <Text style={styles.muted}>Agent assigned</Text>}
          {item.delivery_id && <Text style={styles.done}>Delivery created · tracking available</Text>}
        </Pressable>)}
      </View>}
      <View style={styles.card}>
        <Text style={styles.homeHeading}>What do you need?</Text>
        <View style={styles.row}>
          {([["GENERAL_ERRAND","General errand"],["PURCHASE_AND_DELIVER","Purchase & Deliver"],["SHOP_FOR_ME","Shop for Me"]] as const).map(([value,label]) =>
            <Pressable key={value} style={[styles.choice, d.errandType === value && styles.choiceActive]} onPress={() => updateErrand({ errandType: value })}><Text style={styles.photoTitle}>{label}</Text></Pressable>
          )}
        </View>
        <TextInput style={[styles.input, styles.multiline]} placeholder="Describe the errand" value={d.description} onChangeText={v => updateErrand({ description: v })} multiline maxLength={2000} />
        <TextInput style={styles.input} placeholder="Exact item or shopping target (optional for general errands)" value={d.itemDescription} onChangeText={v => updateErrand({ itemDescription: v })} />
        <TextInput style={styles.input} placeholder="Spending ceiling (₦)" keyboardType="decimal-pad" value={d.spendingCeiling} onChangeText={v => updateErrand({ spendingCeiling: v })} />
        {d.errandType !== "GENERAL_ERRAND" && <><TextInput style={styles.input} placeholder="Original / expected item price (₦, optional)" keyboardType="decimal-pad" value={d.requestedPrice} onChangeText={v => updateErrand({ requestedPrice: v })} /><TextInput style={styles.input} placeholder="Maximum price difference allowed (₦)" keyboardType="decimal-pad" value={d.maxPriceDelta} onChangeText={v => updateErrand({ maxPriceDelta: v })} /><Text style={styles.hint}>No silent overcharging or unauthorized substitutions.</Text>
          <View style={styles.row}>{([["EXACT_ONLY","Exact only"],["BEST_MATCH","Best match"],["APPROVED_ALTERNATIVES","Approved alternatives"],["REFUND_IF_UNAVAILABLE","Refund if unavailable"]] as const).map(([value,label]) => <Pressable key={value} style={[styles.choice, d.replacementPolicy === value && styles.choiceActive]} onPress={() => updateErrand({ replacementPolicy: value })}><Text style={styles.muted}>{label}</Text></Pressable>)}</View></>}
        <TextInput style={styles.input} placeholder="Preferred shop / merchant (optional)" value={d.merchantName} onChangeText={v => updateErrand({ merchantName: v })} />
        <TextInput style={styles.input} placeholder="Shop address (optional)" value={d.merchantAddress} onChangeText={v => updateErrand({ merchantAddress: v })} />
        <TextInput style={[styles.input, styles.multiline]} placeholder="Errand instructions" value={d.instructions} onChangeText={v => updateErrand({ instructions: v })} multiline maxLength={2000} />
        <TextInput style={styles.input} placeholder="Requested completion time (ISO 8601)" value={d.requestedCompletionAt} onChangeText={v => updateErrand({ requestedCompletionAt: v })} />
        <View style={styles.card}>
          <View style={styles.rowBetween}><View><Text style={styles.homeHeading}>Optional multi-stop errand</Text><Text style={styles.muted}>Add up to 10 ordered places to visit before the final destination.</Text></View><Pressable style={styles.secondary} onPress={() => { if (errandStops.length >= 10) { Alert.alert("Stops", "You can add up to 10 stops."); return; } setErrandStops(prev => [...prev, { stopType: "TASK", label: "", address: "", latitude: "", longitude: "", instructions: "" }]); }}><Text style={styles.secondaryText}>+ Add stop</Text></Pressable></View>
          {errandStops.map((stop,index) => <View key={index} style={styles.notification}>
            <View style={styles.rowBetween}><Text style={styles.photoTitle}>Stop {index + 1}</Text><Pressable onPress={() => setErrandStops(prev => prev.filter((_,i) => i !== index))}><Text style={styles.link}>Remove</Text></Pressable></View>
            <View style={styles.row}>{(["TASK","PICKUP","PURCHASE","INSPECT","DROP_OFF"] as const).map(type => <Pressable key={type} style={[styles.choice, stop.stopType === type && styles.choiceActive]} onPress={() => setErrandStops(prev => prev.map((item,i) => i===index ? {...item,stopType:type} : item))}><Text style={styles.muted}>{type.replaceAll("_"," ")}</Text></Pressable>)}</View>
            <TextInput style={styles.input} placeholder="Stop label" value={stop.label} onChangeText={v => setErrandStops(prev => prev.map((item,i)=>i===index?{...item,label:v}:item))} />
            <TextInput style={styles.input} placeholder="Stop address" value={stop.address} onChangeText={v => setErrandStops(prev => prev.map((item,i)=>i===index?{...item,address:v}:item))} />
            <View style={styles.row}><TextInput style={styles.half} placeholder="Latitude" keyboardType="decimal-pad" value={stop.latitude} onChangeText={v => setErrandStops(prev => prev.map((item,i)=>i===index?{...item,latitude:v}:item))} /><TextInput style={styles.half} placeholder="Longitude" keyboardType="decimal-pad" value={stop.longitude} onChangeText={v => setErrandStops(prev => prev.map((item,i)=>i===index?{...item,longitude:v}:item))} /></View>
            <TextInput style={styles.input} placeholder="Stop instructions (optional)" value={stop.instructions} onChangeText={v => setErrandStops(prev => prev.map((item,i)=>i===index?{...item,instructions:v}:item))} />
          </View>)}
        </View>
      </View>
      <View style={styles.card}>
        <Text style={styles.homeHeading}>Receiver & destination</Text>
        <TextInput style={styles.input} placeholder="Receiver full name" value={d.receiverName} onChangeText={v => updateErrand({ receiverName: v })} />
        <TextInput style={styles.input} placeholder="Receiver phone" keyboardType="phone-pad" value={d.receiverPhone} onChangeText={v => updateErrand({ receiverPhone: v })} />
        <TextInput style={styles.input} placeholder="4-6 digit receiver PIN" keyboardType="number-pad" maxLength={4} secureTextEntry value={d.receiverPin} onChangeText={v => updateErrand({ receiverPin: v })} />
        <TextInput style={styles.input} placeholder="Destination address" value={d.destinationAddress} onChangeText={v => updateErrand({ destinationAddress: v })} />
        <View style={styles.row}><TextInput style={styles.half} placeholder="Latitude" keyboardType="decimal-pad" value={d.destinationLat} onChangeText={v => updateErrand({ destinationLat: v })} /><TextInput style={styles.half} placeholder="Longitude" keyboardType="decimal-pad" value={d.destinationLng} onChangeText={v => updateErrand({ destinationLng: v })} /></View>
        <Pressable style={styles.primary} disabled={errandBusy} onPress={() => void createErrand()}><Text style={styles.primaryText}>{errandBusy ? "Creating errand…" : "Place errand request"}</Text></Pressable>
      </View>
      <Text style={styles.hint}>After payment authorization, an approved errand agent can accept the request. Shopping remains constrained by your spending ceiling and replacement policy. Delivery becomes a tracked delivery with the existing proof-of-delivery and receiver-PIN controls.</Text>
      <Pressable style={styles.secondary} onPress={() => setHomeSection("HOME")}><Text style={styles.secondaryText}>Back to home</Text></Pressable>
    </ScrollView></SafeAreaView>;
  }


  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.container}>
    <View style={styles.header}><View><Text style={styles.logo}>SwiftDrop</Text><Text style={styles.subtitle}>Place your order. Track every movement.</Text></View><Pressable onPress={() => setHomeSection("HOME")}><Text style={styles.link}>Home</Text></Pressable></View><View style={styles.header}><View></View><View style={styles.headerActions}><Pressable onPress={() => { setShowNotifications(v => !v); void loadNotifications(); }}><Text style={styles.link}>Alerts {notifications.filter(n => !n.read_at).length ? "•" : ""}</Text></Pressable><Pressable onPress={() => { setShowSupport(v => !v); void loadSupportTickets(); }}><Text style={styles.link}>Support</Text></Pressable><Pressable onPress={() => void signOut()}><Text style={styles.link}>Sign out</Text></Pressable></View></View>
    {showNotifications && <View style={styles.card}><View style={styles.header}><Text style={styles.heading}>Notifications</Text><Pressable onPress={() => void loadNotifications()}><Text>Refresh</Text></Pressable></View>{notifications.length === 0 ? <Text style={styles.muted}>No notifications.</Text> : notifications.map(item => <Pressable key={item.id} style={styles.notification} onPress={() => void markNotificationRead(item.id)}><Text style={styles.notificationTitle}>{item.title}</Text><Text>{item.body}</Text><Text style={styles.muted}>{new Date(item.created_at).toLocaleString()} · {item.read_at ? "Read" : "Tap to mark read"}</Text></Pressable>)}</View>}
    <View style={styles.card}>
      <Text style={styles.eyebrow}>SWIFT AI</Text>
      <Text style={styles.heading}>Ask Swift AI</Text>
      <Text style={styles.muted}>Basic AI answers delivery and app questions. Premium AI can also take authorized actions for you.</Text>
      <TextInput style={styles.input} placeholder="Where is my parcel? What does my delivery status mean?" value={swiftAiQuestion} onChangeText={setSwiftAiQuestion} maxLength={2000} />
      <Pressable style={styles.secondary} disabled={swiftAiBusy} onPress={() => void askSwiftAi()}><Text style={styles.secondaryText}>{swiftAiBusy ? "Swift AI is working…" : "Ask Swift AI"}</Text></Pressable>
      {!!swiftAiAnswer && <View style={styles.notification}><Text style={styles.notificationTitle}>Swift AI</Text><Text>{swiftAiAnswer}</Text></View>}
    </View>
    {showSupport && <View style={styles.card}>
      <View style={styles.header}><View><Text style={styles.eyebrow}>HELP CENTRE</Text><Text style={styles.heroTitle}>How can we help?</Text></View><Pressable onPress={() => setShowSupport(false)}><Text style={styles.link}>Close</Text></Pressable></View>
      <Text style={styles.muted}>Get help with an order, payment, delivery, or the SwiftDrop app itself.</Text>
      <View style={styles.row}>
        <Pressable style={[styles.supportChoice, supportCategory === "ORDER" && styles.supportChoiceActive]} onPress={() => setSupportCategory("ORDER")}><Text style={styles.supportChoiceText}>Order help</Text></Pressable>
        <Pressable style={[styles.supportChoice, supportCategory === "APP" && styles.supportChoiceActive]} onPress={() => setSupportCategory("APP")}><Text style={styles.supportChoiceText}>App help</Text></Pressable>
      </View>
      {supportCategory === "ORDER" && delivery && <Text style={styles.hint}>This request will be linked to tracking code {delivery.trackingCode}.</Text>}
      <TextInput style={styles.input} placeholder={supportCategory === "ORDER" ? "Order issue (e.g. parcel not received)" : "What do you need help with?"} value={supportSubject} onChangeText={setSupportSubject} maxLength={120} />
      <TextInput style={[styles.input, styles.multiline]} placeholder="Tell us what happened and what help you need." value={supportMessage} onChangeText={setSupportMessage} maxLength={2000} multiline />
      <Pressable style={styles.primary} onPress={() => void submitSupportTicket()}><Text style={styles.primaryText}>Send to SwiftDrop Support</Text></Pressable>
      <Text style={styles.heading}>Your support requests</Text>
      {supportTickets.length === 0 ? <Text style={styles.muted}>No support requests yet.</Text> : supportTickets.map(ticket => <View key={ticket.id} style={styles.notification}><Text style={styles.notificationTitle}>{ticket.subject}</Text><Text>{ticket.message}</Text><Text style={styles.muted}>{ticket.category} · {ticket.status.replaceAll("_"," ")}</Text>{Array.isArray(ticket.messages) && ticket.messages.length > 0 && <View style={{marginTop:8}}>{ticket.messages.map((m:any)=><View key={m.id} style={{marginTop:6}}><Text style={styles.muted}>{m.senderType === "AI" ? "SwiftDrop Support AI" : m.senderType === "ADMIN" ? "SwiftDrop Support" : "You"}</Text><Text>{m.message}</Text></View>)}</View>}</View>)}
    </View>}
    <Text style={styles.eyebrow}>SEND A PARCEL</Text><Text style={styles.heroTitle}>Where is your parcel going?</Text><Text style={styles.subtitle}>Book a trusted courier, pay securely and follow every movement.</Text>
    <Text style={styles.eyebrow}>DELIVERY ENDPOINTS</Text>
    <Text style={styles.hint}>You can use an approved SwiftDrop business drop-off point instead of a home address. The parcel will be checked in there and handed to the assigned courier.</Text>
    <Pressable style={styles.secondary} onPress={() => void loadNearbyDropOffs("pickup")}><Text style={styles.secondaryText}>Find nearby pickup drop-off points</Text></Pressable>
    {pickupDropOffLocations.map(item => <Pressable key={"pickup-point-" + item.id} style={styles.suggestion} onPress={() => chooseDropOffLocation(item, "pickup")}><Text style={styles.notificationTitle}>{item.name} · {Number(item.distanceKm).toFixed(1)} km</Text><Text>{item.address}</Text><Text style={styles.muted}>{item.business_name ?? "SwiftDrop partner"} · Capacity {item.capacity}</Text></Pressable>)}
    <TextInput style={styles.input} placeholder="Pickup address" value={pickup} onChangeText={value => { setPickup(value); setPickupDropOffId(""); void searchAddress(value, "pickup"); }} />
    {pickupResults.map((result, index) => <Pressable key={"pickup-" + index} style={styles.suggestion} onPress={() => chooseAddress(result, "pickup")}><Text>{result.formattedAddress}</Text></Pressable>)}
    <TextInput style={styles.input} placeholder="Drop-off address" value={dropoff} onChangeText={value => { setDropoff(value); setDropoffDropOffId(""); void searchAddress(value, "dropoff"); }} />
    {dropoffResults.map((result, index) => <Pressable key={"dropoff-" + index} style={styles.suggestion} onPress={() => chooseAddress(result, "dropoff")}><Text>{result.formattedAddress}</Text></Pressable>)}
    <Pressable style={styles.secondary} onPress={() => void loadNearbyDropOffs("dropoff")}><Text style={styles.secondaryText}>Find nearby destination drop-off points</Text></Pressable>
    {dropoffDropOffLocations.map(item => <Pressable key={"dropoff-point-" + item.id} style={styles.suggestion} onPress={() => chooseDropOffLocation(item, "dropoff")}><Text style={styles.notificationTitle}>{item.name} · {Number(item.distanceKm).toFixed(1)} km</Text><Text>{item.address}</Text><Text style={styles.muted}>{item.business_name ?? "SwiftDrop partner"} · Capacity {item.capacity}</Text></Pressable>)}
    <Text style={styles.hint}>Choose your current location for pickup, or enter coordinates from a map/address search.</Text>
    <Pressable style={styles.secondary} onPress={() => void useCurrentPickupLocation()}><Text style={styles.secondaryText}>Use my current location for pickup</Text></Pressable>
    <View style={styles.row}><TextInput style={styles.half} placeholder="Pickup latitude" value={pickupLat} onChangeText={value => { setPickupLat(value); setPickupDropOffId(""); }} keyboardType="decimal-pad" /><TextInput style={styles.half} placeholder="Pickup longitude" value={pickupLng} onChangeText={value => { setPickupLng(value); setPickupDropOffId(""); }} keyboardType="decimal-pad" /></View>
    <View style={styles.row}><TextInput style={styles.half} placeholder="Drop-off latitude" value={dropoffLat} onChangeText={value => { setDropoffLat(value); setDropoffDropOffId(""); }} keyboardType="decimal-pad" /><TextInput style={styles.half} placeholder="Drop-off longitude" value={dropoffLng} onChangeText={value => { setDropoffLng(value); setDropoffDropOffId(""); }} keyboardType="decimal-pad" /></View>
    <TextInput style={styles.input} placeholder="Pickup instructions (gate, floor, contact, parking)" value={pickupInstructions} onChangeText={setPickupInstructions} maxLength={1000} multiline />
    <TextInput style={styles.input} placeholder="Drop-off instructions (gate, floor, entrance, handoff)" value={dropoffInstructions} onChangeText={setDropoffInstructions} maxLength={1000} multiline />
    <Text style={styles.hint}>Clear instructions help the courier find the right entrance and complete the handoff without relying on the address alone.</Text>
    <TextInput style={styles.input} placeholder="Receiver name" value={receiver} onChangeText={setReceiver} />
    <TextInput style={styles.input} placeholder="Receiver phone" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
    <TextInput style={styles.input} placeholder="4-digit receiver PIN" keyboardType="number-pad" maxLength={4} secureTextEntry value={receiverPin} onChangeText={setReceiverPin} />
    <Text style={styles.hint}>Give this PIN to the receiver. The receiver must use it to confirm receipt before courier payout is released.</Text>
    <TextInput style={styles.input} placeholder="Actual goods value (₦)" keyboardType="decimal-pad" value={declaredValue} onChangeText={setDeclaredValue} />
    <Text style={styles.hint}>Required for pricing, vehicle/risk planning and claims. Declare the genuine value of the goods. A damage claim is limited to the verified actual loss and cannot be increased by an inflated declaration.</Text>
    <TextInput style={styles.input} placeholder="Parcel weight (kg)" keyboardType="decimal-pad" value={weightKg} onChangeText={setWeightKg} />
    <View style={styles.row}><TextInput style={[styles.input, styles.third]} placeholder="Length cm" keyboardType="decimal-pad" value={lengthCm} onChangeText={setLengthCm} /><TextInput style={[styles.input, styles.third]} placeholder="Width cm" keyboardType="decimal-pad" value={widthCm} onChangeText={setWidthCm} /><TextInput style={[styles.input, styles.third]} placeholder="Height cm" keyboardType="decimal-pad" value={heightCm} onChangeText={setHeightCm} /></View>
    <Pressable style={styles.secondary} onPress={() => setIsPerishable(v => !v)}><Text>{isPerishable ? "✓ Perishable item (surcharge applied)" : "Mark as perishable / food item"}</Text></Pressable>
    <TextInput style={styles.input} placeholder="Payment email" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
    <Pressable style={styles.secondary} onPress={() => void getQuote()}><Text style={styles.secondaryText}>Calculate delivery price</Text></Pressable>
    {quote && <View style={styles.card}>
      <Text style={styles.photoTitle}>Delivery price</Text>
      <Text>Distance: {(quote.distanceMeters / 1000).toFixed(1)} km</Text>
      <Text>Base fare: ₦{(quote.baseFareMinor / 100).toLocaleString()}</Text>
      <Text>Distance: ₦{(quote.distanceFareMinor / 100).toLocaleString()}</Text>
      <Text>Weight: ₦{(quote.weightFareMinor / 100).toLocaleString()}</Text>
      <Text>Size/handling: ₦{(quote.sizeFareMinor / 100).toLocaleString()}</Text>
      {quote.perishableSurchargeMinor > 0 && <Text>Perishable/food surcharge: ₦{(quote.perishableSurchargeMinor / 100).toLocaleString()}</Text>}
      <Text>Fuel reference: ₦{(quote.fuelReferenceMinor / 100).toLocaleString()} (2 litres)</Text><Pressable style={[styles.choice, includeProtection && styles.choiceActive]} onPress={() => setIncludeProtection(v => !v)} accessibilityRole="checkbox" accessibilityState={{ checked: includeProtection }}><Text style={styles.photoTitle}>{includeProtection ? "✓ " : ""}Refundable Protection Reserve · 10% of declared value</Text></Pressable><Text>Protection: ₦{(quote.protectionReserveMinor / 100).toLocaleString()}</Text><Text>Service fee: ₦{(quote.serviceFeeMinor / 100).toLocaleString()}</Text>
      <Text style={styles.code}>Total: ₦{(quote.totalMinor / 100).toLocaleString()}</Text>    </View>}
    <Text style={styles.heading}>Who pays for this order?</Text>
    <View style={styles.row}>
      <Pressable style={[styles.choice, paymentMode === "SENDER_ESCROW" && styles.choiceActive]} onPress={() => setPaymentMode("SENDER_ESCROW")}>
        <Text style={styles.photoTitle}>Sender pays</Text><Text style={styles.muted}>Payment is held until receiver PIN confirmation.</Text>
      </Pressable>
      <Pressable style={[styles.choice, paymentMode === "RECEIVER_ON_DELIVERY" && styles.choiceActive]} onPress={() => setPaymentMode("RECEIVER_ON_DELIVERY")}>
        <Text style={styles.photoTitle}>Receiver pays</Text><Text style={styles.muted}>No escrow. Receiver pays after confirming the package.</Text>
      </Pressable>
    </View>
    {paymentMode === "SENDER_ESCROW" && <Text style={styles.hint}>Sender payment is held in SwiftDrop's application-level escrow ledger and released only after receiver PIN confirmation.</Text>}
    {paymentMode === "RECEIVER_ON_DELIVERY" && <Text style={styles.hint}>The receiver confirms the package first, then pays the server-authoritative order total through SwiftDrop. Courier payout waits for verified payment.</Text>}
    <Pressable style={styles.primary} onPress={() => void createDelivery()}><Text style={styles.primaryText}>{paymentMode === "SENDER_ESCROW" ? "Place order & pay" : "Place order — receiver pays"}</Text></Pressable>
    {delivery?.status === "PAYMENT_AUTHORIZED" && <Text style={styles.done}>✓ Payment verified — driver matching can begin.</Text>}
    {delivery && <Text style={styles.code}>Tracking code: {delivery.trackingCode}</Text>}

    <View style={styles.divider} />
    <Text style={styles.heading}>Track a parcel</Text>
    <TextInput style={styles.input} placeholder="Enter tracking code" value={trackingCode} onChangeText={setTrackingCode} autoCapitalize="characters" />
    <TextInput style={styles.input} placeholder="Receiver phone number" value={trackingPhone} onChangeText={setTrackingPhone} keyboardType="phone-pad" />
    <Pressable style={styles.secondary} onPress={() => void track()}><Text style={styles.secondaryText}>Track delivery</Text></Pressable>
    {delivery && <View style={styles.card}>
      <Text style={styles.eyebrow}>LIVE TRACKING</Text><Text style={styles.heroTitle}>Your parcel is on the move</Text>
      <Text style={styles.status}>{delivery.status.replaceAll("_", " ")}</Text>
      <Text>Pickup: {delivery.pickup.formattedAddress}</Text>
      <Text>Drop-off: {delivery.dropoff.formattedAddress}</Text>
      {delivery.pickupInstructions && <Text style={styles.muted}>Pickup note: {delivery.pickupInstructions}</Text>}
      {delivery.dropoffInstructions && <Text style={styles.muted}>Drop-off note: {delivery.dropoffInstructions}</Text>}
      {location && delivery.dropoff.location ? <View style={styles.locationBox}>
        <Text style={styles.photoTitle}>Live driver position</Text>
        <MapView
          style={styles.map}
          provider={Platform.OS === "android" ? PROVIDER_GOOGLE : undefined}
          initialRegion={{
            latitude: location.latitude,
            longitude: location.longitude,
            latitudeDelta: 0.04,
            longitudeDelta: 0.04
          }}
          region={{
            latitude: location.latitude,
            longitude: location.longitude,
            latitudeDelta: 0.04,
            longitudeDelta: 0.04
          }}
        >
          <Marker coordinate={{ latitude: location.latitude, longitude: location.longitude }} title="SwiftDrop driver" description="Live driver location" />
          <Marker coordinate={{ latitude: delivery.dropoff.location.latitude, longitude: delivery.dropoff.location.longitude }} title="Drop-off" description={delivery.dropoff.formattedAddress} />
          <Polyline
            coordinates={[
              { latitude: location.latitude, longitude: location.longitude },
              { latitude: delivery.dropoff.location.latitude, longitude: delivery.dropoff.location.longitude }
            ]}
            strokeWidth={4}
          />
        </MapView>
        <Text>Driver: {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}</Text>
        <Text style={styles.eta}>Approx. ETA: {etaMinutes(haversineDistanceMeters(location, delivery.dropoff.location))} min</Text>
        <Text style={styles.muted}>Updated: {new Date(location.recordedAt).toLocaleTimeString()}</Text>
      </View> : <Text style={styles.muted}>Waiting for the driver to start the trip…</Text>}
            {(delivery.exceptionStatus === "FAILED_ATTEMPT" || delivery.exceptionStatus === "RESCHEDULED") && <View style={styles.card}>
        <Text style={styles.photoTitle}>Delivery exception</Text>
        <Text style={styles.muted}>A delivery attempt was not completed. You can reschedule or request the parcel be returned.</Text>
        <TextInput style={styles.input} placeholder="Future date/time, e.g. 2026-10-01T14:00:00Z" value={rescheduleAt} onChangeText={setRescheduleAt} autoCapitalize="none" />
        <Pressable style={styles.primary} onPress={() => void rescheduleDelivery()}><Text style={styles.primaryText}>Reschedule delivery</Text></Pressable>
        <Pressable style={styles.secondary} onPress={() => void requestReturnToSender()}><Text style={styles.secondaryText}>Request return to sender</Text></Pressable>
        <Text style={styles.hint}>Premium AI can perform these same authorized actions after you provide the required details.</Text>
        <Pressable style={styles.secondary} disabled={swiftAiBusy} onPress={() => void runSwiftAiAction("RESCHEDULE_DELIVERY")}><Text style={styles.secondaryText}>Let Swift AI reschedule</Text></Pressable>
        <Pressable style={styles.secondary} disabled={swiftAiBusy} onPress={() => void runSwiftAiAction("REQUEST_RETURN_TO_SENDER")}><Text style={styles.secondaryText}>Let Swift AI request return</Text></Pressable>
      </View>}
{delivery.status === "ARRIVED" && <View style={styles.ratingBox}>
        <Text style={styles.photoTitle}>Receiver confirmation</Text>
        <Text style={styles.muted}>{delivery.paymentMode === "RECEIVER_ON_DELIVERY" ? "Only confirm after you have physically received the parcel. Your confirmation starts the receiver payment step." : "Only confirm after you have physically received the parcel. This releases the held courier payment."}</Text>
        <TextInput style={styles.input} placeholder="4-digit receiver PIN" keyboardType="number-pad" maxLength={4} secureTextEntry value={receiverConfirmPin} onChangeText={setReceiverConfirmPin} />
        <Pressable style={styles.primary} onPress={() => void confirmReceipt()}><Text style={styles.primaryText}>I received the parcel & complete delivery</Text></Pressable>
      </View>}
      {delivery.status === "DELIVERED" && <Text style={styles.done}>✓ Delivered and PIN verified</Text>}
      {delivery.status === "DELIVERED" && <View style={styles.ratingBox}>
        <Text style={styles.photoTitle}>Rate your driver</Text>
        {ratingSubmitted ? <Text style={styles.done}>✓ Rating submitted</Text> : <>
          <Text style={styles.muted}>Choose one review level:</Text>
          <View style={styles.reviewRow}>
            <Pressable style={[styles.reviewButton, styles.reviewBad]} onPress={() => { setRatingStars(1); void api.rateDelivery(delivery!.id, 1).then(() => { setRatingSubmitted(true); Alert.alert("Review saved", "Thank you for your feedback."); }).catch(error => Alert.alert("Rating failed", error instanceof Error ? error.message : "Unable to save review")); }}><Text style={styles.reviewButtonText}>Bad</Text></Pressable>
            <Pressable style={[styles.reviewButton, styles.reviewFair]} onPress={() => { setRatingStars(3); void api.rateDelivery(delivery!.id, 3).then(() => { setRatingSubmitted(true); Alert.alert("Review saved", "Thank you for your feedback."); }).catch(error => Alert.alert("Rating failed", error instanceof Error ? error.message : "Unable to save review")); }}><Text style={styles.reviewButtonText}>Fair</Text></Pressable>
            <Pressable style={[styles.reviewButton, styles.reviewExcellent]} onPress={() => { setRatingStars(5); void api.rateDelivery(delivery!.id, 5).then(() => { setRatingSubmitted(true); Alert.alert("Review saved", "Thank you for your feedback."); }).catch(error => Alert.alert("Rating failed", error instanceof Error ? error.message : "Unable to save review")); }}><Text style={styles.reviewButtonText}>Excellent</Text></Pressable>
          </View>
        </>}
      </View>}
    </View>}
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F5F1EA" },
  auth: { flex: 1, padding: 24, justifyContent: "center", gap: 14 },
  container: { padding: 20, paddingBottom: 42, gap: 14 },
  homeContainer: { padding: 18, paddingBottom: 40, gap: 14 },
  row: { flexDirection: "row", gap: 10 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  third: { flex: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerActions: { flexDirection: "row", gap: 14, alignItems: "center" },
  heroHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 8, paddingBottom: 8 },
  logo: { fontSize: 32, fontWeight: "900", color: "#2B2630", letterSpacing: -1 },
  brandTag: { color: "#6B746E", fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginTop: 2 },
  eyebrow: { color: "#B7654A", fontSize: 11, fontWeight: "900", letterSpacing: 1.4, marginTop: 10 },
  heroTitle: { fontSize: 30, lineHeight: 35, fontWeight: "900", color: "#27232A", letterSpacing: -0.7 },
  subtitle: { color: "#6F6A70", marginBottom: 12, lineHeight: 20 },
  heading: { fontSize: 20, fontWeight: "800", color: "#27232A", marginTop: 8 },
  input: { borderWidth: 1, borderColor: "#DED8D2", borderRadius: 14, padding: 15, fontSize: 16, backgroundColor: "#FFFFFF", color: "#27232A" },
  suggestion: { borderWidth: 1, borderColor: "#E3DDD7", borderRadius: 12, padding: 13, backgroundColor: "#FFFFFF" },
  half: { flex: 1, borderWidth: 1, borderColor: "#DED8D2", borderRadius: 14, padding: 14, fontSize: 14, backgroundColor: "#FFFFFF" },
  hint: { color: "#7A847E", fontSize: 12, lineHeight: 18 },
  primary: { backgroundColor: "#2B2630", padding: 16, borderRadius: 14, alignItems: "center", shadowColor: "#2B2630", shadowOpacity: 0.12, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 2 },
  primaryText: { color: "#FFFFFF", fontWeight: "800" },
  secondary: { borderWidth: 1, borderColor: "#CFC4BA", backgroundColor: "#FFFFFF", padding: 16, borderRadius: 14, alignItems: "center" },
  secondaryText: { color: "#2B2630", fontWeight: "800" },
  link: { color: "#B7654A", fontWeight: "800", textAlign: "center" },
  code: { fontWeight: "900", color: "#2B2630", marginTop: 4 },
  divider: { height: 1, backgroundColor: "#E8E1DA", marginVertical: 20 },
  card: { borderWidth: 1, borderColor: "#E3DDD7", backgroundColor: "#FFFFFF", borderRadius: 20, padding: 17, gap: 10, marginTop: 12, shadowColor: "#3B3030", shadowOpacity: 0.05, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 1 },
  homeCard: { borderWidth: 1, borderColor: "#E5DDD5", backgroundColor: "#FCF8F2", borderRadius: 24, padding: 16, gap: 14, shadowColor: "#473D2E", shadowOpacity: 0.05, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 1 },
  homeHeading: { fontSize: 22, fontWeight: "900", color: "#27232A", letterSpacing: -0.3 },
  homeTwoCol: { flexDirection: "row", gap: 12 },
  homeChoice: { flex: 1, minHeight: 145, borderWidth: 1, borderColor: "#E8E0D8", borderRadius: 22, padding: 18, justifyContent: "center", alignItems: "center", backgroundColor: "#FFFFFF" },
  homeEmoji: { fontSize: 42, marginBottom: 8 },
  homeChoiceTitle: { fontSize: 18, fontWeight: "900", color: "#27232A" },
  homeChoiceSub: { fontSize: 12, color: "#777178", marginTop: 5, textAlign: "center" },
  actionGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  actionTile: { width: "30%", minWidth: 96, minHeight: 128, borderWidth: 1, borderColor: "#E8E0D8", borderRadius: 18, padding: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#FFFFFF" },
  tileEmoji: { fontSize: 30, marginBottom: 8 },
  tileTitle: { fontSize: 13, fontWeight: "800", color: "#27232A", textAlign: "center" },
  tileSub: { fontSize: 10, color: "#777178", textAlign: "center", marginTop: 4 },
  trackSearch: { backgroundColor: "#FFFFFF", borderRadius: 30, minHeight: 62, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: "#E2DDD8" },
  trackIcon: { fontSize: 26, color: "#2B2630" },
  trackText: { flex: 1, fontSize: 18, fontWeight: "700", color: "#2B272C" },
  trackArrow: { fontSize: 30, color: "#B7654A" },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10 },
  shopPreviewRow: { flexDirection: "row", gap: 10 },
  shopPreview: { flex: 1, borderWidth: 1, borderColor: "#E8E0D8", borderRadius: 18, padding: 14, backgroundColor: "#FFFFFF" },
  productEmoji: { fontSize: 36, marginBottom: 8 },
  productName: { fontSize: 16, fontWeight: "900", color: "#27232A" },
  productPrice: { fontSize: 24, fontWeight: "900", color: "#2B2630", marginTop: 8 },
  priceNote: { fontSize: 11, color: "#746D72", marginTop: 3 },
  productDetail: { borderWidth: 1, borderColor: "#E3DDD7", backgroundColor: "#FFFFFF", borderRadius: 22, padding: 18, gap: 12 },
  productHero: { fontSize: 72, textAlign: "center" },
  productDescription: { fontSize: 15, lineHeight: 23, color: "#263029" },
  sellerCard: { borderWidth: 1, borderColor: "#E3DDD7", backgroundColor: "#F7F2ED", borderRadius: 18, padding: 15, gap: 6 },
  recommendCard: { borderWidth: 1, borderColor: "#E0E5E1", borderRadius: 14, padding: 13, backgroundColor: "#FFFFFF" },
  shopGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  locationCard: { borderWidth: 1, borderColor: "#E3DDD7", backgroundColor: "#FFFFFF", borderRadius: 20, padding: 17, gap: 8 },
  listingCard: { width: "48%", borderWidth: 1, borderColor: "#E0E5E1", borderRadius: 18, padding: 14, backgroundColor: "#FFFFFF", minHeight: 205 },
  listingImage: { width: "100%", height: 150, borderRadius: 14, marginBottom: 8 },
  productDetailImage: { width: 280, height: 220, borderRadius: 16, marginRight: 10 },
  bottomNav: { flexDirection: "row", justifyContent: "space-around", paddingTop: 14, paddingBottom: 8, borderTopWidth: 1, borderTopColor: "#DDDCD6", backgroundColor: "#FCF8F2", borderRadius: 18 },
  navItem: { alignItems: "center", gap: 3, color: "#777178" },
  navActive: { alignItems: "center", gap: 3, color: "#2B2630", fontWeight: "900" },
  status: { fontSize: 18, fontWeight: "900", color: "#2B2630" },
  locationBox: { borderWidth: 1, borderColor: "#E6DED7", borderRadius: 16, padding: 12, gap: 8, backgroundColor: "#FBF7F2" },
  map: { width: "100%", height: 260, borderRadius: 14 },
  photoTitle: { fontWeight: "800", color: "#27232A" },
  mediaPanel: { borderWidth: 1, borderColor: "#E6DED7", borderRadius: 16, padding: 12, gap: 10, backgroundColor: "#FBF7F2" },
  mediaRow: { gap: 10 },
  mediaThumbWrap: { width: 86, height: 86, position: "relative" },
  mediaThumb: { width: 86, height: 86, borderRadius: 12 },
  mediaRemove: { position: "absolute", right: -5, top: -5, width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#C53B3B" },
  mediaRemoveText: { color: "#FFFFFF", fontSize: 18, fontWeight: "900", lineHeight: 20 },

  muted: { color: "#746D72" },
  done: { fontSize: 16, fontWeight: "900", color: "#B7654A", marginTop: 6 },
  eta: { fontSize: 20, fontWeight: "900", color: "#2B2630", marginTop: 6 },
  notification: { borderTopWidth: 1, borderTopColor: "#EAE3DD", paddingTop: 10, gap: 4 },
  notificationTitle: { fontWeight: "900", color: "#27232A" },
  ratingBox: { borderTopWidth: 1, borderTopColor: "#EAE3DD", paddingTop: 12, marginTop: 8, gap: 10 },
  starRow: { flexDirection: "row", gap: 8 },
  star: { fontSize: 34, color: "#F2A93B" },
  reviewRow: { flexDirection: "row", gap: 8 },
  reviewButton: { flex: 1, borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  reviewButtonText: { color: "#FFFFFF", fontWeight: "900" },
  reviewBad: { backgroundColor: "#C53B3B" },
  reviewFair: { backgroundColor: "#D4A62A" },
  reviewExcellent: { backgroundColor: "#B7654A" },
  dangerButton: { backgroundColor: "#C53B3B", borderRadius: 14, padding: 15, alignItems: "center" },
  choice: { flex: 1, borderWidth: 1, borderColor: "#DED8D2", borderRadius: 12, padding: 13, alignItems: "center", backgroundColor: "#FFFFFF" },
  choiceActive: { borderColor: "#B7654A", backgroundColor: "#F6E8E1" },
  supportChoice: { flex: 1, borderWidth: 1, borderColor: "#DED8D2", borderRadius: 12, padding: 13, alignItems: "center", backgroundColor: "#FFFFFF" },
  supportChoiceActive: { borderColor: "#B7654A", backgroundColor: "#F6E8E1" },
  supportChoiceText: { fontWeight: "800", color: "#2B2630" },
  multiline: { minHeight: 110, textAlignVertical: "top" },
});
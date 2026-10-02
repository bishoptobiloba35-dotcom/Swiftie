import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as WebBrowser from "expo-web-browser";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { SafeAreaView, View, Text, TextInput, Pressable, StyleSheet, Alert, ScrollView, Platform } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { SwiftDropApi, type ApiDelivery } from "../../packages/shared/src/api";
import { haversineDistanceMeters, etaMinutes } from "./src/trackingMath";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";
const api = new SwiftDropApi(API_URL);

export default function App() {
  const [signedIn, setSignedIn] = React.useState(false);
  const [authMode, setAuthMode] = React.useState<"login" | "register">("login");
  const [authName, setAuthName] = React.useState("");
  const [authPhone, setAuthPhone] = React.useState("");
  const [authEmail, setAuthEmail] = React.useState("");
  const [authPassword, setAuthPassword] = React.useState("");
  const [pickup, setPickup] = React.useState("");
  const [dropoff, setDropoff] = React.useState("");
  const [pickupLat, setPickupLat] = React.useState("");
  const [pickupLng, setPickupLng] = React.useState("");
  const [pickupResults, setPickupResults] = React.useState<Array<{ formattedAddress?: string; latitude: number; longitude: number }>>([]);
  const [dropoffResults, setDropoffResults] = React.useState<Array<{ formattedAddress?: string; latitude: number; longitude: number }>>([]);
  const [dropoffLat, setDropoffLat] = React.useState("");
  const [dropoffLng, setDropoffLng] = React.useState("");
  const [pickupDropOffId, setPickupDropOffId] = React.useState("");
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
  const [receiverConfirmPin, setReceiverConfirmPin] = React.useState("");
  const [receiverRatingStars, setReceiverRatingStars] = React.useState(0);
  const [receiverRatingComment, setReceiverRatingComment] = React.useState("");
  const [receiverRatingSubmitted, setReceiverRatingSubmitted] = React.useState(false);
  const [receiverMode, setReceiverMode] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [quote, setQuote] = React.useState<Awaited<ReturnType<typeof api.quote>> | null>(null);
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
      const data = await api.register({
        fullName: authName.trim(),
        phone: authPhone.trim(),
        email: authEmail.trim() || undefined,
        password: authPassword,
        role: "CUSTOMER"
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
      const lat = Number(target === "pickup" ? pickupLat : dropoffLat);
      const lng = Number(target === "pickup" ? pickupLng : dropoffLng);
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
      setQuote(await api.quote({ ...coords, weightKg: Number(weightKg), dimensionsCm: { length: Number(lengthCm), width: Number(widthCm), height: Number(heightCm) }, isPerishable }));
    } catch (error) {
      Alert.alert("Quote unavailable", error instanceof Error ? error.message : "Enter valid locations.");
    }
  }

  async function createDelivery() {
    try {
      if (!pickup.trim() || !dropoff.trim() || !receiver.trim() || !phone.trim() || !email.trim() || !/^\d{6}$/.test(receiverPin)) throw new Error("Complete the delivery details and enter a 6-digit receiver PIN.");
      const coords = coordinates();
      if (![weightKg, lengthCm, widthCm, heightCm].every(value => Number(value) > 0)) throw new Error("Enter parcel weight and all three dimensions.");
      if (!(Number(declaredValue) > 0)) throw new Error("Enter the actual value of the goods before placing the order.");
      const serverQuote = await api.quote({ ...coords, weightKg: Number(weightKg), dimensionsCm: { length: Number(lengthCm), width: Number(widthCm), height: Number(heightCm) }, isPerishable });
      setQuote(serverQuote);
      const created = await api.createDelivery({
        receiverName: receiver.trim(),
        receiverPhone: phone.trim(),
        receiverPin,
        declaredValueMinor: Math.round(Number(declaredValue) * 100),
        weightKg: Number(weightKg),
        dimensionsCm: { length: Number(lengthCm), width: Number(widthCm), height: Number(heightCm) },
        isPerishable,
        pickup: { label: pickupDropOffId ? "SwiftDrop drop-off point" : "Pickup", formattedAddress: pickup.trim(), ...coords.pickup },
        dropoff: { label: dropoffDropOffId ? "SwiftDrop drop-off point" : "Drop-off", formattedAddress: dropoff.trim(), ...coords.dropoff },
        pickupDropOffLocationId: pickupDropOffId || undefined,
        dropoffDropOffLocationId: dropoffDropOffId || undefined,
        quote: { ...serverQuote, currency: "NGN" }
      });
      setDelivery(created);
      setTrackingCode(created.trackingCode);
      const payment = await api.initializePayment(created.id, email.trim());
      await WebBrowser.openBrowserAsync(payment.authorizationUrl);
      Alert.alert("Payment", "Complete payment in the browser. SwiftDrop will verify it from the payment provider.");
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
      Alert.alert("Receipt confirmed", "The delivery is complete and the held payment has been released for courier payout.");
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
      <Text style={styles.subtitle}>Confirm that you received the parcel. Your confirmation releases the courier's held payment.</Text>
      <TextInput style={styles.input} placeholder="Tracking code" value={trackingCode} onChangeText={setTrackingCode} autoCapitalize="characters" />
      <TextInput style={styles.input} placeholder="Receiver phone number" value={trackingPhone} onChangeText={setTrackingPhone} keyboardType="phone-pad" />
      <TextInput style={styles.input} placeholder="Six-digit receiver PIN" value={receiverConfirmPin} onChangeText={setReceiverConfirmPin} keyboardType="number-pad" secureTextEntry maxLength={6} />
      <Pressable style={styles.primary} onPress={() => void (async () => {
        try {
          const tracked = await api.track(trackingCode.trim().toUpperCase(), trackingPhone.trim());
          setDelivery(tracked);
          if (tracked.status !== "ARRIVED") throw new Error("The courier has not marked the parcel as arrived yet.");
          const result = await api.confirmReceiver(tracked.id, trackingPhone.trim(), receiverConfirmPin);
          setDelivery(result.delivery);
          Alert.alert("Delivery complete", "Receipt confirmed. Courier payment has been released for payout.");
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
      <Pressable style={styles.primary} onPress={() => void (authMode === "login" ? signIn() : registerCustomer())}><Text style={styles.primaryText}>{authMode === "login" ? "Sign in" : "Create account"}</Text></Pressable>
      <Pressable onPress={() => setAuthMode(authMode === "login" ? "register" : "login")}><Text style={styles.link}>{authMode === "login" ? "Create an account" : "Already have an account? Sign in"}</Text></Pressable>
      <Pressable onPress={() => setReceiverMode(true)}><Text style={styles.link}>I am a receiver — confirm a delivery</Text></Pressable>
    </View></SafeAreaView>;
  }

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.container}>
    <View style={styles.header}><View><Text style={styles.logo}>SwiftDrop</Text><Text style={styles.subtitle}>Send it. Track it. Receive it.</Text></View><View style={styles.headerActions}><Pressable onPress={() => { setShowNotifications(v => !v); void loadNotifications(); }}><Text style={styles.link}>Alerts {notifications.filter(n => !n.read_at).length ? "•" : ""}</Text></Pressable><Pressable onPress={() => { setShowSupport(v => !v); void loadSupportTickets(); }}><Text style={styles.link}>Support</Text></Pressable><Pressable onPress={() => void signOut()}><Text style={styles.link}>Sign out</Text></Pressable></View></View>
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
    <TextInput style={styles.input} placeholder="Receiver name" value={receiver} onChangeText={setReceiver} />
    <TextInput style={styles.input} placeholder="Receiver phone" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
    <TextInput style={styles.input} placeholder="6-digit receiver PIN" keyboardType="number-pad" maxLength={6} secureTextEntry value={receiverPin} onChangeText={setReceiverPin} />
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
      <Text>Service fee: ₦{(quote.serviceFeeMinor / 100).toLocaleString()}</Text>
      <Text style={styles.code}>Total: ₦{(quote.totalMinor / 100).toLocaleString()}</Text>
    </View>}
    <Text style={styles.hint}>Escrow protection: your payment is held after successful payment and is only released for courier payout after the receiver confirms receipt.</Text>
    <Pressable style={styles.primary} onPress={() => void createDelivery()}><Text style={styles.primaryText}>Create & continue to escrow payment</Text></Pressable>
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
        <Text style={styles.muted}>Only confirm after you have physically received the parcel. This releases the held courier payment.</Text>
        <TextInput style={styles.input} placeholder="6-digit receiver PIN" keyboardType="number-pad" maxLength={6} secureTextEntry value={receiverConfirmPin} onChangeText={setReceiverConfirmPin} />
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
  safe: { flex: 1, backgroundColor: "#F6F8F5" },
  auth: { flex: 1, padding: 24, justifyContent: "center", gap: 14 },
  container: { padding: 20, paddingBottom: 42, gap: 14 },
  row: { flexDirection: "row", gap: 10 },
  third: { flex: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerActions: { flexDirection: "row", gap: 14, alignItems: "center" },
  logo: { fontSize: 32, fontWeight: "900", color: "#123D2A", letterSpacing: -1 },
  brandTag: { color: "#6B746E", fontSize: 10, fontWeight: "800", letterSpacing: 1.5, marginTop: 2 },
  eyebrow: { color: "#178A52", fontSize: 11, fontWeight: "900", letterSpacing: 1.4, marginTop: 10 },
  heroTitle: { fontSize: 30, lineHeight: 35, fontWeight: "900", color: "#16221B", letterSpacing: -0.7 },
  subtitle: { color: "#66716A", marginBottom: 12, lineHeight: 20 },
  heading: { fontSize: 20, fontWeight: "800", color: "#16221B", marginTop: 8 },
  input: { borderWidth: 1, borderColor: "#D9E0DB", borderRadius: 14, padding: 15, fontSize: 16, backgroundColor: "#FFFFFF", color: "#16221B" },
  suggestion: { borderWidth: 1, borderColor: "#DDE5DF", borderRadius: 12, padding: 13, backgroundColor: "#FFFFFF" },
  half: { flex: 1, borderWidth: 1, borderColor: "#D9E0DB", borderRadius: 14, padding: 14, fontSize: 14, backgroundColor: "#FFFFFF" },
  hint: { color: "#7A847E", fontSize: 12, lineHeight: 18 },
  primary: { backgroundColor: "#123D2A", padding: 16, borderRadius: 14, alignItems: "center", shadowColor: "#123D2A", shadowOpacity: 0.12, shadowRadius: 10, shadowOffset: { width: 0, height: 5 }, elevation: 2 },
  primaryText: { color: "#FFFFFF", fontWeight: "800" },
  secondary: { borderWidth: 1, borderColor: "#BFD0C5", backgroundColor: "#FFFFFF", padding: 16, borderRadius: 14, alignItems: "center" },
  secondaryText: { color: "#123D2A", fontWeight: "800" },
  link: { color: "#178A52", fontWeight: "800", textAlign: "center" },
  code: { fontWeight: "900", color: "#123D2A", marginTop: 4 },
  divider: { height: 1, backgroundColor: "#E3E9E5", marginVertical: 20 },
  card: { borderWidth: 1, borderColor: "#DDE5DF", backgroundColor: "#FFFFFF", borderRadius: 20, padding: 17, gap: 10, marginTop: 12, shadowColor: "#183B2A", shadowOpacity: 0.05, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, elevation: 1 },
  status: { fontSize: 18, fontWeight: "900", color: "#123D2A" },
  locationBox: { borderWidth: 1, borderColor: "#E1E8E3", borderRadius: 16, padding: 12, gap: 8, backgroundColor: "#FAFCFA" },
  map: { width: "100%", height: 260, borderRadius: 14 },
  photoTitle: { fontWeight: "800", color: "#16221B" },
  muted: { color: "#68736C" },
  done: { fontSize: 16, fontWeight: "900", color: "#178A52", marginTop: 6 },
  eta: { fontSize: 20, fontWeight: "900", color: "#123D2A", marginTop: 6 },
  notification: { borderTopWidth: 1, borderTopColor: "#E7ECE8", paddingTop: 10, gap: 4 },
  notificationTitle: { fontWeight: "900", color: "#16221B" },
  ratingBox: { borderTopWidth: 1, borderTopColor: "#E7ECE8", paddingTop: 12, marginTop: 8, gap: 10 },
  starRow: { flexDirection: "row", gap: 8 },
  star: { fontSize: 34, color: "#F2A93B" },
  reviewRow: { flexDirection: "row", gap: 8 },
  reviewButton: { flex: 1, borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  reviewButtonText: { color: "#FFFFFF", fontWeight: "900" },
  reviewBad: { backgroundColor: "#C53B3B" },
  reviewFair: { backgroundColor: "#D4A62A" },
  reviewExcellent: { backgroundColor: "#178A52" },
  dangerButton: { backgroundColor: "#C53B3B", borderRadius: 14, padding: 15, alignItems: "center" },
  supportChoice: { flex: 1, borderWidth: 1, borderColor: "#D9E0DB", borderRadius: 12, padding: 13, alignItems: "center", backgroundColor: "#FFFFFF" },
  supportChoiceActive: { borderColor: "#178A52", backgroundColor: "#EAF5EF" },
  supportChoiceText: { fontWeight: "800", color: "#123D2A" },
  multiline: { minHeight: 110, textAlignVertical: "top" },
});

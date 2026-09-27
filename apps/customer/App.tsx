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
  const [receiver, setReceiver] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [receiverPin, setReceiverPin] = React.useState("");
  const [weightKg, setWeightKg] = React.useState("");
  const [lengthCm, setLengthCm] = React.useState("");
  const [widthCm, setWidthCm] = React.useState("");
  const [heightCm, setHeightCm] = React.useState("");
  const [isPerishable, setIsPerishable] = React.useState(false);
  const [receiverConfirmPin, setReceiverConfirmPin] = React.useState("");
  const [receiverRatingStars, setReceiverRatingStars] = React.useState(0);
  const [receiverRatingComment, setReceiverRatingComment] = React.useState("");
  const [receiverRatingSubmitted, setReceiverRatingSubmitted] = React.useState(false);
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
      const serverQuote = await api.quote({ ...coords, weightKg: Number(weightKg), dimensionsCm: { length: Number(lengthCm), width: Number(widthCm), height: Number(heightCm) }, isPerishable });
      setQuote(serverQuote);
      const created = await api.createDelivery({
        receiverName: receiver.trim(),
        receiverPhone: phone.trim(),
        receiverPin,
        weightKg: Number(weightKg),
        dimensionsCm: { length: Number(lengthCm), width: Number(widthCm), height: Number(heightCm) },
        isPerishable,
        pickup: { label: "Pickup", formattedAddress: pickup.trim(), ...coords.pickup },
        dropoff: { label: "Drop-off", formattedAddress: dropoff.trim(), ...coords.dropoff },
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
    </View></SafeAreaView>;
  }

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.container}>
    <View style={styles.header}><View><Text style={styles.logo}>SwiftDrop</Text><Text style={styles.subtitle}>Send it. Track it. Receive it.</Text></View><View style={styles.headerActions}><Pressable onPress={() => { setShowNotifications(v => !v); void loadNotifications(); }}><Text style={styles.link}>Alerts {notifications.filter(n => !n.read_at).length ? "•" : ""}</Text></Pressable><Pressable onPress={() => void signOut()}><Text style={styles.link}>Sign out</Text></Pressable></View></View>
    {showNotifications && <View style={styles.card}><View style={styles.header}><Text style={styles.heading}>Notifications</Text><Pressable onPress={() => void loadNotifications()}><Text>Refresh</Text></Pressable></View>{notifications.length === 0 ? <Text style={styles.muted}>No notifications.</Text> : notifications.map(item => <Pressable key={item.id} style={styles.notification} onPress={() => void markNotificationRead(item.id)}><Text style={styles.notificationTitle}>{item.title}</Text><Text>{item.body}</Text><Text style={styles.muted}>{new Date(item.created_at).toLocaleString()} · {item.read_at ? "Read" : "Tap to mark read"}</Text></Pressable>)}</View>}
    <Text style={styles.heading}>Create a delivery</Text>
    <TextInput style={styles.input} placeholder="Pickup address" value={pickup} onChangeText={value => { setPickup(value); void searchAddress(value, "pickup"); }} />
    {pickupResults.map((result, index) => <Pressable key={"pickup-" + index} style={styles.suggestion} onPress={() => chooseAddress(result, "pickup")}><Text>{result.formattedAddress}</Text></Pressable>)}
    <TextInput style={styles.input} placeholder="Drop-off address" value={dropoff} onChangeText={value => { setDropoff(value); void searchAddress(value, "dropoff"); }} />
    {dropoffResults.map((result, index) => <Pressable key={"dropoff-" + index} style={styles.suggestion} onPress={() => chooseAddress(result, "dropoff")}><Text>{result.formattedAddress}</Text></Pressable>)}
    <Text style={styles.hint}>Choose your current location for pickup, or enter coordinates from a map/address search.</Text>
    <Pressable style={styles.secondary} onPress={() => void useCurrentPickupLocation()}><Text style={styles.secondaryText}>Use my current location for pickup</Text></Pressable>
    <View style={styles.row}><TextInput style={styles.half} placeholder="Pickup latitude" value={pickupLat} onChangeText={setPickupLat} keyboardType="decimal-pad" /><TextInput style={styles.half} placeholder="Pickup longitude" value={pickupLng} onChangeText={setPickupLng} keyboardType="decimal-pad" /></View>
    <View style={styles.row}><TextInput style={styles.half} placeholder="Drop-off latitude" value={dropoffLat} onChangeText={setDropoffLat} keyboardType="decimal-pad" /><TextInput style={styles.half} placeholder="Drop-off longitude" value={dropoffLng} onChangeText={setDropoffLng} keyboardType="decimal-pad" /></View>
    <TextInput style={styles.input} placeholder="Receiver name" value={receiver} onChangeText={setReceiver} />
    <TextInput style={styles.input} placeholder="Receiver phone" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
    <TextInput style={styles.input} placeholder="6-digit receiver PIN" keyboardType="number-pad" maxLength={6} secureTextEntry value={receiverPin} onChangeText={setReceiverPin} />
    <Text style={styles.hint}>Give this PIN to the receiver. The receiver must use it to confirm receipt before courier payout is released.</Text>
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
    <Pressable style={styles.primary} onPress={() => void createDelivery()}><Text style={styles.primaryText}>Create & continue to payment</Text></Pressable>
    {delivery?.status === "PAYMENT_AUTHORIZED" && <Text style={styles.done}>✓ Payment verified — driver matching can begin.</Text>}
    {delivery && <Text style={styles.code}>Tracking code: {delivery.trackingCode}</Text>}

    <View style={styles.divider} />
    <Text style={styles.heading}>Track a parcel</Text>
    <TextInput style={styles.input} placeholder="Enter tracking code" value={trackingCode} onChangeText={setTrackingCode} autoCapitalize="characters" />
    <TextInput style={styles.input} placeholder="Receiver phone number" value={trackingPhone} onChangeText={setTrackingPhone} keyboardType="phone-pad" />
    <Pressable style={styles.secondary} onPress={() => void track()}><Text style={styles.secondaryText}>Track delivery</Text></Pressable>
    {delivery && <View style={styles.card}>
      <Text style={styles.heading}>Live delivery tracking</Text>
      <Text style={styles.status}>{delivery.status.replaceAll("_", " ")}</Text>
      <Text>Pickup: {delivery.pickup.formattedAddress}</Text>
      <Text>Drop-off: {delivery.dropoff.formattedAddress}</Text>
      {location ? <View style={styles.locationBox}>
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
          <Marker coordinate={{ latitude: delivery.dropoff.latitude, longitude: delivery.dropoff.longitude }} title="Drop-off" description={delivery.dropoff.formattedAddress} />
          <Polyline
            coordinates={[
              { latitude: location.latitude, longitude: location.longitude },
              { latitude: delivery.dropoff.latitude, longitude: delivery.dropoff.longitude }
            ]}
            strokeWidth={4}
          />
        </MapView>
        <Text>Driver: {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}</Text>
        <Text style={styles.eta}>Approx. ETA: {etaMinutes(haversineDistanceMeters(location, delivery.dropoff))} min</Text>
        <Text style={styles.muted}>Updated: {new Date(location.recordedAt).toLocaleTimeString()}</Text>
      </View> : <Text style={styles.muted}>Waiting for the driver to start the trip…</Text>}
      {delivery.status === "ARRIVED" && <View style={styles.ratingBox}>
        <Text style={styles.photoTitle}>Receiver confirmation</Text>
        <Text style={styles.muted}>Only confirm after you have physically received the parcel. This releases the held courier payment.</Text>
        <TextInput style={styles.input} placeholder="6-digit receiver PIN" keyboardType="number-pad" maxLength={6} secureTextEntry value={receiverConfirmPin} onChangeText={setReceiverConfirmPin} />
        <Pressable style={styles.primary} onPress={() => void confirmReceipt()}><Text style={styles.primaryText}>I received the parcel & complete delivery</Text></Pressable>
      </View>}
      {delivery.status === "DELIVERED" && <Text style={styles.done}>✓ Delivered and PIN verified</Text>}
      {delivery.status === "DELIVERED" && <View style={styles.ratingBox}>
        <Text style={styles.photoTitle}>Receiver review</Text>
        {receiverRatingSubmitted ? <Text style={styles.done}>✓ Receiver review submitted</Text> : <>
          <View style={styles.starRow}>{[1,2,3,4,5].map(star => <Pressable key={star} onPress={() => setReceiverRatingStars(star)}><Text style={styles.star}>{star <= receiverRatingStars ? "★" : "☆"}</Text></Pressable>)}</View>
          <TextInput style={styles.input} placeholder="Optional comment about the courier" value={receiverRatingComment} onChangeText={setReceiverRatingComment} maxLength={500} multiline />
          <Pressable style={styles.primary} onPress={() => void submitReceiverRating()}><Text style={styles.primaryText}>Submit receiver review</Text></Pressable>
        </>}
      </View>{delivery.status === "DELIVERED" && <View style={styles.ratingBox}>
        <Text style={styles.photoTitle}>Rate your driver</Text>
        {ratingSubmitted ? <Text style={styles.done}>✓ Rating submitted</Text> : <>
          <View style={styles.starRow}>{[1,2,3,4,5].map(star => <Pressable key={star} onPress={() => setRatingStars(star)}><Text style={styles.star}>{star <= ratingStars ? "★" : "☆"}</Text></Pressable>)}</View>
          <TextInput style={styles.input} placeholder="Optional comment" value={ratingComment} onChangeText={setRatingComment} maxLength={500} multiline />
          <Pressable style={styles.primary} onPress={() => void submitRating()}><Text style={styles.primaryText}>Submit rating</Text></Pressable>
        </>}
      </View>}
    </View>}
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fff" },
  auth: { flex: 1, padding: 24, justifyContent: "center", gap: 14 },
  container: { padding: 24, gap: 12 },
  row: { flexDirection: "row", gap: 8 },
  third: { flex: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerActions: { flexDirection: "row", gap: 14, alignItems: "center" },
  logo: { fontSize: 32, fontWeight: "800", marginTop: 8 },
  subtitle: { color: "#666", marginBottom: 12 },
  heading: { fontSize: 20, fontWeight: "700", marginTop: 8 },
  input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 14, fontSize: 16 },
  suggestion: { borderWidth: 1, borderColor: "#eee", borderRadius: 10, padding: 12, backgroundColor: "#fafafa" },
  row: { flexDirection: "row", gap: 10 },
  half: { flex: 1, borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 14, fontSize: 14 },
  hint: { color: "#777", fontSize: 12, lineHeight: 18 },
  primary: { backgroundColor: "#111", padding: 16, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontWeight: "700" },
  secondary: { borderWidth: 1, borderColor: "#111", padding: 16, borderRadius: 12, alignItems: "center" },
  secondaryText: { color: "#111", fontWeight: "700" },
  link: { color: "#111", fontWeight: "700", textAlign: "center" },
  code: { fontWeight: "700", marginTop: 4 },
  divider: { height: 1, backgroundColor: "#eee", marginVertical: 18 },
  card: { borderWidth: 1, borderColor: "#ddd", borderRadius: 16, padding: 16, gap: 10, marginTop: 12 },
  status: { fontSize: 18, fontWeight: "800" },
  locationBox: { borderWidth: 1, borderColor: "#eee", borderRadius: 10, padding: 12, gap: 8 },
  map: { width: "100%", height: 260, borderRadius: 12 },
  photoTitle: { fontWeight: "700" },
  muted: { color: "#666" },
  done: { fontSize: 17, fontWeight: "800", marginTop: 6 },
  eta: { fontSize: 18, fontWeight: "800", marginTop: 6 },
  notification: { borderTopWidth: 1, borderTopColor: "#eee", paddingTop: 10, gap: 4 },
  notificationTitle: { fontWeight: "800" },
  ratingBox: { borderTopWidth: 1, borderTopColor: "#eee", paddingTop: 12, marginTop: 8, gap: 10 },
  starRow: { flexDirection: "row", gap: 8 },
  star: { fontSize: 34 }
});

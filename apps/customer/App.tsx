import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as WebBrowser from "expo-web-browser";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { SafeAreaView, View, Text, TextInput, Pressable, StyleSheet, Alert, ScrollView, Platform } from "react-native";
import { SwiftDropApi, type ApiDelivery } from "../../packages/shared/src/api";

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
  const [email, setEmail] = React.useState("");
  const [quote, setQuote] = React.useState<Awaited<ReturnType<typeof api.quote>> | null>(null);
  const [delivery, setDelivery] = React.useState<ApiDelivery | null>(null);
  const [trackingCode, setTrackingCode] = React.useState("");
  const [location, setLocation] = React.useState<ApiDelivery["latestLocation"]>(null);
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
    } catch (error) {
      Alert.alert("Registration failed", error instanceof Error ? error.message : "Unable to register");
    }
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
      const coords = coordinates();
      setQuote(await api.quote(coords));
    } catch (error) {
      Alert.alert("Quote unavailable", error instanceof Error ? error.message : "Enter valid locations.");
    }
  }

  async function createDelivery() {
    try {
      if (!pickup.trim() || !dropoff.trim() || !receiver.trim() || !phone.trim() || !email.trim()) throw new Error("Complete the delivery details.");
      const coords = coordinates();
      const serverQuote = await api.quote(coords);
      setQuote(serverQuote);
      const created = await api.createDelivery({
        senderId: "authenticated",
        receiverName: receiver.trim(),
        receiverPhone: phone.trim(),
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
      const tracked = await api.track(trackingCode.trim().toUpperCase());
      setDelivery(tracked);
      setLocation(tracked.latestLocation ?? null);
      const session = await api.createTrackingSession(tracked.trackingCode);
      socketRef.current = api.connectToTracking(session.deliveryId, session.trackingToken, next => setLocation(next), update => setDelivery(prev => prev ? { ...prev, ...update } : prev));
    } catch (error) {
      Alert.alert("Tracking failed", error instanceof Error ? error.message : "Tracking code not found.");
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
    <View style={styles.header}><View><Text style={styles.logo}>SwiftDrop</Text><Text style={styles.subtitle}>Send it. Track it. Receive it.</Text></View><Pressable onPress={() => void signOut()}><Text style={styles.link}>Sign out</Text></Pressable></View>
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
    <TextInput style={styles.input} placeholder="Payment email" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
    <Pressable style={styles.secondary} onPress={() => void getQuote()}><Text style={styles.secondaryText}>Calculate delivery price</Text></Pressable>
    {quote && <Text style={styles.code}>Server quote: ₦{(quote.totalMinor / 100).toLocaleString()} · {(quote.distanceMeters / 1000).toFixed(1)} km</Text>}
    <Pressable style={styles.primary} onPress={() => void createDelivery()}><Text style={styles.primaryText}>Create & continue to payment</Text></Pressable>
    {delivery?.status === "PAYMENT_AUTHORIZED" && <Text style={styles.done}>✓ Payment verified — driver matching can begin.</Text>}
    {delivery && <Text style={styles.code}>Tracking code: {delivery.trackingCode}</Text>}

    <View style={styles.divider} />
    <Text style={styles.heading}>Track a parcel</Text>
    <TextInput style={styles.input} placeholder="Enter tracking code" value={trackingCode} onChangeText={setTrackingCode} autoCapitalize="characters" />
    <Pressable style={styles.secondary} onPress={() => void track()}><Text style={styles.secondaryText}>Track delivery</Text></Pressable>
    {delivery && <View style={styles.card}>
      <Text style={styles.heading}>Live delivery tracking</Text>
      <Text style={styles.status}>{delivery.status.replaceAll("_", " ")}</Text>
      <Text>Pickup: {delivery.pickup.formattedAddress}</Text>
      <Text>Drop-off: {delivery.dropoff.formattedAddress}</Text>
      {location ? <View style={styles.locationBox}><Text style={styles.photoTitle}>Driver location</Text><Text>Latitude: {location.latitude.toFixed(6)}</Text><Text>Longitude: {location.longitude.toFixed(6)}</Text><Text style={styles.muted}>Updated: {new Date(location.recordedAt).toLocaleTimeString()}</Text></View> : <Text style={styles.muted}>Waiting for the driver to start the trip…</Text>}
      {delivery.status === "DELIVERED" && <Text style={styles.done}>✓ Delivered and PIN verified</Text>}
    </View>}
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fff" },
  auth: { flex: 1, padding: 24, justifyContent: "center", gap: 14 },
  container: { padding: 24, gap: 12 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
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
  locationBox: { borderWidth: 1, borderColor: "#eee", borderRadius: 10, padding: 12, gap: 4 },
  photoTitle: { fontWeight: "700" },
  muted: { color: "#666" },
  done: { fontSize: 17, fontWeight: "800", marginTop: 6 }
});

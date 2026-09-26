import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as WebBrowser from "expo-web-browser";
import { SafeAreaView, View, Text, TextInput, Pressable, StyleSheet, Alert, ScrollView } from "react-native";
import { SwiftDropApi, type ApiDelivery } from "../../packages/shared/src/api";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";
const api = new SwiftDropApi(API_URL);
const CUSTOMER_ID = "00000000-0000-4000-8000-000000000001";

async function getCustomerToken(): Promise<string> {
  const existing = await AsyncStorage.getItem("swiftdrop.customerAccessToken");
  if (existing) return existing;
  const response = await fetch(API_URL + "/api/auth/dev-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: CUSTOMER_ID, role: "CUSTOMER" })
  });
  const data = await response.json();
  if (!response.ok || !data.accessToken) throw new Error(data.error ?? "Customer authentication failed");
  await AsyncStorage.setItem("swiftdrop.customerAccessToken", data.accessToken);
  return data.accessToken;
}

export default function App() {
  const [pickup, setPickup] = React.useState("");
  const [dropoff, setDropoff] = React.useState("");
  const [receiver, setReceiver] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [trackingCode, setTrackingCode] = React.useState("");
  const [quote, setQuote] = React.useState<{ totalMinor: number; distanceMeters: number; durationSeconds: number } | null>(null);
  const [createdCode, setCreatedCode] = React.useState("");
  const [delivery, setDelivery] = React.useState<ApiDelivery | null>(null);
  const [location, setLocation] = React.useState<ApiDelivery["latestLocation"]>(null);
  const socketRef = React.useRef<WebSocket | null>(null);

  async function createDelivery() {
    try {
      api.setAccessToken(await getCustomerToken());
      // Temporary address-to-coordinate adapter for the development flow.
      // Production will replace this with real geocoding/map selection.
      const pickupPoint = { latitude: 6.5244, longitude: 3.3792 };
      const dropoffPoint = { latitude: 6.6018, longitude: 3.3515 };
      const calculated = await api.quote({ pickup: pickupPoint, dropoff: dropoffPoint });
      setQuote(calculated);
      const result = await api.createDelivery({
        senderId: CUSTOMER_ID,
        receiverName: receiver,
        receiverPhone: phone,
        pickup: { label: "Pickup", formattedAddress: pickup, ...pickupPoint },
        dropoff: { label: "Drop-off", formattedAddress: dropoff, ...dropoffPoint },
        quote: calculated
      });
      setCreatedCode(result.trackingCode);
      setTrackingCode(result.trackingCode);
      setDelivery(result);
      if (!email.trim()) throw new Error("Enter your payment email before creating a delivery.");
      const payment = await api.initializePayment(result.id, email.trim());
      const checkout = await WebBrowser.openAuthSessionAsync(
        payment.authorizationUrl,
        API_URL + "/payment/callback"
      );
      if (checkout.type === "cancel" || checkout.type === "dismiss") {
        Alert.alert("Payment", "Checkout was closed. You can return to this delivery and check payment status.");
      }
      let verified = false;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const status = await api.paymentStatus(result.id);
        if (status.payment.status === "HELD" || status.payment.status === "AUTHORIZED") {
          verified = true;
          break;
        }
        if (status.payment.status === "FAILED" || status.payment.status === "REFUNDED") break;
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      if (verified) {
        Alert.alert("Payment verified", "Your delivery is now available for driver matching.");
      } else {
        Alert.alert("Payment pending", "We have not received payment confirmation yet. You can check again shortly.");
      }
      await loadTracking(result.trackingCode);
    } catch (error) {
      Alert.alert("SwiftDrop", error instanceof Error ? error.message : "The API is not reachable yet.");
    }
  }

  async function loadTracking(code: string) {
    const result = await api.track(code.trim());
    setDelivery(result);
    setLocation(result.latestLocation ?? null);
    socketRef.current?.close();
    const session = await api.createTrackingSession(result.trackingCode);
    socketRef.current = api.connectToTracking(result.id, session.trackingToken, next => {
      setLocation(next ?? null);
      setDelivery(current => current ? { ...current, latestLocation: next } : current);
    }, updated => {
      setDelivery(current => current ? { ...current, ...updated } : current);
    });
  }

  async function track() {
    try {
      await loadTracking(trackingCode);
    } catch (error) {
      Alert.alert("SwiftDrop", error instanceof Error ? error.message : "Tracking code not found.");
    }
  }

  React.useEffect(() => () => socketRef.current?.close(), []);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.logo}>SwiftDrop</Text>
        <Text style={styles.subtitle}>Send it. Track it. Receive it.</Text>

        <Text style={styles.heading}>Create a delivery</Text>
        <TextInput style={styles.input} placeholder="Pickup address" value={pickup} onChangeText={setPickup} />
        <TextInput style={styles.input} placeholder="Drop-off address" value={dropoff} onChangeText={setDropoff} />
        <TextInput style={styles.input} placeholder="Receiver name" value={receiver} onChangeText={setReceiver} />
        <TextInput style={styles.input} placeholder="Receiver phone" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
        <TextInput style={styles.input} placeholder="Payment email" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
        {quote ? <Text style={styles.code}>Estimated fare: ₦{(quote.totalMinor / 100).toLocaleString()} · {(quote.distanceMeters / 1000).toFixed(1)} km</Text> : null}
        <Pressable style={styles.primary} onPress={() => void createDelivery()}>
          <Text style={styles.primaryText}>Create & continue to payment</Text>
        </Pressable>
        {delivery?.status === "PAYMENT_AUTHORIZED" ? (
          <Text style={styles.done}>✓ Payment verified — your delivery can enter driver matching.</Text>
        ) : null}
        {!!createdCode && <Text style={styles.code}>Tracking code: {createdCode}</Text>}

        <View style={styles.divider} />
        <Text style={styles.heading}>Track a parcel</Text>
        <TextInput style={styles.input} placeholder="Enter tracking code" value={trackingCode} onChangeText={setTrackingCode} autoCapitalize="characters" />
        <Pressable style={styles.secondary} onPress={() => void track()}>
          <Text style={styles.secondaryText}>Track delivery</Text>
        </Pressable>

        {delivery ? (
          <View style={styles.trackingCard}>
            <Text style={styles.heading}>Live delivery tracking</Text>
            <Text style={styles.status}>{delivery.status.replaceAll("_", " ")}</Text>
            <Text>Pickup: {delivery.pickup.formattedAddress}</Text>
            <Text>Drop-off: {delivery.dropoff.formattedAddress}</Text>
            {delivery.pickupPhotoUrl ? (
              <View style={styles.photoBox}>
                <Text style={styles.photoTitle}>Parcel pickup photo recorded</Text>
                {delivery.pickupPhotoUrl.startsWith("data:image/") ? <Text style={styles.muted}>Pickup evidence captured by the driver.</Text> : <Text style={styles.muted}>Pickup evidence available.</Text>}
              </View>
            ) : null}
            {location ? (
              <View style={styles.locationBox}>
                <Text style={styles.photoTitle}>Driver location</Text>
                <Text>Latitude: {location.latitude.toFixed(6)}</Text>
                <Text>Longitude: {location.longitude.toFixed(6)}</Text>
                <Text style={styles.muted}>Updated: {new Date(location.recordedAt).toLocaleTimeString()}</Text>
              </View>
            ) : (
              <Text style={styles.muted}>Waiting for the driver to start the trip…</Text>
            )}
            {delivery.status === "DELIVERED" ? <Text style={styles.done}>✓ Delivered and PIN verified</Text> : null}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fff" },
  container: { padding: 24, gap: 12 },
  logo: { fontSize: 32, fontWeight: "800", marginTop: 24 },
  subtitle: { color: "#666", marginBottom: 12 },
  heading: { fontSize: 20, fontWeight: "700", marginTop: 8 },
  input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 14, fontSize: 16 },
  primary: { backgroundColor: "#111", padding: 16, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontWeight: "700" },
  secondary: { borderWidth: 1, borderColor: "#111", padding: 16, borderRadius: 12, alignItems: "center" },
  secondaryText: { color: "#111", fontWeight: "700" },
  code: { fontWeight: "700", marginTop: 4 },
  divider: { height: 1, backgroundColor: "#eee", marginVertical: 18 },
  trackingCard: { borderWidth: 1, borderColor: "#ddd", borderRadius: 16, padding: 16, gap: 10, marginTop: 12 },
  status: { fontSize: 18, fontWeight: "800" },
  photoBox: { borderWidth: 1, borderColor: "#eee", borderRadius: 10, padding: 12, gap: 4 },
  locationBox: { borderWidth: 1, borderColor: "#eee", borderRadius: 10, padding: 12, gap: 4 },
  photoTitle: { fontWeight: "700" },
  muted: { color: "#666" },
  done: { fontSize: 17, fontWeight: "800", marginTop: 6 }
});

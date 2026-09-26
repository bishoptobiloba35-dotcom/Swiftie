import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { SafeAreaView, View, Text, TextInput, Pressable, StyleSheet, Alert, ScrollView } from "react-native";
import { SwiftDropApi, type ApiDelivery } from "../../packages/shared/src/api";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";
const api = new SwiftDropApi(API_URL);
async function getCustomerToken(): Promise<string> {
  const existing = await AsyncStorage.getItem("swiftdrop.customerAccessToken");
  if (existing) return existing;
  throw new Error("Please sign in to SwiftDrop first.");
}

export default function App() {
  const [signedIn, setSignedIn] = React.useState(false);
  const [authPhone, setAuthPhone] = React.useState("");
  const [authPassword, setAuthPassword] = React.useState("");
  const [authName, setAuthName] = React.useState("");
  const [authEmail, setAuthEmail] = React.useState("");
  const [authMode, setAuthMode] = React.useState<"login" | "register">("login");

  async function signIn() {
    try {
      const data = await api.login(authPhone, authPassword);
      if (data.user?.role !== "CUSTOMER") throw new Error("This account is not a customer account.");
      await AsyncStorage.setItem("swiftdrop.customerAccessToken", data.accessToken);
      setSignedIn(true);
    } catch (error) {
      Alert.alert("Sign in failed", error instanceof Error ? error.message : "Unable to sign in");
    }
  }

  async function registerCustomer() {
    try {
      const data = await api.register({
        fullName: authName,
        phone: authPhone,
        email: authEmail || undefined,
        password: authPassword,
        role: "CUSTOMER"
      });
      await AsyncStorage.setItem("swiftdrop.customerAccessToken", data.accessToken);
      setSignedIn(true);
    } catch (error) {
      Alert.alert("Registration failed", error instanceof Error ? error.message : "Unable to register");
    }
  }

  if (!signedIn) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>SwiftDrop</Text>
        <Text style={styles.subtitle}>{authMode === "login" ? "Sign in to send and track parcels." : "Create your customer account."}</Text>
        {authMode === "register" && <TextInput style={styles.input} placeholder="Full name" value={authName} onChangeText={setAuthName} />}
        <TextInput style={styles.input} placeholder="Phone number" value={authPhone} onChangeText={setAuthPhone} keyboardType="phone-pad" />
        {authMode === "register" && <TextInput style={styles.input} placeholder="Email (optional)" value={authEmail} onChangeText={setAuthEmail} keyboardType="email-address" autoCapitalize="none" />}
        <TextInput style={styles.input} placeholder="Password" value={authPassword} onChangeText={setAuthPassword} secureTextEntry />
        <Pressable style={styles.primary} onPress={authMode === "login" ? signIn : registerCustomer}>
          <Text style={styles.primaryText}>{authMode === "login" ? "Sign in" : "Create account"}</Text>
        </Pressable>
        <Pressable onPress={() => setAuthMode(authMode === "login" ? "register" : "login")}>
          <Text style={styles.link}>{authMode === "login" ? "Create an account" : "Already have an account? Sign in"}</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>SwiftDrop</Text>
        <Text style={styles.subtitle}>Sign in to create and track deliveries.</Text>
        <TextInput style={styles.input} placeholder="Phone number" value={authPhone} onChangeText={setAuthPhone} keyboardType="phone-pad" />
        <TextInput style={styles.input} placeholder="Password" value={authPassword} onChangeText={setAuthPassword} secureTextEntry />
        <Pressable style={styles.button} onPress={signIn}><Text style={styles.buttonText}>Sign in</Text></Pressable>
      </SafeAreaView>
    );
  }

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

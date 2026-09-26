import React from "react";
import { SafeAreaView, View, Text, TextInput, Pressable, StyleSheet, Alert } from "react-native";
import { SwiftDropApi } from "../../packages/shared/src/api";

const api = new SwiftDropApi(process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000");

export default function App() {
  const [pickup, setPickup] = React.useState("");
  const [dropoff, setDropoff] = React.useState("");
  const [receiver, setReceiver] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [trackingCode, setTrackingCode] = React.useState("");
  const [createdCode, setCreatedCode] = React.useState("");

  async function createDelivery() {
    try {
      const delivery = await api.createDelivery({
        senderId: "demo-customer",
        receiverName: receiver,
        receiverPhone: phone,
        pickup: { label: "Pickup", formattedAddress: pickup },
        dropoff: { label: "Drop-off", formattedAddress: dropoff }
      });
      setCreatedCode(delivery.trackingCode);
      Alert.alert("Delivery created", delivery.trackingCode);
    } catch {
      Alert.alert("SwiftDrop", "The API is not reachable yet.");
    }
  }

  async function track() {
    try {
      const delivery = await api.track(trackingCode.trim());
      Alert.alert("Delivery status", delivery.status);
    } catch {
      Alert.alert("SwiftDrop", "Tracking code not found.");
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.logo}>SwiftDrop</Text>
        <Text style={styles.subtitle}>Send it. Track it. Receive it.</Text>

        <Text style={styles.heading}>Create a delivery</Text>
        <TextInput style={styles.input} placeholder="Pickup address" value={pickup} onChangeText={setPickup} />
        <TextInput style={styles.input} placeholder="Drop-off address" value={dropoff} onChangeText={setDropoff} />
        <TextInput style={styles.input} placeholder="Receiver name" value={receiver} onChangeText={setReceiver} />
        <TextInput style={styles.input} placeholder="Receiver phone" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />

        <Pressable style={styles.primary} onPress={createDelivery}>
          <Text style={styles.primaryText}>Create delivery</Text>
        </Pressable>

        {!!createdCode && <Text style={styles.code}>Tracking code: {createdCode}</Text>}

        <View style={styles.divider} />
        <Text style={styles.heading}>Track a parcel</Text>
        <TextInput style={styles.input} placeholder="Enter tracking code" value={trackingCode} onChangeText={setTrackingCode} autoCapitalize="characters" />
        <Pressable style={styles.secondary} onPress={track}>
          <Text style={styles.secondaryText}>Track delivery</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fff" },
  container: { flex: 1, padding: 24, gap: 12 },
  logo: { fontSize: 32, fontWeight: "800", marginTop: 24 },
  subtitle: { color: "#666", marginBottom: 20 },
  heading: { fontSize: 20, fontWeight: "700", marginTop: 8 },
  input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 14, fontSize: 16 },
  primary: { backgroundColor: "#111", padding: 16, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontWeight: "700" },
  secondary: { borderWidth: 1, borderColor: "#111", padding: 16, borderRadius: 12, alignItems: "center" },
  secondaryText: { color: "#111", fontWeight: "700" },
  code: { fontWeight: "700", marginTop: 4 },
  divider: { height: 1, backgroundColor: "#eee", marginVertical: 18 }
});

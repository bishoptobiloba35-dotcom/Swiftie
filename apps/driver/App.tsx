import React from "react";
import { SafeAreaView, View, Text, Pressable, StyleSheet, Alert, TextInput } from "react-native";
import * as Location from "expo-location";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";
const DRIVER_ID = "00000000-0000-4000-8000-000000000003";

type Job = {
  id: string; trackingCode: string;
  pickup: { label: string; formattedAddress: string };
  dropoff: { label: string; formattedAddress: string };
  receiverName: string; status: string;
};

async function api(path: string, body?: unknown) {
  const response = await fetch(API_URL + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export default function App() {
  const [online, setOnline] = React.useState(false);
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [job, setJob] = React.useState<Job | null>(null);
  const [status, setStatus] = React.useState("OFFLINE");
  const [photoUrl, setPhotoUrl] = React.useState("");
  const [pin, setPin] = React.useState("");
  const [tracking, setTracking] = React.useState(false);

  const refreshJobs = async () => {
    try {
      const data = await api("/api/driver/" + DRIVER_ID + "/jobs");
      setJobs(data.jobs);
    } catch (error) {
      Alert.alert("SwiftDrop", error instanceof Error ? error.message : "Could not load jobs");
    }
  };

  const goOnline = async () => {
    setOnline(true);
    setStatus("ONLINE");
    await refreshJobs();
  };

  const acceptJob = async (selected: Job) => {
    try {
      const data = await api("/api/deliveries/" + selected.id + "/accept", { driverId: DRIVER_ID });
      setJob(data);
      setStatus(data.status);
      await refreshJobs();
    } catch (error) {
      Alert.alert("Unable to accept", error instanceof Error ? error.message : "Try again");
    }
  };

  const atPickup = async () => {
    if (!job) return;
    try {
      const data = await api("/api/deliveries/" + job.id + "/at-pickup", { driverId: DRIVER_ID });
      setJob(data); setStatus(data.status);
    } catch (error) {
      Alert.alert("Pickup", error instanceof Error ? error.message : "Try again");
    }
  };

  const confirmPickup = async () => {
    if (!job) return;
    if (!photoUrl.trim()) {
      Alert.alert("Parcel photo required", "Add the parcel photo URL for this development build. Camera upload will be connected next.");
      return;
    }
    try {
      const data = await api("/api/deliveries/" + job.id + "/pickup", { driverId: DRIVER_ID, pickupPhotoUrl: photoUrl.trim() });
      setJob(data); setStatus(data.status);
    } catch (error) {
      Alert.alert("Pickup", error instanceof Error ? error.message : "Try again");
    }
  };

  const startTrip = async () => {
    if (!job) return;
    try {
      const data = await api("/api/deliveries/" + job.id + "/start-trip", { driverId: DRIVER_ID });
      setJob(data); setStatus(data.status);
      setTracking(true);
    } catch (error) {
      Alert.alert("Trip", error instanceof Error ? error.message : "Try again");
    }
  };

  React.useEffect(() => {
    if (!tracking || !job) return;
    let subscription: Location.LocationSubscription | undefined;
    let cancelled = false;
    (async () => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Location permission", "SwiftDrop needs location permission while a delivery is active.");
        return;
      }
      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 10 },
        async location => {
          if (cancelled) return;
          try {
            const data = await api("/api/deliveries/" + job.id + "/location", {
              driverId: DRIVER_ID,
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
              accuracyMeters: location.coords.accuracy
            });
            setStatus("IN_TRANSIT");
            void data;
          } catch {}
        }
      );
    })();
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [tracking, job?.id]);

  const markArrived = async () => {
    if (!job) return;
    try {
      const data = await api("/api/deliveries/" + job.id + "/arrived", { driverId: DRIVER_ID });
      setJob(data); setStatus(data.status); setTracking(false);
    } catch (error) {
      Alert.alert("Arrival", error instanceof Error ? error.message : "Try again");
    }
  };

  const complete = async () => {
    if (!job || pin.length < 4) return;
    try {
      const data = await api("/api/deliveries/" + job.id + "/complete", { driverId: DRIVER_ID, receiverPin: pin });
      setJob(data); setStatus(data.status); setTracking(false);
      Alert.alert("Delivered", "Receiver PIN verified. Delivery completed.");
    } catch (error) {
      Alert.alert("Verification failed", error instanceof Error ? error.message : "Invalid PIN");
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.logo}>SwiftDrop</Text>
        <Text style={styles.heading}>Driver</Text>
        <Text style={styles.status}>{status.replaceAll("_", " ")}</Text>

        {!online && !job ? (
          <Pressable style={styles.primary} onPress={() => void goOnline()}>
            <Text style={styles.primaryText}>Go online</Text>
          </Pressable>
        ) : null}

        {online && !job ? (
          <View style={styles.card}>
            <Text style={styles.title}>Nearby delivery jobs</Text>
            <Pressable style={styles.secondary} onPress={() => void refreshJobs()}>
              <Text>Refresh jobs</Text>
            </Pressable>
            {jobs.length === 0 ? <Text style={styles.muted}>No available jobs yet.</Text> : null}
            {jobs.map(item => (
              <View key={item.id} style={styles.job}>
                <Text style={styles.title}>{item.trackingCode}</Text>
                <Text>{item.pickup.formattedAddress}</Text>
                <Text>→ {item.dropoff.formattedAddress}</Text>
                <Pressable style={styles.primary} onPress={() => void acceptJob(item)}>
                  <Text style={styles.primaryText}>Accept delivery</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        {job ? (
          <View style={styles.card}>
            <Text style={styles.title}>Delivery {job.trackingCode}</Text>
            <Text>Pickup: {job.pickup.formattedAddress}</Text>
            <Text>Drop-off: {job.dropoff.formattedAddress}</Text>

            {job.status === "DRIVER_ASSIGNED" ? (
              <Pressable style={styles.primary} onPress={() => void atPickup()}>
                <Text style={styles.primaryText}>I am at pickup</Text>
              </Pressable>
            ) : null}

            {job.status === "DRIVER_AT_PICKUP" ? (
              <>
                <Text style={styles.muted}>Parcel photo is mandatory before pickup confirmation.</Text>
                <TextInput value={photoUrl} onChangeText={setPhotoUrl} placeholder="Parcel photo URL (temporary)" style={styles.input} />
                <Pressable style={styles.primary} onPress={() => void confirmPickup()}>
                  <Text style={styles.primaryText}>Confirm parcel pickup</Text>
                </Pressable>
              </>
            ) : null}

            {job.status === "PICKED_UP" ? (
              <Pressable style={styles.primary} onPress={() => void startTrip()}>
                <Text style={styles.primaryText}>Start trip & share location</Text>
              </Pressable>
            ) : null}

            {job.status === "IN_TRANSIT" ? (
              <Pressable style={styles.primary} onPress={() => void markArrived()}>
                <Text style={styles.primaryText}>I have arrived</Text>
              </Pressable>
            ) : null}

            {job.status === "ARRIVED" ? (
              <>
                <Text style={styles.muted}>Ask the receiver for the SwiftDrop delivery PIN.</Text>
                <TextInput value={pin} onChangeText={setPin} keyboardType="number-pad" placeholder="Receiver PIN" style={styles.input} maxLength={6} />
                <Pressable style={styles.primary} onPress={() => void complete()}>
                  <Text style={styles.primaryText}>Verify PIN & complete</Text>
                </Pressable>
              </>
            ) : null}

            {job.status === "DELIVERED" ? <Text style={styles.done}>✓ Delivery completed</Text> : null}
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fff" },
  container: { flex: 1, padding: 20, gap: 14 },
  logo: { fontSize: 30, fontWeight: "800", marginTop: 12 },
  heading: { fontSize: 18, fontWeight: "600" },
  status: { fontSize: 15, fontWeight: "700" },
  card: { borderWidth: 1, borderColor: "#ddd", borderRadius: 16, padding: 16, gap: 12 },
  title: { fontSize: 18, fontWeight: "700" },
  muted: { color: "#666" },
  job: { borderTopWidth: 1, borderTopColor: "#eee", paddingTop: 12, gap: 8 },
  primary: { backgroundColor: "#111", padding: 15, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontWeight: "700" },
  secondary: { borderWidth: 1, borderColor: "#ccc", padding: 13, borderRadius: 10, alignItems: "center" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 10, padding: 13 },
  done: { fontSize: 18, fontWeight: "800" }
});

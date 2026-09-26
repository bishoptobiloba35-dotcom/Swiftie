import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView, View, Text, Pressable, StyleSheet, Alert, TextInput, Image } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";
const BACKGROUND_LOCATION_TASK = "SWIFTDROP_BACKGROUND_LOCATION";

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations ?? [];
  const activeDeliveryId = await getActiveDeliveryId();
  if (!activeDeliveryId) return;
  for (const location of locations) {
    try {
      await api("/api/deliveries/" + activeDeliveryId + "/location", {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracyMeters: location.coords.accuracy
      });
    } catch {}
  }
});

async function getActiveDeliveryId(): Promise<string | null> {
  return AsyncStorage.getItem("swiftdrop.activeDeliveryId");
}

async function setActiveDeliveryId(id: string | null): Promise<void> {
  if (id) await AsyncStorage.setItem("swiftdrop.activeDeliveryId", id);
  else await AsyncStorage.removeItem("swiftdrop.activeDeliveryId");
}

async function startBackgroundTracking(): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (!started) {
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: 5000,
      distanceInterval: 10,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: "SwiftDrop delivery tracking",
        notificationBody: "Your active delivery is being tracked."
      }
    });
  }
}

async function stopBackgroundTracking(): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (started) await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
}



type Job = {
  id: string; trackingCode: string;
  pickup: { label: string; formattedAddress: string };
  dropoff: { label: string; formattedAddress: string };
  receiverName: string; status: string;
};

async function getDriverToken(): Promise<string> {
  const existing = await AsyncStorage.getItem("swiftdrop.driverAccessToken");
  if (existing) return existing;
  throw new Error("Please sign in to SwiftDrop Driver first.");
}

async function getDriverId(): Promise<string> {
  const stored = await AsyncStorage.getItem("swiftdrop.driverId");
  if (stored) return stored;
  const data = await api("/api/driver/me");
  await AsyncStorage.setItem("swiftdrop.driverId", data.driver.id);
  return data.driver.id;
}

async function api(path: string, body?: unknown) {
  const token = await getDriverToken();
  const response = await fetch(API_URL + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export default function App() {
  const [signedIn, setSignedIn] = React.useState(false);
  const [authPhone, setAuthPhone] = React.useState("");
  const [authPassword, setAuthPassword] = React.useState("");
  const [online, setOnline] = React.useState(false);
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [job, setJob] = React.useState<Job | null>(null);
  const [status, setStatus] = React.useState("OFFLINE");
  const [photoUrl, setPhotoUrl] = React.useState("");
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [cameraRef, setCameraRef] = React.useState<CameraView | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [pin, setPin] = React.useState("");
  const [tracking, setTracking] = React.useState(false);

  const refreshJobs = async () => {
    try {
      const data = await api("/api/driver/" + await getDriverId() + "/jobs");
      setJobs(data.jobs);
    } catch (error) {
      Alert.alert("SwiftDrop", error instanceof Error ? error.message : "Could not load jobs");
    }
  };

  const goOnline = async () => {
    try {
      await api("/api/driver/availability", { online: true });
      setOnline(true);
      setStatus("ONLINE");
      const assignment = await api("/api/driver/auto-assign", {});
      if (assignment?.delivery) {
        setJob(assignment.delivery);
        setStatus(assignment.delivery.status);
        await setActiveDeliveryId(assignment.delivery.id);
      }
      await refreshJobs();
    } catch (error) {
      setOnline(false);
      Alert.alert("SwiftDrop", error instanceof Error ? error.message : "Could not go online");
    }
  };

  const goOffline = async () => {
    try {
      await api("/api/driver/availability", { online: false });
    } finally {
      setOnline(false);
      setStatus("OFFLINE");
    }
  };

  const acceptJob = async (selected: Job) => {
    try {
      const data = await api("/api/deliveries/" + selected.id + "/accept", {});
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

  const openCamera = async () => {
    if (!cameraPermission?.granted) {
      const permission = await requestCameraPermission();
      if (!permission.granted) {
        Alert.alert("Camera permission", "SwiftDrop needs camera access to record the parcel condition.");
        return;
      }
    }
    setCameraOpen(true);
  };

  const capturePhoto = async () => {
    if (!cameraRef) return;
    const photo = await cameraRef.takePictureAsync({ base64: true, quality: 0.7 });
    if (!photo.base64) {
      Alert.alert("Camera", "Could not capture the parcel photo.");
      return;
    }
    setPhotoUrl("data:image/jpeg;base64," + photo.base64);
    setCameraOpen(false);
  };

  const confirmPickup = async () => {
    if (!job) return;
    if (!photoUrl.trim()) {
      Alert.alert("Parcel photo required", "Take a parcel photo before confirming pickup.");
      return;
    }
    try {
      const upload = await api("/api/uploads/pickup-photo", { image: photoUrl });
      const data = await api("/api/deliveries/" + job.id + "/pickup", { pickupPhotoUrl: upload.url });
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
      await setActiveDeliveryId(data.id);
      const foreground = await Location.requestForegroundPermissionsAsync();
      if (!foreground.granted) {
        Alert.alert("Location permission", "SwiftDrop needs location access to track the active delivery.");
        return;
      }
      const background = await Location.requestBackgroundPermissionsAsync();
      if (!background.granted) {
        Alert.alert("Background tracking", "Background location was not granted. SwiftDrop will continue tracking while this screen is open.");
      } else {
        await startBackgroundTracking();
      }
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
    async function signIn() {
    try {
      const response = await fetch(API_URL + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: authPhone, password: authPassword })
      });
      const data = await response.json();
      if (!response.ok || data.user?.role !== "DRIVER") throw new Error(data.error ?? "Driver sign in failed");
      await AsyncStorage.setItem("swiftdrop.driverAccessToken", data.accessToken);
      setSignedIn(true);
    } catch (error) {
      Alert.alert("Sign in failed", error instanceof Error ? error.message : "Unable to sign in");
    }
  }

  if (!signedIn) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.title}>SwiftDrop Driver</Text>
        <Text style={styles.subtitle}>Sign in to go online and receive deliveries.</Text>
        <TextInput style={styles.input} placeholder="Phone number" value={authPhone} onChangeText={setAuthPhone} keyboardType="phone-pad" />
        <TextInput style={styles.input} placeholder="Password" value={authPassword} onChangeText={setAuthPassword} secureTextEntry />
        <Pressable style={styles.button} onPress={signIn}><Text style={styles.buttonText}>Sign in</Text></Pressable>
      </SafeAreaView>
    );
  }

  return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [tracking, job?.id]);

  const markArrived = async () => {
    if (!job) return;
    try {
      const data = await api("/api/deliveries/" + job.id + "/arrived", { driverId: DRIVER_ID });
      setJob(data); setStatus(data.status); setTracking(false);\n      await stopBackgroundTracking();\n      await setActiveDeliveryId(null);
    } catch (error) {
      Alert.alert("Arrival", error instanceof Error ? error.message : "Try again");
    }
  };

  const complete = async () => {
    if (!job || pin.length < 4) return;
    try {
      const data = await api("/api/deliveries/" + job.id + "/complete", { receiverPin: pin });
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

        {cameraOpen ? (
          <View style={styles.cameraCard}>
            <CameraView ref={setCameraRef} style={styles.camera} facing="back" />
            <Pressable style={styles.primary} onPress={() => void capturePhoto()}><Text style={styles.primaryText}>Capture photo</Text></Pressable>
            <Pressable style={styles.secondary} onPress={() => setCameraOpen(false)}><Text>Cancel</Text></Pressable>
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
                {photoUrl ? <Image source={{ uri: photoUrl }} style={styles.preview} /> : null}
                <Pressable style={styles.secondary} onPress={() => void openCamera()}><Text>{photoUrl ? "Retake parcel photo" : "Take parcel photo"}</Text></Pressable>
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
  done: { fontSize: 18, fontWeight: "800" },
  preview: { width: "100%", height: 220, borderRadius: 12 },
  cameraCard: { flex: 1, gap: 12 },
  camera: { flex: 1, minHeight: 420, borderRadius: 16, overflow: "hidden" }
});

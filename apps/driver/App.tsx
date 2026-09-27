import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView, View, Text, Pressable, StyleSheet, Alert, TextInput, Image, Platform, ScrollView } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";
const BACKGROUND_LOCATION_TASK = "SWIFTDROP_BACKGROUND_LOCATION";

async function getDriverToken(): Promise<string> {
  const token = await AsyncStorage.getItem("swiftdrop.driverAccessToken");
  if (!token) throw new Error("Please sign in to SwiftDrop Driver first.");
  return token;
}

async function driverApi(path: string, body?: unknown) {
  const token = await getDriverToken();
  const response = await fetch(API_URL + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

async function getActiveDeliveryId(): Promise<string | null> {
  return AsyncStorage.getItem("swiftdrop.activeDeliveryId");
}

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations ?? [];
  const deliveryId = await getActiveDeliveryId();
  if (!deliveryId) return;
  for (const location of locations) {
    try {
      await driverApi("/api/deliveries/" + deliveryId + "/location", {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracyMeters: location.coords.accuracy
      });
    } catch {}
  }
});

async function setActiveDeliveryId(id: string | null): Promise<void> {
  if (id) await AsyncStorage.setItem("swiftdrop.activeDeliveryId", id);
  else await AsyncStorage.removeItem("swiftdrop.activeDeliveryId");
}

async function startBackgroundTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) return;
  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 5000,
    distanceInterval: 10,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "SwiftDrop delivery tracking",
      notificationBody: "Your active delivery location is being shared."
    }
  });
}

async function stopBackgroundTracking(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
}

type Job = {
  id: string;
  trackingCode: string;
  pickup: { label: string; formattedAddress: string };
  dropoff: { label: string; formattedAddress: string };
  receiverName: string;
  status: string;
};

type NotificationItem = {
  id: string;
  title: string;
  body: string;
  type: string;
  read_at?: string | null;
  created_at: string;
};

export default function App() {
  const [signedIn, setSignedIn] = React.useState(false);
  const [authMode, setAuthMode] = React.useState<"login" | "register">("login");
  const [authPhone, setAuthPhone] = React.useState("");
  const [authPassword, setAuthPassword] = React.useState("");
  const [authName, setAuthName] = React.useState("");
  const [authEmail, setAuthEmail] = React.useState("");
  const [driverApproved, setDriverApproved] = React.useState(false);
  const [documentType, setDocumentType] = React.useState("DRIVER_LICENSE");
  const [documentUrl, setDocumentUrl] = React.useState("");
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
  const [notifications, setNotifications] = React.useState<NotificationItem[]>([]);
  const [showNotifications, setShowNotifications] = React.useState(false);
  const [ratingStars, setRatingStars] = React.useState(0);
  const [ratingComment, setRatingComment] = React.useState("");
  const [ratingSubmitted, setRatingSubmitted] = React.useState(false);
  const [payout, setPayout] = React.useState<{ amount_minor: number; currency: string; status: string } | null>(null);

  async function registerPushNotifications() {
    try {
      const permission = await Notifications.getPermissionsAsync();
      let status = permission.status;
      if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
      if (status !== "granted") return;
      const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
      const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      await driverApi("/api/notifications/device-token", {
        token: token.data,
        platform: Platform.OS === "ios" ? "IOS" : "ANDROID"
      });
    } catch {}
  }

  async function loadNotifications() {
    try {
      const data = await driverApi("/api/notifications");
      setNotifications(data.notifications ?? []);
    } catch {}
  }

  async function markNotificationRead(id: string) {
    try {
      await driverApi("/api/notifications/" + encodeURIComponent(id) + "/read", {});
      setNotifications(items => items.map(item => item.id === id ? { ...item, read_at: new Date().toISOString() } : item));
    } catch {}
  }

  async function refreshDriverState() {
    try {
      const data = await driverApi("/api/driver/me");
      setDriverApproved(data.driver?.status === "APPROVED");
      if (data.driver?.status === "APPROVED") {
        const docs = await driverApi("/api/driver/documents");
        setDriverApproved(Boolean(docs.documents?.some((d: { status: string }) => d.status === "APPROVED")));
      }
      await loadNotifications();
    } catch {}
  }

  React.useEffect(() => {
    AsyncStorage.getItem("swiftdrop.driverAccessToken").then(async token => {
      if (!token) return;
      setSignedIn(true);
      await refreshDriverState();
      void registerPushNotifications();
    });
    return () => { void stopBackgroundTracking().catch(() => {}); };
  }, []);

  async function signIn() {
    try {
      const response = await fetch(API_URL + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: authPhone.trim(), password: authPassword })
      });
      const data = await response.json();
      if (!response.ok || data.user?.role !== "DRIVER") throw new Error(data.error ?? "Driver sign in failed");
      await AsyncStorage.setItem("swiftdrop.driverAccessToken", data.accessToken);
      setSignedIn(true);
      await refreshDriverState();
      void registerPushNotifications();
    } catch (error) {
      Alert.alert("Sign in failed", error instanceof Error ? error.message : "Unable to sign in");
    }
  }

  async function registerDriver() {
    try {
      const response = await fetch(API_URL + "/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullName: authName.trim(),
          phone: authPhone.trim(),
          email: authEmail.trim() || undefined,
          password: authPassword,
          role: "DRIVER"
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Driver registration failed");
      await AsyncStorage.setItem("swiftdrop.driverAccessToken", data.accessToken);
      setSignedIn(true);
      setDriverApproved(false);
      void registerPushNotifications();
    } catch (error) {
      Alert.alert("Registration failed", error instanceof Error ? error.message : "Unable to register");
    }
  }

  async function submitKyc() {
    if (!documentType.trim() || !documentUrl.trim()) {
      Alert.alert("KYC", "Document type and secure document URL are required.");
      return;
    }
    try {
      await driverApi("/api/driver/documents", { documentType: documentType.trim(), documentUrl: documentUrl.trim() });
      Alert.alert("KYC submitted", "Your document is pending admin review.");
      await refreshDriverState();
    } catch (error) {
      Alert.alert("KYC submission failed", error instanceof Error ? error.message : "Unable to submit document");
    }
  }

  async function refreshJobs() {
    try {
      const driver = await driverApi("/api/driver/me");
      const data = await driverApi("/api/driver/" + driver.driver.id + "/jobs");
      setJobs(data.jobs ?? []);
    } catch (error) {
      Alert.alert("SwiftDrop", error instanceof Error ? error.message : "Could not load jobs");
    }
  }

  async function goOnline() {
    try {
      await driverApi("/api/driver/availability", { online: true });
      setOnline(true);
      setStatus("ONLINE");
      const assignment = await driverApi("/api/driver/auto-assign", {});
      if (assignment?.delivery) {
        setJob(assignment.delivery);
        setStatus(assignment.delivery.status);
        await setActiveDeliveryId(assignment.delivery.id);
      }
      await refreshJobs();
    } catch (error) {
      Alert.alert("SwiftDrop", error instanceof Error ? error.message : "Could not go online");
    }
  }

  async function goOffline() {
    try { await driverApi("/api/driver/availability", { online: false }); }
    catch {}
    setOnline(false);
    setStatus("OFFLINE");
  }

  async function acceptJob(selected: Job) {
    try {
      const data = await driverApi("/api/deliveries/" + selected.id + "/accept", {});
      setJob(data);
      setStatus(data.status);
      await setActiveDeliveryId(data.id);
      await refreshJobs();
    } catch (error) {
      Alert.alert("Unable to accept", error instanceof Error ? error.message : "Try again");
    }
  }

  async function atPickup() {
    if (!job) return;
    try {
      const data = await driverApi("/api/deliveries/" + job.id + "/at-pickup", {});
      setJob(data); setStatus(data.status);
    } catch (error) {
      Alert.alert("Pickup", error instanceof Error ? error.message : "Try again");
    }
  }

  async function openCamera() {
    if (!cameraPermission?.granted) {
      const permission = await requestCameraPermission();
      if (!permission.granted) {
        Alert.alert("Camera permission", "SwiftDrop needs camera access to record the parcel condition.");
        return;
      }
    }
    setCameraOpen(true);
  }

  async function capturePhoto() {
    if (!cameraRef) return;
    const photo = await cameraRef.takePictureAsync({ base64: true, quality: 0.7 });
    if (!photo.base64) {
      Alert.alert("Camera", "Could not capture the parcel photo.");
      return;
    }
    setPhotoUrl("data:image/jpeg;base64," + photo.base64);
    setCameraOpen(false);
  }

  async function confirmPickup() {
    if (!job || !photoUrl) return;
    try {
      const upload = await driverApi("/api/uploads/pickup-photo", { image: photoUrl });
      const data = await driverApi("/api/deliveries/" + job.id + "/pickup", { pickupPhotoUrl: upload.url });
      setJob(data); setStatus(data.status); setPhotoUrl("");
    } catch (error) {
      Alert.alert("Pickup", error instanceof Error ? error.message : "Try again");
    }
  }

  async function startTrip() {
    if (!job) return;
    try {
      const data = await driverApi("/api/deliveries/" + job.id + "/start-trip", {});
      setJob(data); setStatus(data.status);
      await setActiveDeliveryId(data.id);
      const foreground = await Location.requestForegroundPermissionsAsync();
      if (!foreground.granted) throw new Error("Location permission is required for delivery tracking.");
      const background = await Location.requestBackgroundPermissionsAsync();
      if (background.granted) await startBackgroundTracking();
      setTracking(true);
    } catch (error) {
      Alert.alert("Trip", error instanceof Error ? error.message : "Unable to start tracking");
    }
  }

  React.useEffect(() => {
    if (!tracking || !job) return;
    let subscription: Location.LocationSubscription | undefined;
    let cancelled = false;
    void (async () => {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) return;
      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 10 },
        async location => {
          if (cancelled) return;
          try {
            await driverApi("/api/deliveries/" + job.id + "/location", {
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
              accuracyMeters: location.coords.accuracy
            });
          } catch {}
        }
      );
    })();
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [tracking, job?.id]);

  async function markArrived() {
    if (!job) return;
    try {
      const data = await driverApi("/api/deliveries/" + job.id + "/arrived", {});
      setJob(data); setStatus(data.status); setTracking(false);
      await stopBackgroundTracking();
      await setActiveDeliveryId(null);
    } catch (error) {
      Alert.alert("Arrival", error instanceof Error ? error.message : "Try again");
    }
  }

  async function loadPayout(deliveryId: string) {
    try {
      const data = await driverApi("/api/deliveries/" + deliveryId + "/payout");
      setPayout(data.payout ?? null);
    } catch {
      setPayout(null);
    }
  }

  async function submitSenderRating() {
    if (!job || ratingStars < 1) {
      Alert.alert("Rating", "Please select a rating from 1 to 5 stars.");
      return;
    }
    try {
      await driverApi("/api/deliveries/" + job.id + "/rating/driver", {
        stars: ratingStars,
        comment: ratingComment.trim() || undefined
      });
      setRatingSubmitted(true);
      Alert.alert("Thank you", "Your sender rating has been saved.");
    } catch (error) {
      Alert.alert("Rating failed", error instanceof Error ? error.message : "Unable to save rating");
    }
  }

  async function complete() {
    if (!job || pin.length !== 6) return;
    try {
      const data = await driverApi("/api/deliveries/" + job.id + "/complete", { receiverPin: pin });
      setJob(data); setStatus(data.status); setTracking(false); setPin("");
      await stopBackgroundTracking();
      await setActiveDeliveryId(null);
      await loadPayout(data.id);
      Alert.alert("Delivered", "Receiver PIN verified. Delivery completed.");
    } catch (error) {
      Alert.alert("Verification failed", error instanceof Error ? error.message : "Invalid PIN");
    }
  }

  if (!signedIn) {
    return <SafeAreaView style={styles.safe}><View style={styles.auth}>
      <Text style={styles.logo}>SwiftDrop Driver</Text>
      <Text style={styles.subtitle}>{authMode === "login" ? "Sign in to receive deliveries." : "Create your driver account."}</Text>
      {authMode === "register" && <TextInput style={styles.input} placeholder="Full name" value={authName} onChangeText={setAuthName} />}
      <TextInput style={styles.input} placeholder="Phone number" value={authPhone} onChangeText={setAuthPhone} keyboardType="phone-pad" />
      {authMode === "register" && <TextInput style={styles.input} placeholder="Email (optional)" value={authEmail} onChangeText={setAuthEmail} keyboardType="email-address" autoCapitalize="none" />}
      <TextInput style={styles.input} placeholder="Password" value={authPassword} onChangeText={setAuthPassword} secureTextEntry />
      <Pressable style={styles.primary} onPress={() => void (authMode === "login" ? signIn() : registerDriver())}><Text style={styles.primaryText}>{authMode === "login" ? "Sign in" : "Create driver account"}</Text></Pressable>
      <Pressable onPress={() => setAuthMode(authMode === "login" ? "register" : "login")}><Text style={styles.link}>{authMode === "login" ? "Create a driver account" : "Already have an account? Sign in"}</Text></Pressable>
    </View></SafeAreaView>;
  }

  if (!driverApproved) {
    return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.auth}>
      <Text style={styles.logo}>Driver verification</Text>
      <Text style={styles.subtitle}>At least one KYC document must be approved before you can go online.</Text>
      <TextInput style={styles.input} placeholder="Document type (e.g. DRIVER_LICENSE)" value={documentType} onChangeText={setDocumentType} />
      <TextInput style={styles.input} placeholder="Secure document URL" value={documentUrl} onChangeText={setDocumentUrl} autoCapitalize="none" />
      <Pressable style={styles.primary} onPress={() => void submitKyc()}><Text style={styles.primaryText}>Submit document</Text></Pressable>
      <Pressable style={styles.secondary} onPress={() => void refreshDriverState()}><Text>Check verification status</Text></Pressable>
    </ScrollView></SafeAreaView>;
  }

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.container}>
    <View style={styles.header}><View><Text style={styles.logo}>SwiftDrop Driver</Text><Text style={styles.subtitle}>Deliver safely. Track every trip.</Text></View><Pressable onPress={() => setShowNotifications(v => !v)}><Text style={styles.link}>Alerts {notifications.filter(n => !n.read_at).length ? "•" : ""}</Text></Pressable></View>

    {payout && <View style={styles.card}>
      <Text style={styles.title}>Delivery payout</Text>
      <Text style={styles.earnings}>₦{(payout.amount_minor / 100).toLocaleString()}</Text>
      <Text style={styles.muted}>Status: {payout.status.replaceAll("_", " ")}</Text>
    </View>}

    {showNotifications && <View style={styles.card}>
      <View style={styles.header}><Text style={styles.title}>Notifications</Text><Pressable onPress={() => void loadNotifications()}><Text>Refresh</Text></Pressable></View>
      {notifications.length === 0 ? <Text style={styles.muted}>No notifications.</Text> : notifications.map(item => (
        <Pressable key={item.id} style={styles.notification} onPress={() => void markNotificationRead(item.id)}>
          <Text style={styles.notificationTitle}>{item.title}</Text>
          <Text>{item.body}</Text>
          <Text style={styles.muted}>{new Date(item.created_at).toLocaleString()} · {item.read_at ? "Read" : "Tap to mark read"}</Text>
        </Pressable>
      ))}
    </View>}

    <Text style={styles.status}>{status.replaceAll("_", " ")}</Text>
    {job?.status === "DELIVERED" && <View style={styles.card}>
      <Text style={styles.title}>Rate the sender</Text>
      {ratingSubmitted ? <Text style={styles.done}>✓ Rating submitted</Text> : <>
        <View style={styles.starRow}>{[1,2,3,4,5].map(star => <Pressable key={star} onPress={() => setRatingStars(star)}><Text style={styles.star}>{star <= ratingStars ? "★" : "☆"}</Text></Pressable>)}</View>
        <TextInput style={styles.input} placeholder="Optional comment" value={ratingComment} onChangeText={setRatingComment} maxLength={500} multiline />
        <Pressable style={styles.primary} onPress={() => void submitSenderRating()}><Text style={styles.primaryText}>Submit sender rating</Text></Pressable>
      </>}
    </View>}


    {!online && !job ? <Pressable style={styles.primary} onPress={() => void goOnline()}><Text style={styles.primaryText}>Go online</Text></Pressable> : null}
    {online && !job ? <View style={styles.card}>
      <Text style={styles.title}>Available delivery jobs</Text>
      <Pressable style={styles.secondary} onPress={() => void refreshJobs()}><Text>Refresh jobs</Text></Pressable>
      {jobs.length === 0 ? <Text style={styles.muted}>No available jobs yet.</Text> : jobs.map(item => <View key={item.id} style={styles.job}>
        <Text style={styles.title}>{item.trackingCode}</Text><Text>{item.pickup.formattedAddress}</Text><Text>→ {item.dropoff.formattedAddress}</Text>
        <Pressable style={styles.primary} onPress={() => void acceptJob(item)}><Text style={styles.primaryText}>Accept delivery</Text></Pressable>
      </View>)}
      <Pressable style={styles.secondary} onPress={() => void goOffline()}><Text>Go offline</Text></Pressable>
    </View> : null}

    {cameraOpen && <View style={styles.cameraCard}><CameraView ref={setCameraRef} style={styles.camera} facing="back" /><Pressable style={styles.primary} onPress={() => void capturePhoto()}><Text style={styles.primaryText}>Capture parcel photo</Text></Pressable><Pressable style={styles.secondary} onPress={() => setCameraOpen(false)}><Text>Cancel</Text></Pressable></View>}

    {job && <View style={styles.card}>
      <Text style={styles.title}>Delivery {job.trackingCode}</Text>
      <Text>Pickup: {job.pickup.formattedAddress}</Text><Text>Drop-off: {job.dropoff.formattedAddress}</Text>
      {job.status === "DRIVER_ASSIGNED" && <Pressable style={styles.primary} onPress={() => void atPickup()}><Text style={styles.primaryText}>I am at pickup</Text></Pressable>}
      {job.status === "DRIVER_AT_PICKUP" && <>
        <Text style={styles.muted}>Parcel photo is mandatory before pickup confirmation.</Text>
        {photoUrl ? <Image source={{ uri: photoUrl }} style={styles.preview} /> : null}
        <Pressable style={styles.secondary} onPress={() => void openCamera()}><Text>{photoUrl ? "Retake parcel photo" : "Take parcel photo"}</Text></Pressable>
        <Pressable style={styles.primary} onPress={() => void confirmPickup()}><Text style={styles.primaryText}>Confirm parcel pickup</Text></Pressable>
      </>}
      {job.status === "PICKED_UP" && <Pressable style={styles.primary} onPress={() => void startTrip()}><Text style={styles.primaryText}>Start trip & share location</Text></Pressable>}
      {job.status === "IN_TRANSIT" && <Pressable style={styles.primary} onPress={() => void markArrived()}><Text style={styles.primaryText}>I have arrived</Text></Pressable>}
      {job.status === "ARRIVED" && <>
        <Text style={styles.muted}>Ask the receiver for the six-digit SwiftDrop PIN.</Text>
        <TextInput value={pin} onChangeText={setPin} keyboardType="number-pad" placeholder="Receiver PIN" style={styles.input} maxLength={6} />
        <Pressable style={styles.primary} onPress={() => void complete()}><Text style={styles.primaryText}>Verify PIN & complete</Text></Pressable>
      </>}
      {job.status === "DELIVERED" && <Text style={styles.done}>✓ Delivery completed</Text>}
    </View>}
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:"#fff"}, auth:{flex:1,padding:24,justifyContent:"center",gap:14}, container:{padding:20,gap:14},
  header:{flexDirection:"row",justifyContent:"space-between",alignItems:"center"}, logo:{fontSize:28,fontWeight:"800",marginTop:8},
  subtitle:{fontSize:14,color:"#666"}, title:{fontSize:18,fontWeight:"700"}, status:{fontSize:18,fontWeight:"800"},
  card:{borderWidth:1,borderColor:"#ddd",borderRadius:16,padding:16,gap:12}, input:{borderWidth:1,borderColor:"#ccc",borderRadius:10,padding:13},
  primary:{backgroundColor:"#111",padding:15,borderRadius:12,alignItems:"center"}, primaryText:{color:"#fff",fontWeight:"700"},
  secondary:{borderWidth:1,borderColor:"#ccc",padding:13,borderRadius:10,alignItems:"center"}, link:{fontWeight:"700"},
  muted:{color:"#666"}, job:{borderTopWidth:1,borderTopColor:"#eee",paddingTop:12,gap:8}, done:{fontSize:18,fontWeight:"800"},
  preview:{width:"100%",height:220,borderRadius:12}, cameraCard:{gap:12}, camera:{height:420,borderRadius:16,overflow:"hidden"},
  notification:{borderTopWidth:1,borderTopColor:"#eee",paddingTop:10,gap:4}, notificationTitle:{fontWeight:"800"}
});

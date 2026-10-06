import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView, View, Text, Pressable, StyleSheet, Alert, TextInput, Image, Platform, ScrollView } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";

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
  const [legalConsent, setLegalConsent] = React.useState(false);
  const [authName, setAuthName] = React.useState("");
  const [authEmail, setAuthEmail] = React.useState("");
  const [driverApproved, setDriverApproved] = React.useState(false);
  const [documentType, setDocumentType] = React.useState("DRIVER_LICENSE");
  const [documentUrl, setDocumentUrl] = React.useState("");
  const [documentFile, setDocumentFile] = React.useState<{ name: string; mimeType: string; uri: string } | null>(null);
  const [documentUploading, setDocumentUploading] = React.useState(false);
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
  const [payout, setPayout] = React.useState<{ amount_minor: number; currency: string; status: string; provider_status?: string | null; failure_reason?: string | null } | null>(null);
  const [payoutSummary, setPayoutSummary] = React.useState<{ eligibleMinor: number; processingMinor: number; releasedMinor: number; failedMinor: number }>({ eligibleMinor: 0, processingMinor: 0, releasedMinor: 0, failedMinor: 0 });
  const [payoutHistory, setPayoutHistory] = React.useState<Array<{ id: string; amount_minor: number; currency: string; status: string; failure_reason?: string | null }>>([]);
  const [payoutAccount, setPayoutAccount] = React.useState<{ bankCode: string; bankName?: string | null; accountName: string; accountLast4: string; recipientCode: string } | null>(null);
  const [bankCode, setBankCode] = React.useState("");
  const [accountNumber, setAccountNumber] = React.useState("");
  const [showSupport, setShowSupport] = React.useState(false);
  const [supportCategory, setSupportCategory] = React.useState<"ORDER"|"APP">("ORDER");
  const [supportSubject, setSupportSubject] = React.useState("");
  const [supportMessage, setSupportMessage] = React.useState("");
  const [supportTickets, setSupportTickets] = React.useState<Array<{
    id: string;
    subject: string;
    message: string;
    status: string;
    createdAt?: string;
    updatedAt?: string;
    messages?: Array<{ id: string; senderType: "USER" | "AI" | "ADMIN"; message: string; createdAt: string }>;
  }>>([]);
  const [showFailure, setShowFailure] = React.useState(false);
  const [failureReason, setFailureReason] = React.useState("RECIPIENT_UNAVAILABLE");
  const [failureNotes, setFailureNotes] = React.useState("");

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

  async function loadPayoutHistory() {
    try {
      const data = await driverApi("/api/driver/payouts");
      setPayoutSummary(data.summary ?? { eligibleMinor: 0, processingMinor: 0, releasedMinor: 0, failedMinor: 0 });
      setPayoutHistory(data.payouts ?? []);
    } catch {}
  }

  async function loadPayoutAccount() {
    try {
      const data = await driverApi("/api/driver/payout-account");
      setPayoutAccount(data.account ?? null);
    } catch {}
  }

  async function savePayoutAccount() {
    if (!/^\d{3,6}$/.test(bankCode.trim()) || !/^\d{10}$/.test(accountNumber.trim())) {
      Alert.alert("Payout account", "Enter a valid bank code and 10-digit Nigerian account number.");
      return;
    }
    try {
      const data = await driverApi("/api/driver/payout-account", { bankCode: bankCode.trim(), accountNumber: accountNumber.trim() });
      setPayoutAccount(data.account);
      setAccountNumber("");
      Alert.alert("Payout account verified", data.account?.accountName ? "Paystack verified the account as " + data.account.accountName + "." : "Your payout account is ready.");
    } catch (error) {
      Alert.alert("Payout account", error instanceof Error ? error.message : "Unable to save payout account.");
    }
  }

  async function withdrawPayout() {
    if (!job?.id) return;
    try {
      const data = await driverApi("/api/deliveries/" + job.id + "/payout/withdraw", {});
      setPayout(data.payout ?? null);
      await loadPayoutHistory();
      Alert.alert("Withdrawal started", "The transfer has been initiated. Your payout will change to Released after Paystack confirms the transfer.");
    } catch (error) {
      Alert.alert("Withdrawal failed", error instanceof Error ? error.message : "Unable to withdraw payout.");
    }
  }

  async function loadSupportTickets() {
    try {
      const data = await driverApi("/api/support/tickets");
      setSupportTickets(data.tickets ?? []);
    } catch {}
  }

  async function submitSupportTicket() {
    try {
      if (supportSubject.trim().length < 3 || supportMessage.trim().length < 5) throw new Error("Enter a clear subject and message.");
      await driverApi("/api/support/tickets", { category: supportCategory, subject: supportSubject.trim(), message: supportMessage.trim(), deliveryId: supportCategory === "ORDER" ? job?.id : undefined });
      setSupportSubject(""); setSupportMessage("");
      await loadSupportTickets();
      Alert.alert("Support request sent", "SwiftDrop support will review your request.");
    } catch (error) { Alert.alert("Support request failed", error instanceof Error ? error.message : "Unable to contact support"); }
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
    if (showSupport) void loadSupportTickets();
  }, [showSupport]);

  React.useEffect(() => {
    AsyncStorage.getItem("swiftdrop.driverAccessToken").then(async token => {
      if (!token) return;
      setSignedIn(true);
      await refreshDriverState();
      await loadPayoutAccount();
      await loadPayoutHistory();
      const current = await driverApi("/api/driver/me");
      const docs = current.driver?.status === "APPROVED" ? await driverApi("/api/driver/documents") : null;
      if (current.driver?.status === "APPROVED" && docs?.documents?.some((d: { status: string }) => d.status === "APPROVED")) await goOnline();
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
      await loadPayoutAccount();
      const current = await driverApi("/api/driver/me");
      if (current.driver?.status === "APPROVED") {
        const docs = await driverApi("/api/driver/documents");
        if (docs.documents?.some((d: { status: string }) => d.status === "APPROVED")) {
          await goOnline();
        }
      }
      void registerPushNotifications();
    } catch (error) {
      Alert.alert("Sign in failed", error instanceof Error ? error.message : "Unable to sign in");
    }
  }

  async function registerDriver() {
    try {
      if (!legalConsent) throw new Error("Please accept the Terms, Privacy Notice, and Acceptable Use Policy to create a driver account.");
      const response = await fetch(API_URL + "/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullName: authName.trim(),
          phone: authPhone.trim(),
          email: authEmail.trim() || undefined,
          password: authPassword,
          role: "DRIVER",
          termsAccepted: true,
          privacyAccepted: true,
          acceptableUseAccepted: true
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

  async function pickKycDocument() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/jpeg", "image/png"],
      copyToCacheDirectory: true,
      multiple: false
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if ((asset.size ?? 0) > 10 * 1024 * 1024) {
      Alert.alert("KYC document", "The selected document must be 10MB or smaller.");
      return;
    }
    setDocumentFile({ name: asset.name, mimeType: asset.mimeType ?? "", uri: asset.uri });
  }

  async function submitKyc() {
    if (!documentType.trim() || !documentFile) {
      Alert.alert("KYC", "Choose a document type and document first.");
      return;
    }
    setDocumentUploading(true);
    try {
      const mime = documentFile.mimeType.toLowerCase();
      if (!["application/pdf", "image/jpeg", "image/png"].includes(mime)) throw new Error("Only PDF, JPEG, or PNG documents are supported.");
      const base64 = await FileSystem.readAsStringAsync(documentFile.uri, { encoding: FileSystem.EncodingType.Base64 });
      await driverApi("/api/driver/documents/upload", { documentType: documentType.trim(), file: "data:" + mime + ";base64," + base64 });
      setDocumentFile(null);
      Alert.alert("KYC submitted", "Your document was uploaded and is pending admin review.");
      await refreshDriverState();
    } catch (error) {
      Alert.alert("KYC submission failed", error instanceof Error ? error.message : "Unable to upload document");
    } finally {
      setDocumentUploading(false);
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
      const upload = await driverApi("/api/uploads/pickup-photo", { deliveryId: job.id, image: photoUrl });
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

  React.useEffect(() => {
    if (!job?.id || job.status !== "ARRIVED") return;
    const timer = setInterval(async () => {
      try {
        const data = await driverApi("/api/deliveries/" + job.id);
        setJob(data);
        setStatus(data.status);
        if (data.status === "DELIVERED") {
          setTracking(false);
          await stopBackgroundTracking();
          await setActiveDeliveryId(null);
          await loadPayout(data.id);
        }
      } catch {}
    }, 5000);
    return () => clearInterval(timer);
  }, [job?.id, job?.status]);

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

  async function reportFailedDelivery() {
    if (!job) return;
    try {
      const data = await driverApi("/api/deliveries/" + job.id + "/failure", {
        reason: failureReason,
        notes: failureNotes.trim() || undefined
      });
      setShowFailure(false);
      setFailureNotes("");
      setStatus(data.exceptionStatus);
      Alert.alert("Attempt recorded", "The failed delivery attempt has been recorded. The sender can now reschedule or request a return.");
    } catch (error) {
      Alert.alert("Delivery attempt", error instanceof Error ? error.message : "Unable to record failed delivery");
    }
  }

  async function complete() {
    Alert.alert("Receiver confirmation required", "The receiver must confirm receipt in the SwiftDrop app using the delivery PIN. Courier payout remains held until the receiver confirms.");
  }

  if (!signedIn) {
    return <SafeAreaView style={styles.safe}><View style={styles.auth}>
      <Text style={styles.logo}>SwiftDrop Driver</Text>
      <Text style={styles.subtitle}>{authMode === "login" ? "Sign in to receive deliveries." : "Create your driver account."}</Text>
      {authMode === "register" && <TextInput style={styles.input} placeholder="Full name" value={authName} onChangeText={setAuthName} />}
      <TextInput style={styles.input} placeholder="Phone number" value={authPhone} onChangeText={setAuthPhone} keyboardType="phone-pad" />
      {authMode === "register" && <TextInput style={styles.input} placeholder="Email (optional)" value={authEmail} onChangeText={setAuthEmail} keyboardType="email-address" autoCapitalize="none" />}
      <TextInput style={styles.input} placeholder="Password" value={authPassword} onChangeText={setAuthPassword} secureTextEntry />
      {authMode === "register" && <Pressable onPress={() => setLegalConsent(v => !v)} style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}><Text style={{ fontSize: 20, marginRight: 8 }}>{legalConsent ? "☑" : "☐"}</Text><Text style={{ flex: 1 }}>I accept the SwiftDrop Terms of Service, Privacy Notice, and Acceptable Use Policy.</Text></Pressable>}
      <Pressable style={styles.primary} onPress={() => void (authMode === "login" ? signIn() : registerDriver())}><Text style={styles.primaryText}>{authMode === "login" ? "Sign in" : "Create driver account"}</Text></Pressable>
      <Pressable onPress={() => setAuthMode(authMode === "login" ? "register" : "login")}><Text style={styles.link}>{authMode === "login" ? "Create a driver account" : "Already have an account? Sign in"}</Text></Pressable>
    </View></SafeAreaView>;
  }

  if (!driverApproved) {
    return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.auth}>
      <Text style={styles.logo}>Driver verification</Text>
      <Text style={styles.subtitle}>At least one KYC document must be approved before you can go online.</Text>
      <TextInput style={styles.input} placeholder="Document type (e.g. DRIVER_LICENSE)" value={documentType} onChangeText={setDocumentType} />
      <Pressable style={styles.secondary} onPress={() => void pickKycDocument()}><Text>{documentFile ? "Change selected document" : "Choose KYC document"}</Text></Pressable>
      {documentFile && <View style={styles.fileCard}><Text style={styles.title}>Selected document</Text><Text>{documentFile.name}</Text></View>}
      <Pressable style={styles.primary} disabled={documentUploading} onPress={() => void submitKyc()}><Text style={styles.primaryText}>{documentUploading ? "Uploading…" : "Upload document for review"}</Text></Pressable>
      <Pressable style={styles.secondary} onPress={() => void refreshDriverState()}><Text>Check verification status</Text></Pressable>
    </ScrollView></SafeAreaView>;
  }

  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.container}>
    <View style={styles.header}><View><Text style={styles.logo}>SwiftDrop Driver</Text><Text style={styles.subtitle}>Deliver safely. Track every trip.</Text></View><View style={styles.headerActions}><Pressable onPress={() => setShowNotifications(v => !v)}><Text style={styles.link}>Alerts {notifications.filter(n => !n.read_at).length ? "•" : ""}</Text></Pressable><Pressable onPress={() => setShowSupport(v => !v)}><Text style={styles.link}>Support</Text></Pressable></View></View>

    {showSupport && <View style={styles.card}><View style={styles.header}><Text style={styles.title}>Support</Text><Pressable onPress={() => setShowSupport(false)}><Text style={styles.link}>Close</Text></Pressable></View><Text style={styles.muted}>Get help with a delivery or the SwiftDrop app.</Text><View style={styles.row}><Pressable style={[styles.choice,supportCategory==="ORDER"&&styles.choiceActive]} onPress={()=>setSupportCategory("ORDER")}><Text>Order help</Text></Pressable><Pressable style={[styles.choice,supportCategory==="APP"&&styles.choiceActive]} onPress={()=>setSupportCategory("APP")}><Text>App help</Text></Pressable></View><TextInput style={styles.input} placeholder="Subject" value={supportSubject} onChangeText={setSupportSubject}/><TextInput style={[styles.input,styles.multiline]} placeholder="Describe the issue" value={supportMessage} onChangeText={setSupportMessage} multiline/><Pressable style={styles.primary} onPress={()=>void submitSupportTicket()}><Text style={styles.primaryText}>Contact support</Text></Pressable><View style={styles.supportHistory}><View style={styles.header}><Text style={styles.title}>Your support requests</Text><Pressable onPress={()=>void loadSupportTickets()}><Text style={styles.link}>Refresh</Text></Pressable></View>{supportTickets.length===0 ? <Text style={styles.muted}>No support requests yet.</Text> : supportTickets.map(ticket => <View key={ticket.id} style={styles.supportTicket}><Text style={styles.title}>{ticket.subject}</Text><Text style={styles.muted}>{ticket.status.replaceAll("_"," ")}</Text><Text>{ticket.message}</Text>{ticket.messages?.map(message => <View key={message.id} style={styles.supportMessage}><Text style={styles.muted}>{message.senderType==="AI" ? "SwiftDrop Support AI" : message.senderType==="ADMIN" ? "SwiftDrop Support" : "You"}</Text><Text>{message.message}</Text></View>)}</View>)}</View></View>}

    <View style={styles.card}>
      <Text style={styles.title}>Payout bank account</Text>
      {payoutAccount ? <>
        <Text>{payoutAccount.accountName}</Text>
        <Text style={styles.muted}>Account ending ••••{payoutAccount.accountLast4} · Bank code {payoutAccount.bankCode}</Text>
        <Text style={styles.done}>✓ Verified for Paystack payouts</Text>
      </> : <>
        <Text style={styles.muted}>Add the bank account where your courier earnings should be sent. SwiftDrop verifies the account before saving it.</Text>
        <TextInput style={styles.input} placeholder="Bank code (e.g. 058)" value={bankCode} onChangeText={setBankCode} keyboardType="number-pad" />
        <TextInput style={styles.input} placeholder="10-digit account number" value={accountNumber} onChangeText={setAccountNumber} keyboardType="number-pad" maxLength={10} />
        <Pressable style={styles.primary} onPress={() => void savePayoutAccount()}><Text style={styles.primaryText}>Verify payout account</Text></Pressable>
      </>}
    </View>

    <View style={styles.card}>
      <Text style={styles.title}>Courier earnings</Text>
      <Text style={styles.muted}>Available · ₦{(payoutSummary.eligibleMinor / 100).toLocaleString()} · Processing · ₦{(payoutSummary.processingMinor / 100).toLocaleString()}</Text>
      <Text style={styles.muted}>Paid out · ₦{(payoutSummary.releasedMinor / 100).toLocaleString()} · Failed · ₦{(payoutSummary.failedMinor / 100).toLocaleString()}</Text>
      <Pressable style={styles.primary} onPress={() => void loadPayoutHistory()}><Text style={styles.primaryText}>Refresh earnings</Text></Pressable>
    </View>

    {payout && <View style={styles.card}>
      <Text style={styles.title}>Current payout</Text>
      <Text style={styles.title}>₦{(payout.amount_minor / 100).toLocaleString()}</Text>
      <Text style={styles.muted}>Status: {payout.status.replaceAll("_", " ")}{payout.provider_status ? " · Paystack: " + payout.provider_status : ""}</Text>
      {payout.failure_reason ? <Text style={styles.muted}>Reason: {payout.failure_reason}</Text> : null}
      {payout.status === "ELIGIBLE" && payoutAccount ? <Pressable style={styles.primary} onPress={() => void withdrawPayout()}><Text style={styles.primaryText}>Withdraw to bank</Text></Pressable> : null}
    </View>}

    <View style={styles.card}>
      <Text style={styles.title}>Payout history</Text>
      {payoutHistory.length === 0 ? <Text style={styles.muted}>No payouts yet.</Text> : payoutHistory.slice(0, 10).map(item => (
        <View key={item.id} style={{ marginBottom: 10 }}>
          <Text>₦{(item.amount_minor / 100).toLocaleString()} · {item.status.replaceAll("_", " ")}</Text>
          <Text style={styles.muted}>{item.status.replaceAll("_", " ")}</Text>
          {item.failure_reason ? <Text style={styles.muted}>{item.failure_reason}</Text> : null}
        </View>
      ))}
    </View>

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
        <Text style={styles.muted}>Choose one review level:</Text>
        <View style={styles.reviewRow}>
          <Pressable style={[styles.reviewButton,styles.reviewBad]} onPress={()=>void driverApi("/api/deliveries/"+job!.id+"/rating/driver",{stars:1}).then(()=>setRatingSubmitted(true)).catch(error=>Alert.alert("Rating failed",error instanceof Error?error.message:"Unable to save review"))}><Text style={styles.reviewButtonText}>Bad</Text></Pressable>
          <Pressable style={[styles.reviewButton,styles.reviewFair]} onPress={()=>void driverApi("/api/deliveries/"+job!.id+"/rating/driver",{stars:3}).then(()=>setRatingSubmitted(true)).catch(error=>Alert.alert("Rating failed",error instanceof Error?error.message:"Unable to save review"))}><Text style={styles.reviewButtonText}>Fair</Text></Pressable>
          <Pressable style={[styles.reviewButton,styles.reviewExcellent]} onPress={()=>void driverApi("/api/deliveries/"+job!.id+"/rating/driver",{stars:5}).then(()=>setRatingSubmitted(true)).catch(error=>Alert.alert("Rating failed",error instanceof Error?error.message:"Unable to save review"))}><Text style={styles.reviewButtonText}>Excellent</Text></Pressable>
        </View>
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
        <Text style={styles.muted}>You have arrived. Hand the parcel to the receiver and ask them to confirm receipt in SwiftDrop using their 4-digit PIN.</Text>
        <Text style={styles.done}>Courier payment is held until receiver confirmation.</Text>
      </>}
      {job.status === "DELIVERED" && <Text style={styles.done}>✓ Delivery completed</Text>}
      {(job.status === "IN_TRANSIT" || job.status === "ARRIVED") && <View style={styles.exceptionBox}>
        {!showFailure ? <Pressable style={styles.secondary} onPress={() => setShowFailure(true)}><Text>Report failed delivery attempt</Text></Pressable> : <>
          <Text style={styles.title}>Why could you not complete delivery?</Text>
          {["RECIPIENT_UNAVAILABLE","WRONG_ADDRESS","RECIPIENT_REFUSED","ACCESS_BLOCKED","SAFETY_ISSUE","VEHICLE_ISSUE","WEATHER","OTHER"].map(reason => <Pressable key={reason} style={[styles.choice, failureReason === reason && styles.choiceActive]} onPress={() => setFailureReason(reason)}><Text>{reason.replaceAll("_"," ")}</Text></Pressable>)}
          <TextInput style={styles.input} placeholder="Optional notes" value={failureNotes} onChangeText={setFailureNotes} maxLength={1000} />
          <Pressable style={styles.primary} onPress={() => void reportFailedDelivery()}><Text style={styles.primaryText}>Record failed attempt</Text></Pressable>
          <Pressable style={styles.secondary} onPress={() => setShowFailure(false)}><Text>Cancel</Text></Pressable>
        </>}
      </View>}

    </View>}
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:"#F6F8F5"}, auth:{flex:1,padding:24,justifyContent:"center",gap:14}, container:{padding:20,gap:14},
  header:{flexDirection:"row",justifyContent:"space-between",alignItems:"center"}, headerActions:{flexDirection:"row",gap:14,alignItems:"center"}, logo:{fontSize:30,fontWeight:"900",color:"#123D2A",letterSpacing:-.8,marginTop:8},
  subtitle:{fontSize:14,color:"#66716A",lineHeight:20}, title:{fontSize:18,fontWeight:"900",color:"#16221B"}, status:{fontSize:18,fontWeight:"900",color:"#123D2A"},
  card:{borderWidth:1,borderColor:"#DDE5DF",backgroundColor:"#FFFFFF",borderRadius:20,padding:16,gap:12}, input:{borderWidth:1,borderColor:"#D9E0DB",borderRadius:14,padding:14},
  primary:{backgroundColor:"#123D2A",padding:15,borderRadius:14,alignItems:"center"}, primaryText:{color:"#fff",fontWeight:"700"},
  secondary:{borderWidth:1,borderColor:"#BFD0C5",backgroundColor:"#FFFFFF",padding:13,borderRadius:14,alignItems:"center"}, link:{fontWeight:"700"},
  muted:{color:"#68736C"}, job:{borderTopWidth:1,borderTopColor:"#E7ECE8",paddingTop:12,gap:8}, done:{fontSize:18,fontWeight:"800"},
  preview:{width:"100%",height:220,borderRadius:12}, cameraCard:{gap:12}, camera:{height:420,borderRadius:16,overflow:"hidden"},
  exceptionBox:{borderTopWidth:1,borderTopColor:"#E7ECE8",paddingTop:12,gap:8},
  notification:{borderTopWidth:1,borderTopColor:"#eee",paddingTop:10,gap:4}, supportHistory:{borderTopWidth:1,borderTopColor:"#E7ECE8",paddingTop:12,marginTop:4,gap:10}, supportTicket:{borderWidth:1,borderColor:"#E0E7E2",borderRadius:14,padding:12,gap:6}, supportMessage:{backgroundColor:"#F5F8F5",borderRadius:10,padding:10,gap:3}, row:{flexDirection:"row",gap:8}, choice:{flex:1,borderWidth:1,borderColor:"#D9E0DB",borderRadius:12,padding:13,alignItems:"center"},choiceActive:{borderColor:"#178A52",backgroundColor:"#EAF5EF"},multiline:{minHeight:110,textAlignVertical:"top"},reviewRow:{flexDirection:"row",gap:8},reviewButton:{flex:1,borderRadius:14,paddingVertical:15,alignItems:"center"},reviewButtonText:{color:"#fff",fontWeight:"900"},reviewBad:{backgroundColor:"#C53B3B"},reviewFair:{backgroundColor:"#D4A62A"},reviewExcellent:{backgroundColor:"#178A52"}, notificationTitle:{fontWeight:"800"}, fileCard:{borderWidth:1,borderColor:"#ddd",borderRadius:10,padding:12,gap:4}, earnings:{fontSize:16,fontWeight:"800",color:"#123D2A"}
});

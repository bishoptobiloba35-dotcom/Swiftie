import React from "react";
import { SafeAreaView, View, Text, Pressable, StyleSheet, Alert } from "react-native";

export default function App() {
  const [online, setOnline] = React.useState(false);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.logo}>SwiftDrop Driver</Text>
        <Text style={styles.status}>{online ? "You are online" : "You are offline"}</Text>

        <Pressable style={styles.primary} onPress={() => setOnline(value => !value)}>
          <Text style={styles.primaryText}>{online ? "Go offline" : "Go online"}</Text>
        </Pressable>

        {online ? (
          <View style={styles.card}>
            <Text style={styles.title}>Available deliveries</Text>
            <Text style={styles.muted}>New delivery requests will appear here.</Text>
            <Pressable style={styles.secondary} onPress={() => Alert.alert("SwiftDrop", "Job matching will connect here.")}>
              <Text>View nearby jobs</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={styles.muted}>Go online to receive nearby delivery requests.</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fff" },
  container: { flex: 1, padding: 24, gap: 16 },
  logo: { fontSize: 28, fontWeight: "800", marginTop: 24 },
  status: { fontSize: 18 },
  primary: { backgroundColor: "#111", padding: 16, borderRadius: 12, alignItems: "center" },
  primaryText: { color: "#fff", fontWeight: "700" },
  card: { borderWidth: 1, borderColor: "#ddd", borderRadius: 16, padding: 18, gap: 12 },
  title: { fontSize: 20, fontWeight: "700" },
  muted: { color: "#666" },
  secondary: { borderWidth: 1, borderColor: "#ddd", padding: 14, borderRadius: 10, alignItems: "center" }
});

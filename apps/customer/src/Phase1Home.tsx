import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

type Props = {
  delivery: any;
  notifications: any[];
  setHomeSection: (section: "HOME" | "ORDER" | "ERRAND" | "TRACK" | "SHOP" | "LOCATIONS") => void;
  openNotifications: () => void;
  signOut: () => void;
};

type Appearance = "system" | "light" | "dark";
type Mode = "individual" | "business";

const palette = {
  light: { bg: "#E4EEE8", home: "#F3F7F4", card: "#FFFFFF", surf: "#FFFFFF", ink: "#0F1F17", mut: "#6B7D73", line: "#E1EBE5", primary: "#0F8A55", primaryDark: "#0B5A3A", accent: "#F5A524" },
  dark: { bg: "#08110D", home: "#0A150F", card: "#0E1A14", surf: "#15251D", ink: "#EAF3EE", mut: "#93AA9E", line: "#223A2E", primary: "#0F8A55", primaryDark: "#0F8A55", accent: "#F5A524" }
};

export default function Phase1Home({ delivery, notifications, setHomeSection, openNotifications, signOut }: Props) {
  const [appearance, setAppearance] = React.useState<Appearance>("system");
  const [mode, setMode] = React.useState<Mode>("individual");

  React.useEffect(() => {
    AsyncStorage.multiGet(["swiftdrop.appearance", "swiftdrop.mode"]).then(entries => {
      const appearanceValue = entries[0][1];
      const modeValue = entries[1][1];
      if (appearanceValue === "system" || appearanceValue === "light" || appearanceValue === "dark") setAppearance(appearanceValue);
      if (modeValue === "individual" || modeValue === "business") setMode(modeValue);
    });
  }, []);

  const saveAppearance = async (value: Appearance) => {
    setAppearance(value);
    await AsyncStorage.setItem("swiftdrop.appearance", value);
  };
  const saveMode = async (value: Mode) => {
    setMode(value);
    await AsyncStorage.setItem("swiftdrop.mode", value);
  };

  const isDark = appearance === "dark";
  const c = isDark ? palette.dark : palette.light;

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <View style={[styles.header, { backgroundColor: c.primaryDark }]}>
          <View>
            <Text style={styles.wordmark}>SwiftDrop</Text>
            <Text style={styles.tagline}>Move anything. Know where it is. Trust every step.</Text>
          </View>
          <Pressable accessibilityLabel="Notifications" onPress={openNotifications} style={styles.iconButton}>
            <Text style={styles.iconText}>⌁{notifications.some(n => !n.read_at) ? "•" : ""}</Text>
          </Pressable>
        </View>

        <View style={styles.headerCurve} />

        <View style={styles.heroRow}>
          <View>
            <Text style={[styles.eyebrow, { color: c.mut }]}>YOUR DAY, SIMPLIFIED</Text>
            <Text style={[styles.heroTitle, { color: c.ink }]}>What are we moving?</Text>
          </View>
          <View style={[styles.trustPill, { backgroundColor: c.card, borderColor: c.line }]}>
            <Text style={[styles.trustScore, { color: c.primary }]}>92</Text>
            <Text style={[styles.trustLabel, { color: c.mut }]}>Trust</Text>
          </View>
        </View>

        {delivery ? (
          <Pressable onPress={() => setHomeSection("TRACK")} style={[styles.activeCard, { backgroundColor: c.card, borderColor: c.line }]}>
            <View style={styles.activeTop}>
              <View><Text style={[styles.smallCaps, { color: c.primary }]}>ACTIVE DELIVERY</Text><Text style={[styles.activeTitle, { color: c.ink }]}>On the way to receiver</Text></View>
              <Text style={[styles.arrow, { color: c.primary }]}>→</Text>
            </View>
            <View style={styles.progressTrack}><View style={styles.progressFill} /></View>
            <View style={styles.activeMeta}><Text style={{ color: c.mut }}>Pickup evidence ✓</Text><Text style={{ color: c.mut }}>GPS live • ETA 18 min</Text></View>
          </Pressable>
        ) : (
          <View style={[styles.emptyCard, { backgroundColor: c.card, borderColor: c.line }]}>
            <Text style={[styles.emptyTitle, { color: c.ink }]}>Nothing in motion yet.</Text>
            <Text style={[styles.emptyCopy, { color: c.mut }]}>Create a delivery and keep every step protected with evidence, escrow and receiver PIN.</Text>
          </View>
        )}

        <View style={styles.quickGrid}>
          <Pressable onPress={() => setHomeSection("ORDER")} style={[styles.actionCard, { backgroundColor: c.accent }]}>
            <Text style={styles.actionIcon}>↗</Text><Text style={styles.actionTitle}>Get Quote</Text><Text style={styles.actionSub}>Send or receive</Text>
          </Pressable>
          <Pressable onPress={() => setHomeSection("TRACK")} style={[styles.actionCard, { backgroundColor: c.card, borderColor: c.line }]}>
            <Text style={[styles.actionIcon, { color: c.primary }]}>◎</Text><Text style={[styles.actionTitle, { color: c.ink }]}>Track</Text><Text style={[styles.actionSub, { color: c.mut }]}>Live location</Text>
          </Pressable>
          <Pressable onPress={() => setHomeSection("ERRAND")} style={[styles.actionCard, { backgroundColor: c.card, borderColor: c.line }]}>
            <Text style={[styles.actionIcon, { color: c.primary }]}>✦</Text><Text style={[styles.actionTitle, { color: c.ink }]}>Hire an Errand</Text><Text style={[styles.actionSub, { color: c.mut }]}>Buy, shop or handle</Text>
          </Pressable>
          <Pressable onPress={() => setHomeSection("SHOP")} style={[styles.actionCard, { backgroundColor: c.card, borderColor: c.line }]}>
            <Text style={[styles.actionIcon, { color: c.primary }]}>□</Text><Text style={[styles.actionTitle, { color: c.ink }]}>Shop</Text><Text style={[styles.actionSub, { color: c.mut }]}>Everyday goods</Text>
          </Pressable>
        </View>

        <Text style={[styles.sectionTitle, { color: c.ink }]}>Send your order</Text>
        <View style={[styles.listCard, { backgroundColor: c.card, borderColor: c.line }]}>
          {[
            ["Send a parcel", "Same state or inter-state", "↗"],
            ["Express drop-off", "Exact address delivery", "⚡"],
            ["Find a drop-off station", "Nearby trusted locations", "⌖"]
          ].map(([title, sub, icon], index) => (
            <Pressable key={title} onPress={() => index === 2 ? setHomeSection("LOCATIONS") : setHomeSection("ORDER")} style={[styles.listRow, index < 2 && { borderBottomWidth: 1, borderBottomColor: c.line }]}>
              <View style={[styles.listIcon, { backgroundColor: c.home }]}><Text style={{ color: c.primary }}>{icon}</Text></View>
              <View style={styles.listCopy}><Text style={[styles.listTitle, { color: c.ink }]}>{title}</Text><Text style={[styles.listSub, { color: c.mut }]}>{sub}</Text></View>
              <Text style={{ color: c.mut }}>›</Text>
            </Pressable>
          ))}
        </View>

        <View style={[styles.aiCard, { backgroundColor: "#0A2A1D" }]}>
          <View style={styles.aiBadge}><Text style={styles.aiBadgeText}>SWIFT AI</Text></View>
          <Text style={styles.aiTitle}>Let Swift AI help you get things done.</Text>
          <Text style={styles.aiCopy}>Get a quote, prepare a delivery, reschedule an order or run an errand with your permissions and spending limits protected.</Text>
          <Pressable onPress={() => setHomeSection("ERRAND")} style={styles.aiButton}><Text style={styles.aiButtonText}>Ask Swift AI →</Text></Pressable>
        </View>

        <View style={[styles.modeCard, { backgroundColor: c.card, borderColor: c.line }]}>
          <View style={styles.modeText}><Text style={[styles.sectionTitle, { color: c.ink, marginBottom: 4 }]}>Account mode</Text><Text style={{ color: c.mut }}>{mode === "individual" ? "Individual · personal deliveries" : "Business · role workspace"}</Text></View>
          <Pressable onPress={() => void saveMode(mode === "individual" ? "business" : "individual")} style={[styles.switch, { backgroundColor: c.primary }]}><View style={styles.switchKnob} /></Pressable>
        </View>

        <View style={[styles.appearanceCard, { backgroundColor: c.card, borderColor: c.line }]}>
          <Text style={[styles.sectionTitle, { color: c.ink, marginBottom: 10 }]}>Appearance</Text>
          <View style={[styles.segment, { backgroundColor: c.home }]}>
            {(["system", "light", "dark"] as Appearance[]).map(value => (
              <Pressable key={value} onPress={() => void saveAppearance(value)} style={[styles.segmentItem, appearance === value && { backgroundColor: c.primary }]}>
                <Text style={{ color: appearance === value ? "#fff" : c.mut, fontWeight: "700" }}>{value[0].toUpperCase() + value.slice(1)}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        <Pressable onPress={signOut} style={styles.signOut}><Text style={{ color: c.mut }}>Sign out</Text></Pressable>
      </ScrollView>

      <View style={[styles.tabBar, { backgroundColor: c.card, borderTopColor: c.line }]}>
        {[
          ["HOME", "Home", "⌂"],
          ["ORDER", "Shipment", "↗"],
          ["TRACK", "Track", "◎"],
          ["SHOP", "Wallet", "₦"]
        ].map(([key, label, icon]) => (
          <Pressable key={key} onPress={() => setHomeSection(key as Props["setHomeSection"] extends (x: infer U) => any ? U : never)} style={styles.tab}>
            <Text style={[styles.tabIcon, { color: key === "HOME" ? c.primary : c.mut }]}>{icon}</Text>
            <Text style={[styles.tabLabel, { color: key === "HOME" ? c.primary : c.mut }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  container: { paddingBottom: 105 },
  header: { minHeight: 154, paddingHorizontal: 22, paddingTop: 28, paddingBottom: 42, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  headerCurve: { height: 28, marginTop: -26, backgroundColor: "#0B5A3A", borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  wordmark: { color: "#fff", fontSize: 27, fontWeight: "900", letterSpacing: -0.7 },
  tagline: { color: "#D6E9DE", fontSize: 12, marginTop: 5, maxWidth: 255, lineHeight: 17 },
  iconButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: "rgba(255,255,255,.12)", alignItems: "center", justifyContent: "center" },
  iconText: { color: "#fff", fontSize: 20 },
  heroRow: { paddingHorizontal: 20, marginTop: -2, marginBottom: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  eyebrow: { fontSize: 11, fontWeight: "800", letterSpacing: 1.2 },
  heroTitle: { fontSize: 25, fontWeight: "900", letterSpacing: -0.5, marginTop: 4 },
  trustPill: { width: 68, height: 68, borderRadius: 34, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  trustScore: { fontSize: 22, fontWeight: "900" },
  trustLabel: { fontSize: 10, fontWeight: "800", marginTop: -2 },
  activeCard: { marginHorizontal: 20, borderRadius: 18, borderWidth: 1, padding: 17, marginBottom: 18 },
  activeTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  smallCaps: { fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  activeTitle: { fontSize: 17, fontWeight: "800", marginTop: 5 },
  arrow: { fontSize: 26 },
  progressTrack: { height: 7, borderRadius: 7, backgroundColor: "#E1EBE5", marginTop: 17, overflow: "hidden" },
  progressFill: { width: "72%", height: "100%", backgroundColor: "#0F8A55", borderRadius: 7 },
  activeMeta: { flexDirection: "row", justifyContent: "space-between", marginTop: 10, fontSize: 12 },
  emptyCard: { marginHorizontal: 20, borderRadius: 18, borderWidth: 1, padding: 18, marginBottom: 18 },
  emptyTitle: { fontSize: 18, fontWeight: "800" },
  emptyCopy: { marginTop: 6, lineHeight: 20 },
  quickGrid: { paddingHorizontal: 20, flexDirection: "row", flexWrap: "wrap", gap: 10 },
  actionCard: { width: "48.2%", minHeight: 116, borderRadius: 17, borderWidth: 1, padding: 16, justifyContent: "flex-end" },
  actionIcon: { position: "absolute", top: 15, right: 15, fontSize: 22, color: "#1C1303" },
  actionTitle: { fontSize: 16, fontWeight: "900" },
  actionSub: { fontSize: 12, marginTop: 4, color: "#4B4030" },
  sectionTitle: { fontSize: 18, fontWeight: "900" },
  listCard: { marginHorizontal: 20, marginTop: 10, borderRadius: 17, borderWidth: 1, overflow: "hidden" },
  listRow: { minHeight: 76, flexDirection: "row", alignItems: "center", paddingHorizontal: 15 },
  listIcon: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center", marginRight: 12 },
  listCopy: { flex: 1 },
  listTitle: { fontSize: 15, fontWeight: "800" },
  listSub: { fontSize: 12, marginTop: 3 },
  aiCard: { margin: 20, borderRadius: 20, padding: 20 },
  aiBadge: { alignSelf: "flex-start", borderRadius: 999, backgroundColor: "#163E2C", paddingHorizontal: 9, paddingVertical: 5 },
  aiBadgeText: { color: "#9FE0BD", fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  aiTitle: { color: "#fff", fontSize: 21, fontWeight: "900", marginTop: 13, maxWidth: 310 },
  aiCopy: { color: "#B8D1C4", lineHeight: 19, marginTop: 8 },
  aiButton: { alignSelf: "flex-start", marginTop: 16, backgroundColor: "#F5A524", paddingHorizontal: 15, paddingVertical: 11, borderRadius: 11 },
  aiButtonText: { color: "#1C1303", fontWeight: "900" },
  modeCard: { marginHorizontal: 20, borderWidth: 1, borderRadius: 17, padding: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modeText: { flex: 1 },
  switch: { width: 48, height: 28, borderRadius: 20, padding: 3, justifyContent: "center" },
  switchKnob: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#fff", alignSelf: "flex-end" },
  appearanceCard: { margin: 20, marginTop: 10, borderWidth: 1, borderRadius: 17, padding: 16 },
  segment: { flexDirection: "row", borderRadius: 12, padding: 3 },
  segmentItem: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 9 },
  signOut: { alignSelf: "center", padding: 14 },
  tabBar: { position: "absolute", bottom: 0, left: 0, right: 0, minHeight: 74, borderTopWidth: 1, flexDirection: "row", justifyContent: "space-around", paddingTop: 9, paddingBottom: 10 },
  tab: { alignItems: "center", minWidth: 62 },
  tabIcon: { fontSize: 20 },
  tabLabel: { fontSize: 11, fontWeight: "800", marginTop: 4 }
});

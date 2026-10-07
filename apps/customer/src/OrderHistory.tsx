import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

type Order = {
  id: string; trackingCode: string; status: string; receiverName: string; dropoffAddress: string;
  quoteTotalMinor: number; quoteCurrency: string; createdAt: string; updatedAt: string;
};

type Props = {
  api: { customerOrderHistory: (status: "ALL" | "DELIVERED" | "IN_TRANSIT" | "CANCELLED") => Promise<{ deliveries: Order[] }> };
  onBack: () => void;
  onTrack: (trackingCode: string) => void;
};

const filters = ["ALL", "DELIVERED", "IN_TRANSIT", "CANCELLED"] as const;

export default function OrderHistory({ api, onBack, onTrack }: Props) {
  const [filter, setFilter] = React.useState<typeof filters[number]>("ALL");
  const [orders, setOrders] = React.useState<Order[]>([]);
  const [loading, setLoading] = React.useState(true);
  const load = React.useCallback(async (next: typeof filters[number]) => {
    setLoading(true);
    try { setOrders((await api.customerOrderHistory(next)).deliveries); } finally { setLoading(false); }
  }, [api]);
  React.useEffect(() => { void load(filter); }, [filter, load]);

  return <View style={styles.root}>
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}><Pressable onPress={onBack}><Text style={styles.back}>‹</Text></Pressable><View><Text style={styles.title}>Order History</Text><Text style={styles.subtitle}>Your deliveries, payments and outcomes.</Text></View></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {filters.map(value => <Pressable key={value} onPress={() => setFilter(value)} style={[styles.chip, filter === value && styles.chipActive]}><Text style={[styles.chipText, filter === value && styles.chipTextActive]}>{value === "IN_TRANSIT" ? "In transit" : value[0] + value.slice(1).toLowerCase()}</Text></Pressable>)}
      </ScrollView>
      {loading ? <Text style={styles.muted}>Loading your orders…</Text> : orders.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>No orders here yet.</Text><Text style={styles.muted}>Your completed and active deliveries will appear here.</Text></View> :
        orders.map(order => <Pressable key={order.id} onPress={() => onTrack(order.trackingCode)} style={styles.card}>
          <View style={styles.row}><View style={styles.dot}/><View style={{flex:1}}><Text style={styles.code}>{order.trackingCode}</Text><Text style={styles.receiver}>To {order.receiverName}</Text></View><Text style={styles.status}>{order.status.replaceAll("_"," ")}</Text></View>
          <Text style={styles.address} numberOfLines={1}>{order.dropoffAddress}</Text>
          <View style={styles.row}><Text style={styles.date}>{new Date(order.updatedAt).toLocaleString()}</Text><Text style={styles.amount}>₦{(order.quoteTotalMinor/100).toLocaleString()}</Text></View>
        </Pressable>)}
    </ScrollView>
  </View>;
}

const styles=StyleSheet.create({
 root:{flex:1,backgroundColor:"#E4EEE8"},container:{padding:20,paddingBottom:40},header:{flexDirection:"row",alignItems:"center",gap:12,marginBottom:20},back:{fontSize:36,color:"#0B5A3A",lineHeight:36},title:{fontSize:25,fontWeight:"900",color:"#0F1F17"},subtitle:{color:"#6B7D73",marginTop:3},chips:{gap:8,paddingBottom:16},chip:{paddingHorizontal:15,paddingVertical:10,borderRadius:999,borderWidth:1,borderColor:"#D0DED6",backgroundColor:"#fff"},chipActive:{backgroundColor:"#0F8A55",borderColor:"#0F8A55"},chipText:{fontWeight:"800",color:"#6B7D73"},chipTextActive:{color:"#fff"},card:{backgroundColor:"#fff",borderWidth:1,borderColor:"#E1EBE5",borderRadius:17,padding:16,marginBottom:10},row:{flexDirection:"row",alignItems:"center",gap:10},dot:{width:10,height:10,borderRadius:5,backgroundColor:"#0F8A55"},code:{fontWeight:"900",color:"#0F1F17"},receiver:{color:"#6B7D73",marginTop:2},status:{fontSize:11,fontWeight:"900",color:"#0F8A55"},address:{color:"#33463D",marginTop:12},date:{flex:1,color:"#93A59C",fontSize:11,marginTop:12},amount:{fontWeight:"900",color:"#0F1F17",marginTop:12},empty:{backgroundColor:"#fff",borderRadius:17,padding:22},emptyTitle:{fontSize:18,fontWeight:"900",color:"#0F1F17",marginBottom:5},muted:{color:"#6B7D73",marginTop:10}
});

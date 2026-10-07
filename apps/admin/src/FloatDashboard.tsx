import React from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";

type Props={apiBaseUrl:string;accessToken:string};

export default function FloatDashboard({apiBaseUrl,accessToken}:Props){
 const [data,setData]=React.useState<any>(null); const [refreshing,setRefreshing]=React.useState(false);
 const load=React.useCallback(async()=>{setRefreshing(true);try{const r=await fetch(apiBaseUrl+"/api/float/balance",{headers:{authorization:"Bearer "+accessToken}});const d=await r.json();if(!r.ok)throw new Error(d.error??"Unable to load float");setData(d);}catch(e){Alert.alert("Float dashboard",e instanceof Error?e.message:"Unable to load float")}finally{setRefreshing(false)}},[apiBaseUrl,accessToken]);
 React.useEffect(()=>{void load()},[load]);
 const balance=Number(data?.balanceMinor??0);
 return <ScrollView contentContainerStyle={styles.container} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={()=>void load()}/>}>
  <Text style={styles.title}>Float Dashboard</Text><Text style={styles.subtitle}>Admin / Finance only · escrow float and reserve monitoring.</Text>
  <View style={styles.card}><Text style={styles.label}>CURRENT FLOAT</Text><Text style={styles.total}>₦{(balance/100).toLocaleString()}</Text><Text style={balance<Number(data?.autoTopUpThresholdMinor??0)?styles.warn:styles.good}>{balance<Number(data?.autoTopUpThresholdMinor??0)?"⚠ Auto-top-up threshold reached":"✓ Above auto-top-up threshold"}</Text></View>
  <View style={styles.card}><Text>Minimum reserve</Text><Text style={styles.value}>₦{(Number(data?.minimumReserveMinor??0)/100).toLocaleString()}</Text><Text>Auto-top-up threshold</Text><Text style={styles.value}>₦{(Number(data?.autoTopUpThresholdMinor??0)/100).toLocaleString()}</Text><Text>Reconciliation</Text><Text style={styles.value}>Daily 18:00</Text></View>
  <Text style={styles.muted}>Float movements must be reconciled against Paystack collections, escrow releases, refunds, payouts and recorded interest income. No customer funds are treated as operating cash.</Text>
 </ScrollView>
}
const styles=StyleSheet.create({container:{padding:24,gap:16},title:{fontSize:30,fontWeight:"800"},subtitle:{color:"#6B7D73"},card:{padding:20,borderRadius:14,borderWidth:1,borderColor:"#E1EBE5",gap:8},label:{fontSize:12,fontWeight:"700",color:"#6B7D73"},total:{fontSize:40,fontWeight:"800"},value:{fontSize:20,fontWeight:"700"},good:{fontWeight:"800",color:"#0F8A55"},warn:{fontWeight:"800",color:"#CF4A40"},muted:{color:"#6B7D73",lineHeight:22}});

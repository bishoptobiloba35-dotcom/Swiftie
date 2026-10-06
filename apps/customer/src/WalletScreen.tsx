import React from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SwiftDropApi } from "../../../packages/shared/src/api";
export default function WalletScreen({api,onBack,onPayout}:{api:SwiftDropApi;onBack:()=>void;onPayout:()=>void}){
 const [wallet,setWallet]=React.useState<any>(null);
 React.useEffect(()=>{void api.walletBalance().then(setWallet).catch(()=>setWallet(null));},[]);
 return <ScrollView contentContainerStyle={styles.container}><Text style={styles.title}>Wallet</Text><Text style={styles.subtitle}>Real-time stakeholder balance and payout access.</Text>
 <View style={styles.card}><Text style={styles.label}>AVAILABLE</Text><Text style={styles.total}>₦{(Number(wallet?.balance_minor??0)/100).toLocaleString()}</Text><Text style={styles.muted}>Pending: ₦{(Number(wallet?.pending_minor??0)/100).toLocaleString()}</Text></View>
 <Pressable style={styles.primary} onPress={onPayout}><Text style={styles.primaryText}>Withdraw via Paystack Transfers</Text></Pressable>
 <Text style={styles.muted}>Minimum withdrawal: ₦1,000. Courier and errand payouts can become instantly available after verified PIN confirmation.</Text>
 <Pressable style={styles.secondary} onPress={onBack}><Text>Back</Text></Pressable></ScrollView>
}
const styles=StyleSheet.create({container:{padding:24,gap:14},title:{fontSize:28,fontWeight:"800"},subtitle:{fontSize:16,color:"#6B7D73"},card:{padding:20,borderRadius:14,borderWidth:1,borderColor:"#E1EBE5"},label:{fontSize:12,fontWeight:"700",color:"#6B7D73"},total:{fontSize:38,fontWeight:"800"},muted:{color:"#6B7D73"},primary:{padding:16,borderRadius:12,backgroundColor:"#0B5A3A",alignItems:"center"},primaryText:{color:"#fff",fontWeight:"800"},secondary:{padding:16,borderRadius:12,borderWidth:1,borderColor:"#E1EBE5",alignItems:"center"}});

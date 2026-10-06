import React from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SwiftDropApi } from "../../../packages/shared/src/api";

export default function EscrowPaymentScreen({ api, orderId, amountMinor, onBack }: { api: SwiftDropApi; orderId: string; amountMinor: number; onBack: () => void }) {
  const [busy,setBusy]=React.useState(false);
  const pay=async(method:"PAYSTACK_CARD"|"BANK_TRANSFER"|"USSD"|"SMS_LINK")=>{
    try{
      setBusy(true);
      const escrow=await api.createEscrow(orderId,amountMinor);
      const payment=await api.payEscrow(orderId,method,crypto.randomUUID());
      Alert.alert("Payment started", method==="BANK_TRANSFER" ? "Your dedicated virtual account will be shown when available." : "Complete payment. SwiftDrop will confirm escrow from the verified provider webhook.");
      void escrow; void payment;
    }catch(e){Alert.alert("Payment failed",e instanceof Error?e.message:"Unable to start payment");}
    finally{setBusy(false);}
  };
  return <ScrollView contentContainerStyle={styles.container}>
    <Text style={styles.title}>Escrow Payment</Text>
    <Text style={styles.subtitle}>Your parcel is protected. No cash is accepted.</Text>
    <View style={styles.card}><Text style={styles.label}>TOTAL TO SECURE</Text><Text style={styles.total}>₦{(amountMinor/100).toLocaleString()}</Text><Text style={styles.good}>Payment secured ✓</Text><Text style={styles.muted}>Escrow releases only after receiver PIN confirmation.</Text></View>
    <Pressable disabled={busy} style={styles.primary} onPress={()=>void pay("PAYSTACK_CARD")}><Text style={styles.primaryText}>Pay with Paystack card</Text></Pressable>
    <Pressable disabled={busy} style={styles.secondary} onPress={()=>void pay("BANK_TRANSFER")}><Text>Pay by bank transfer</Text></Pressable>
    <Pressable disabled={busy} style={styles.secondary} onPress={()=>void pay("USSD")}><Text>Pay with USSD</Text></Pressable>
    <Pressable disabled={busy} style={styles.secondary} onPress={()=>void pay("SMS_LINK")}><Text>Send SMS payment link</Text></Pressable>
    <Pressable style={styles.link} onPress={onBack}><Text>Back</Text></Pressable>
  </ScrollView>;
}
const styles=StyleSheet.create({container:{padding:24,gap:14},title:{fontSize:28,fontWeight:"800"},subtitle:{fontSize:16,color:"#6B7D73"},card:{padding:20,borderRadius:14,borderWidth:1,borderColor:"#E1EBE5",gap:8},label:{fontSize:12,fontWeight:"700",color:"#6B7D73"},total:{fontSize:38,fontWeight:"800"},good:{fontWeight:"800",color:"#0F8A55"},muted:{color:"#6B7D73"},primary:{padding:16,borderRadius:12,backgroundColor:"#0B5A3A",alignItems:"center"},primaryText:{color:"#fff",fontWeight:"800"},secondary:{padding:16,borderRadius:12,borderWidth:1,borderColor:"#E1EBE5",alignItems:"center"},link:{padding:14,alignItems:"center"}});

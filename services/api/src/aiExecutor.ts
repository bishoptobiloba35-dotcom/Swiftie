import { findDeliveryForUser, findPayment, createPayment, updatePaymentStatus, savePaymentAuthorization, rescheduleDelivery, createSupportTicket, type StoredDelivery } from "./database/deliveryRepository.js";
import { latestPersistentLocation } from "./database/deliveryRepository.js";

export type AiExecution =
  | { executed: true; actionType: string; targetId?: string; amountMinor?: number; result: Record<string, unknown> }
  | { executed: false; requiresApproval: true; actionType: string; targetId?: string; amountMinor?: number; result: Record<string, unknown> };

function stringDetail(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function executeAiAction(input: {
  userId: string;
  actionType: string;
  targetId?: string;
  details: Record<string, unknown>;
  approved: boolean;
}): Promise<AiExecution> {
  const actionType = input.actionType.trim().toUpperCase();

  if (actionType === "TRACK_DELIVERY" || actionType === "GET_TRACKING" || actionType === "GET_DELIVERY_STATUS") {
    if (!input.targetId) throw new Error("A delivery ID is required");
    const delivery = await findDeliveryForUser(input.targetId, input.userId, "CUSTOMER");
    if (!delivery) throw new Error("Delivery not found");
    const location = await latestPersistentLocation(delivery.id);
    return {
      executed: true,
      actionType,
      targetId: delivery.id,
      result: { delivery, latestLocation: location }
    };
  }

  if (actionType === "RESCHEDULE_DELIVERY") {
    if (!input.targetId) throw new Error("A delivery ID is required");
    const scheduledFor = stringDetail(input.details, "scheduledFor");
    if (!scheduledFor) throw new Error("scheduledFor is required");
    if (!input.approved) {
      return { executed: false, requiresApproval: true, actionType, targetId: input.targetId, result: { scheduledFor } };
    }
    const delivery = await findDeliveryForUser(input.targetId, input.userId, "CUSTOMER");
    if (!delivery) throw new Error("Delivery not found");
    const updated = await rescheduleDelivery({ deliveryId: delivery.id, userId: input.userId, scheduledFor });
    if (!updated) throw new Error("Delivery cannot be rescheduled or has reached the reschedule limit");
    return { executed: true, actionType, targetId: updated.id, result: { delivery: updated } };
  }

  if (actionType === "CONTACT_SUPPORT") {
    const category = (stringDetail(input.details, "category") ?? "APP").toUpperCase();
    const subject = stringDetail(input.details, "subject");
    const message = stringDetail(input.details, "message");
    if (category !== "APP" && category !== "ORDER") throw new Error("Support category must be APP or ORDER");
    if (!subject || subject.length > 120 || subject.length < 3) throw new Error("A valid support subject is required");
    if (!message || message.length > 2000 || message.length < 5) throw new Error("A valid support message is required");
    let deliveryId = input.targetId;
    if (deliveryId) {
      const delivery = await findDeliveryForUser(deliveryId, input.userId, "CUSTOMER");
      if (!delivery) throw new Error("Delivery not found");
    }
    const ticket = await createSupportTicket(input.userId, category as "ORDER" | "APP", subject, message, deliveryId);
    if (!ticket) throw new Error("Unable to create support request");
    return { executed: true, actionType, targetId: deliveryId, result: { ticket } };
  }

  if (actionType === "PAY_DELIVERY") {
    if (!input.targetId) throw new Error("A delivery ID is required");
    const delivery = await findDeliveryForUser(input.targetId, input.userId, "CUSTOMER");
    if (!delivery) throw new Error("Delivery not found");
    const amountMinor = delivery.quote?.totalMinor;
    if (!amountMinor || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new Error("Delivery does not have a valid server quote");
    }
    const email = stringDetail(input.details, "email");
    if (!email) throw new Error("Email is required for payment");
    if (!input.approved) {
      return { executed: false, requiresApproval: true, actionType, targetId: delivery.id, amountMinor, result: { amountMinor, currency: "NGN", email } };
    }

    const provider = process.env.PAYMENT_PROVIDER || "paystack";
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (provider !== "paystack" || !secret) throw new Error("Paystack payment configuration is not ready");

    const existing = await findPayment(delivery.id);
    if (existing && (existing.amountMinor !== amountMinor || existing.currency !== "NGN")) {
      throw new Error("Existing payment amount no longer matches the server quote");
    }
    if (existing?.status === "HELD" || existing?.status === "RELEASED") {
      throw new Error("This delivery already has a completed payment state");
    }
    if (existing?.status === "PENDING" && existing.authorizationUrl && existing.providerReference) {
      return {
        executed: true,
        actionType,
        targetId: delivery.id,
        amountMinor,
        result: {
          paymentId: existing.id,
          reference: existing.providerReference,
          authorizationUrl: existing.authorizationUrl,
          accessCode: existing.accessCode,
          reusedExistingAuthorization: true
        }
      };
    }

    const reference = existing?.providerReference ?? ("SD-" + delivery.trackingCode + "-PAY");
    await (existing ? updatePaymentStatus(delivery.id, "PENDING", reference) : createPayment({
      deliveryId: delivery.id,
      provider: "paystack",
      amountMinor,
      currency: "NGN"
    }));
    if (!existing) await updatePaymentStatus(delivery.id, "PENDING", reference);

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
      body: JSON.stringify({ email, amount: String(amountMinor), currency: "NGN", reference })
    });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok || !payload?.status || !payload?.data?.authorization_url) {
      throw new Error("Paystack payment initialization failed");
    }
    const saved = await savePaymentAuthorization(
      delivery.id,
      String(payload.data.reference ?? reference),
      String(payload.data.authorization_url),
      payload.data.access_code ? String(payload.data.access_code) : undefined
    );
    if (!saved) throw new Error("Unable to persist payment authorization");
    return {
      executed: true,
      actionType,
      targetId: delivery.id,
      amountMinor,
      result: {
        paymentId: saved.id,
        reference: saved.providerReference,
        authorizationUrl: saved.authorizationUrl,
        accessCode: saved.accessCode
      }
    };
  }

  throw new Error("Unsupported AI action");
}

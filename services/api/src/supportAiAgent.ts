import { pool } from "./database/db.js";
import {
  listOpenSupportAiTickets,
  recordSupportAiAction,
  notifyAdminsOfSupportAiAction,
  notifySupportUserOfAiAction,
  resolveSupportTicket
} from "./database/deliveryRepository.js";

import { classifySupportRequest } from "./supportAiPolicy.js";

type AiDecision = {
  action: "AUTO_RESOLVED" | "ESCALATED";
  reason: string;
  response: string;
};


async function generateAiReply(subject: string, message: string, context: string): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const model = process.env.OPENAI_SUPPORT_MODEL || "gpt-5.6-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: "You are SwiftDrop Support AI. Give concise, factual customer support replies. Never claim you performed a payment, refund, cancellation, account change, or other financial/irreversible action. Only explain status or next steps. If evidence is missing, say so."
        },
        {
          role: "user",
          content: "Subject: " + subject + "\nMessage: " + message + "\nVerified context: " + context
        }
      ],
      max_output_tokens: 250
    })
  });
  if (!response.ok) return null;
  const body = await response.json() as { output_text?: string };
  return typeof body.output_text === "string" && body.output_text.trim() ? body.output_text.trim() : null;
}

async function decideTicket(ticket: any): Promise<AiDecision> {
  if (classifySupportRequest(ticket.subject, ticket.message) === "ESCALATED") {
    return {
      action: "ESCALATED",
      reason: "Financial, cancellation, dispute, or other sensitive action requires human review.",
      response: "Your request has been received and escalated to SwiftDrop support for human review."
    };
  }

  if (ticket.delivery_id) {
    const delivery = (await pool!.query(
      "SELECT status, tracking_code, updated_at FROM deliveries WHERE id=$1",
      [ticket.delivery_id]
    )).rows[0];
    if (!delivery) {
      return { action: "ESCALATED", reason: "The referenced order could not be verified.", response: "We could not verify the referenced order, so a support administrator will review this request." };
    }

    const context = "delivery status=" + delivery.status + ", tracking code=" + delivery.tracking_code + ", last updated=" + delivery.updated_at;
    const aiReply = await generateAiReply(ticket.subject, ticket.message, context);
    return {
      action: "AUTO_RESOLVED",
      reason: "Verified order-status inquiry with no sensitive action requested.",
      response: aiReply ?? ("Your SwiftDrop order is currently " + String(delivery.status).toLowerCase().replaceAll("_", " ") + ". Tracking code: " + delivery.tracking_code + ".")
    };
  }

  const faq = /how|where|track|tracking|support|help|status|app|driver|drop.?off/i.test(ticket.subject + " " + ticket.message);
  if (faq) {
    const aiReply = await generateAiReply(ticket.subject, ticket.message, "No order was linked. Only general SwiftDrop support information may be provided.");
    return {
      action: "AUTO_RESOLVED",
      reason: "General informational support request with no side effect.",
      response: aiReply ?? "SwiftDrop Support AI can provide general app and tracking guidance. If your issue involves payment, cancellation, a dispute, or another account-changing action, it will be escalated to a human administrator."
    };
  }

  return {
    action: "ESCALATED",
    reason: "The request does not match an approved automatic-resolution category.",
    response: "Your request has been received and escalated to SwiftDrop support for human review."
  };
}

export async function processSupportAiBatch(limit = 10): Promise<void> {
  if (!pool) return;
  const result = await pool.query(
    `SELECT id, user_id, delivery_id, category, subject, message
     FROM support_tickets
     WHERE status='OPEN' AND ai_handled=false AND human_required=false
     ORDER BY created_at ASC LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [Math.min(Math.max(limit, 1), 20)]
  );

  for (const ticket of result.rows) {
    try {
      const decision = await decideTicket(ticket);
      const action = await recordSupportAiAction(
        ticket.id,
        decision.action === "AUTO_RESOLVED" ? "SUPPORT_REPLY" : "ESCALATE_TO_HUMAN",
        decision.action,
        decision.reason,
        decision.response
      );
      if (action) {
        await notifyAdminsOfSupportAiAction(ticket.id, action.id, decision.action, decision.response);
        await notifySupportUserOfAiAction(ticket.id, action.id, decision.action, decision.response);
      }
    } catch (error) {
      console.error("Support AI ticket processing failed:", error);
      const response = "Support AI could not safely process this request; human review is required.";
      const action = await recordSupportAiAction(
        ticket.id,
        "ESCALATE_TO_HUMAN",
        "ESCALATED",
        "Support AI processing failed safely; human review is required.",
        response
      );
      if (action) {
        await notifyAdminsOfSupportAiAction(ticket.id, action.id, "ESCALATED", response);
        await notifySupportUserOfAiAction(ticket.id, action.id, "ESCALATED", response);
      } else {
        await resolveSupportTicket(ticket.id, "IN_REVIEW", response);
      }
    }
  }
}

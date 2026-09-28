import { pool } from "./database/db.js";

export type AiMode = "ASSIST" | "AUTHORIZED" | "AUTONOMOUS";

export type AiPermission = {
  mode: AiMode;
  autoPayEnabled: boolean;
  autoPayLimitMinor: number;
  dailySpendLimitMinor: number;
  dailySpendUsedMinor: number;
  dailySpendDate: string;
  preferredVehicle?: string;
  maxDeliveryCostMinor?: number;
  approvalThresholdMinor?: number;
};

export async function ensureAiDefaults(userId: string): Promise<AiPermission> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const result = await pool.query(
    `INSERT INTO ai_permissions (user_id, daily_spend_date)
     VALUES ($1, CURRENT_DATE)
     ON CONFLICT (user_id) DO UPDATE
       SET daily_spend_used_minor =
             CASE WHEN ai_permissions.daily_spend_date < CURRENT_DATE
                  THEN 0 ELSE ai_permissions.daily_spend_used_minor END,
           daily_spend_date =
             CASE WHEN ai_permissions.daily_spend_date < CURRENT_DATE
                  THEN CURRENT_DATE ELSE ai_permissions.daily_spend_date END,
           updated_at=now()
     RETURNING mode, auto_pay_enabled, auto_pay_limit_minor, daily_spend_limit_minor,
               daily_spend_used_minor, daily_spend_date, preferred_vehicle,
               max_delivery_cost_minor, approval_threshold_minor`,
    [userId]
  );
  return mapPermission(result.rows[0]);
}

function mapPermission(row: any): AiPermission {
  return {
    mode: row.mode,
    autoPayEnabled: Boolean(row.auto_pay_enabled),
    autoPayLimitMinor: Number(row.auto_pay_limit_minor),
    dailySpendLimitMinor: Number(row.daily_spend_limit_minor),
    dailySpendUsedMinor: Number(row.daily_spend_used_minor),
    dailySpendDate: String(row.daily_spend_date),
    preferredVehicle: row.preferred_vehicle ?? undefined,
    maxDeliveryCostMinor: row.max_delivery_cost_minor == null ? undefined : Number(row.max_delivery_cost_minor),
    approvalThresholdMinor: row.approval_threshold_minor == null ? undefined : Number(row.approval_threshold_minor)
  };
}

export async function getAiPermission(userId: string): Promise<AiPermission> {
  return ensureAiDefaults(userId);
}

export async function updateAiPermission(userId: string, input: Partial<AiPermission>): Promise<AiPermission> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const current = await ensureAiDefaults(userId);
  const next = { ...current, ...input };
  const result = await pool.query(
    `UPDATE ai_permissions
        SET mode=$2, auto_pay_enabled=$3, auto_pay_limit_minor=$4,
            daily_spend_limit_minor=$5, preferred_vehicle=$6,
            max_delivery_cost_minor=$7, approval_threshold_minor=$8, updated_at=now()
      WHERE user_id=$1
      RETURNING mode, auto_pay_enabled, auto_pay_limit_minor, daily_spend_limit_minor,
                daily_spend_used_minor, daily_spend_date, preferred_vehicle,
                max_delivery_cost_minor, approval_threshold_minor`,
    [userId, next.mode, next.autoPayEnabled, next.autoPayLimitMinor, next.dailySpendLimitMinor,
     next.preferredVehicle ?? null, next.maxDeliveryCostMinor ?? null, next.approvalThresholdMinor ?? null]
  );
  return mapPermission(result.rows[0]);
}

export async function auditAiAction(input: {
  userId: string; actionType: string; status: "PREPARED"|"APPROVED"|"EXECUTED"|"REJECTED"|"FAILED";
  amountMinor?: number; targetType?: string; targetId?: string; details?: Record<string, unknown>;
}) {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const result = await pool.query(
    `INSERT INTO ai_action_audit
      (user_id, action_type, status, amount_minor, target_type, target_id, details)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, action_type, status, amount_minor, currency, target_type, target_id, details, created_at`,
    [input.userId, input.actionType, input.status, input.amountMinor ?? null,
     input.targetType ?? null, input.targetId ?? null, JSON.stringify(input.details ?? {})]
  );
  return result.rows[0];
}

export function evaluateAiPayment(permission: AiPermission, amountMinor: number): { allowed: boolean; requiresApproval: boolean; reason?: string } {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return { allowed: false, requiresApproval: false, reason: "Invalid payment amount" };
  if (permission.mode === "ASSIST") return { allowed: true, requiresApproval: true, reason: "AI is configured for assisted actions" };
  if (!permission.autoPayEnabled) return { allowed: true, requiresApproval: true, reason: "Automatic payments are disabled" };
  if (permission.approvalThresholdMinor != null && amountMinor > permission.approvalThresholdMinor) {
    return { allowed: true, requiresApproval: true, reason: "Payment exceeds approval threshold" };
  }
  if (amountMinor > permission.autoPayLimitMinor) return { allowed: true, requiresApproval: true, reason: "Payment exceeds automatic payment limit" };
  if (permission.dailySpendLimitMinor > 0 && permission.dailySpendUsedMinor + amountMinor > permission.dailySpendLimitMinor) {
    return { allowed: true, requiresApproval: true, reason: "Daily AI spending limit would be exceeded" };
  }
  return { allowed: true, requiresApproval: false };
}


export async function reserveAiSpend(userId: string, amountMinor: number): Promise<boolean> {
  if (!pool || !Number.isInteger(amountMinor) || amountMinor <= 0) return false;
  await ensureAiDefaults(userId);
  const result = await pool.query(
    `UPDATE ai_permissions
        SET daily_spend_used_minor = daily_spend_used_minor + $2,
            updated_at = now()
      WHERE user_id=$1
        AND daily_spend_date=CURRENT_DATE
        AND (daily_spend_limit_minor = 0 OR daily_spend_used_minor + $2 <= daily_spend_limit_minor)
      RETURNING daily_spend_used_minor`,
    [userId, amountMinor]
  );
  return result.rowCount === 1;
}

export async function releaseAiSpend(userId: string, amountMinor: number): Promise<boolean> {
  if (!pool || !Number.isInteger(amountMinor) || amountMinor <= 0) return false;
  const result = await pool.query(
    `UPDATE ai_permissions
        SET daily_spend_used_minor = GREATEST(0, daily_spend_used_minor - $2),
            updated_at = now()
      WHERE user_id=$1 AND daily_spend_date=CURRENT_DATE
      RETURNING daily_spend_used_minor`,
    [userId, amountMinor]
  );
  return result.rowCount === 1;
}


export type AiAccess = {
  plan: "BASIC" | "PREMIUM";
  monthlyChatCredits: number;
  monthlyChatCreditsUsed: number;
  remainingChatCredits: number;
  allowedActions: string[];
};

const BASIC_CHAT_CREDITS = 20;
const PREMIUM_CHAT_CREDITS = 500;
const BASIC_ACTIONS = ["TRACK_DELIVERY", "GET_TRACKING", "GET_DELIVERY_STATUS", "CONTACT_SUPPORT"];

export async function getAiAccess(userId: string): Promise<AiAccess> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const planResult = await pool.query(
    `INSERT INTO user_plans (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET updated_at=now()
     RETURNING individual_plan`,
    [userId]
  );
  const plan = planResult.rows[0]?.individual_plan === "PREMIUM" ? "PREMIUM" : "BASIC";
  const usage = await pool.query(
    `INSERT INTO ai_usage (user_id, period_start) VALUES ($1, date_trunc('month', CURRENT_DATE)::date)
     ON CONFLICT (user_id) DO UPDATE
       SET chat_credits_used = CASE WHEN ai_usage.period_start < date_trunc('month', CURRENT_DATE)::date THEN 0 ELSE ai_usage.chat_credits_used END,
           action_credits_used = CASE WHEN ai_usage.period_start < date_trunc('month', CURRENT_DATE)::date THEN 0 ELSE ai_usage.action_credits_used END,
           period_start = CASE WHEN ai_usage.period_start < date_trunc('month', CURRENT_DATE)::date THEN date_trunc('month', CURRENT_DATE)::date ELSE ai_usage.period_start END,
           updated_at=now()
     RETURNING chat_credits_used`,
    [userId]
  );
  const limit = plan === "PREMIUM" ? PREMIUM_CHAT_CREDITS : BASIC_CHAT_CREDITS;
  const used = Number(usage.rows[0]?.chat_credits_used ?? 0);
  return {
    plan,
    monthlyChatCredits: limit,
    monthlyChatCreditsUsed: used,
    remainingChatCredits: Math.max(0, limit - used),
    allowedActions: plan === "PREMIUM" ? ["TRACK_DELIVERY","GET_TRACKING","GET_DELIVERY_STATUS","RESCHEDULE_DELIVERY","CONTACT_SUPPORT","PAY_DELIVERY"] : BASIC_ACTIONS
  };
}

export async function consumeAiChatCredit(userId: string): Promise<{ remaining: number; limit: number }> {
  const access = await getAiAccess(userId);
  const result = await pool!.query(
    `UPDATE ai_usage SET chat_credits_used=chat_credits_used+1, updated_at=now()
      WHERE user_id=$1 AND period_start=date_trunc('month', CURRENT_DATE)::date
        AND chat_credits_used < $2
      RETURNING chat_credits_used`,
    [userId, access.monthlyChatCredits]
  );
  if (!result.rowCount) throw new Error("AI chat credit limit reached for this month");
  return { remaining: Math.max(0, access.monthlyChatCredits - Number(result.rows[0].chat_credits_used)), limit: access.monthlyChatCredits };
}

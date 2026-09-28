import { pool } from "./database/db.js";

export type AiMode = "ASSIST" | "AUTHORIZED" | "AUTONOMOUS";

export type AiPermission = {
  mode: AiMode;
  autoPayEnabled: boolean;
  autoPayLimitMinor: number;
  dailySpendLimitMinor: number;
  dailySpendUsedMinor: number;
  preferredVehicle?: string;
  maxDeliveryCostMinor?: number;
  approvalThresholdMinor?: number;
};

export async function ensureAiDefaults(userId: string): Promise<AiPermission> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const result = await pool.query(
    `INSERT INTO ai_permissions (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET updated_at=now()
     RETURNING mode, auto_pay_enabled, auto_pay_limit_minor, daily_spend_limit_minor,
               daily_spend_used_minor, preferred_vehicle, max_delivery_cost_minor, approval_threshold_minor`,
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
                daily_spend_used_minor, preferred_vehicle, max_delivery_cost_minor, approval_threshold_minor`,
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

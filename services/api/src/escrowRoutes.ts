import { recoverOutstandingCourierClawbacks } from "./database/deliveryRepository.js";
import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool, databaseEnabled } from "./database/db.js";
import { verifyPin } from "./security.js";
import { requireAuth } from "./authMiddleware.js";
import { identity } from "./requestIdentity.js";

const router = Router();
const MIN_WITHDRAWAL_MINOR = 100000;
function courierShareBps(): number {
  const percent = Number(process.env.DRIVER_PAYOUT_PERCENT ?? "75");
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) throw new Error("Invalid DRIVER_PAYOUT_PERCENT");
  return Math.round(percent * 100);
}
const ESCROW_DISPUTE_HOURS = 2;
const MERCHANT_HOLD_HOURS = 72;
const FLOAT_MIN_RESERVE_MINOR = 500000000;
const FLOAT_TOPUP_THRESHOLD_MINOR = 300000000;

export function createWalletPayoutProviderReference(): string {
  return "sd_wallet_" + randomUUID().replaceAll("-", "");
}

function authUser(req: any): string {
  const id = identity(req);
  if (!id) throw new Error("Authentication required");
  return id;
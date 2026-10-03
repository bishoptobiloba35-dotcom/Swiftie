import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "./db.js";
import { runMigrations } from "./migrate.js";

test("drop-off partner commission source and ledger are fixed at NGN 500", async (t) => {
  if (!pool) {
    t.skip("DATABASE_URL is not configured");
    return;
  }

  await runMigrations();

  const source = (await pool.query(
    `SELECT column_default
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='drop_off_locations'
        AND column_name='commission_minor'`
  )).rows[0];

  const sourceConstraint = (await pool.query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid='drop_off_locations'::regclass
        AND conname='drop_off_location_fixed_commission_check'`
  )).rows[0];

  const ledger = (await pool.query(
    `SELECT column_default
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='drop_off_commission_ledger'
        AND column_name='amount_minor'`
  )).rows[0];

  const ledgerConstraint = (await pool.query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid='drop_off_commission_ledger'::regclass
        AND conname='drop_off_commission_fixed_amount_check'`
  )).rows[0];

  assert.match(String(source?.column_default), /50000/);
  assert.match(String(sourceConstraint?.definition), /50000/);
  assert.match(String(ledger?.column_default), /50000/);
  assert.match(String(ledgerConstraint?.definition), /50000/);
});

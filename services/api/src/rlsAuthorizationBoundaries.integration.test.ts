import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "./database/db.js";
import { runMigrations } from "./database/migrate.js";
import { createPersistentDelivery } from "./database/deliveryRepository.js";

async function createUser(role: "CUSTOMER" | "DRIVER" = "CUSTOMER"): Promise<string> {
  if (!pool) throw new Error("DATABASE_URL is required");
  const id = randomUUID();
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  await pool.query(
    `INSERT INTO users(id,role,full_name,phone,email,password_hash)
     VALUES($1,$2,$3,$4,$5,'test-only')`,
    [id, role, "RLS Boundary Test", `+23480${suffix.slice(0, 10)}`, `${id}@example.test`]
  );
  return id;
}

async function createDelivery(senderId: string) {
  return createPersistentDelivery({
    senderId,
    receiverName: "RLS Test Receiver",
    receiverPhone: "+2348012345678",
    receiverPin: "1234",
    declaredValueMinor: 100000,
    pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.07, longitude: 7.40 } },
    dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.41 } },
    weightKg: 1,
    dimensionsCm: { length: 10, width: 10, height: 10 },
    isPerishable: false
  });
}

async function ensureTestRoles(): Promise<void> {
  if (!pool) throw new Error("DATABASE_URL is required");
  await pool.query(`DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='swiftdrop_rls_customer_test') THEN
      CREATE ROLE swiftdrop_rls_customer_test NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='swiftdrop_rls_support_test') THEN
      CREATE ROLE swiftdrop_rls_support_test NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
  END $$`);
  await pool.query(`GRANT SELECT ON users,drivers,deliveries,delivery_events,location_events,
    payments,escrow_payment_attempts,disputes,notifications,device_tokens,driver_documents
    TO swiftdrop_rls_customer_test`);
  await pool.query(`GRANT INSERT ON payments,escrow_payment_attempts TO swiftdrop_rls_support_test`);
}

test("RLS enforces customer ownership, assigned-driver access, and server-only financial writes", async () => {
  if (!pool) return;
  await runMigrations();
  await ensureTestRoles();

  const customerA = await createUser();
  const customerB = await createUser();
  const assignedDriver = await createUser("DRIVER");
  const unrelatedDriver = await createUser("DRIVER");

  const assignedDriverRow = (await pool.query(
    "INSERT INTO drivers(user_id,status,online) VALUES($1,'APPROVED',false) RETURNING id",
    [assignedDriver]
  )).rows[0];
  await pool.query(
    "INSERT INTO drivers(user_id,status,online) VALUES($1,'APPROVED',false)",
    [unrelatedDriver]
  );

  const deliveryA = await createDelivery(customerA);
  const deliveryB = await createDelivery(customerB);
  await pool.query("UPDATE deliveries SET driver_id=$2 WHERE id=$1", [deliveryA.id, assignedDriverRow.id]);

  await pool.query(
    `INSERT INTO payments(delivery_id,provider,provider_reference,amount_minor,currency,status)
     VALUES($1,'paystack',$2,100000,'NGN','HELD'),($3,'paystack',$4,100000,'NGN','HELD')`,
    [deliveryA.id, "RLS-A-" + randomUUID(), deliveryB.id, "RLS-B-" + randomUUID()]
  );
  await pool.query(
    `INSERT INTO escrow_payment_attempts(order_id,method,amount_minor,idempotency_key)
     VALUES($1,'PAYSTACK_CARD',100000,$2),($3,'PAYSTACK_CARD',100000,$4)`,
    [deliveryA.id, "RLS-ATT-A-" + randomUUID(), deliveryB.id, "RLS-ATT-B-" + randomUUID()]
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE swiftdrop_rls_customer_test");
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [customerA]);

    assert.equal((await client.query("SELECT id FROM users WHERE id=$1", [customerA])).rowCount, 1);
    assert.equal((await client.query("SELECT id FROM users WHERE id=$1", [customerB])).rowCount, 0,
      "customer A must not read customer B's user row");
    assert.equal((await client.query("SELECT id FROM deliveries WHERE id=$1", [deliveryA.id])).rowCount, 1);
    assert.equal((await client.query("SELECT id FROM deliveries WHERE id=$1", [deliveryB.id])).rowCount, 0,
      "customer A must not read customer B's delivery");
    assert.equal((await client.query("SELECT id FROM payments WHERE delivery_id=$1", [deliveryA.id])).rowCount, 1);
    assert.equal((await client.query("SELECT id FROM payments WHERE delivery_id=$1", [deliveryB.id])).rowCount, 0,
      "customer A must not read customer B's payment");
    assert.equal((await client.query("SELECT id FROM escrow_payment_attempts WHERE order_id=$1", [deliveryB.id])).rowCount, 0,
      "customer A must not read customer B's escrow attempts");

    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [unrelatedDriver]);
    assert.equal((await client.query("SELECT id FROM deliveries WHERE id=$1", [deliveryA.id])).rowCount, 0,
      "an unassigned driver must not read another customer's delivery");

    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [assignedDriver]);
    assert.equal((await client.query("SELECT id FROM deliveries WHERE id=$1", [deliveryA.id])).rowCount, 1,
      "the assigned driver must read the assigned delivery");

    await client.query("SELECT set_config('request.jwt.claim.sub','',true)");
    assert.equal((await client.query("SELECT id FROM users WHERE id=$1", [customerA])).rowCount, 0,
      "missing identity must not reveal protected user data");
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const support = await pool.connect();
  try {
    await support.query("BEGIN");
    await support.query("SET LOCAL ROLE swiftdrop_rls_support_test");
    await support.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [customerA]);

    await support.query("SAVEPOINT payment_write");
    await assert.rejects(
      support.query(
        `INSERT INTO payments(delivery_id,provider,provider_reference,amount_minor,currency,status)
         VALUES($1,'paystack',$2,100000,'NGN','HELD')`,
        [deliveryA.id, "RLS-UNAUTHORIZED-" + randomUUID()]
      ),
      (error: any) => error?.code === "42501"
    );
    await support.query("ROLLBACK TO SAVEPOINT payment_write");

    await support.query("SAVEPOINT escrow_write");
    await assert.rejects(
      support.query(
        `INSERT INTO escrow_payment_attempts(order_id,method,amount_minor,idempotency_key)
         VALUES($1,'PAYSTACK_CARD',100000,$2)`,
        [deliveryA.id, "RLS-UNAUTHORIZED-" + randomUUID()]
      ),
      (error: any) => error?.code === "42501"
    );
    await support.query("ROLLBACK TO SAVEPOINT escrow_write");
    await support.query("ROLLBACK");
  } catch (error) {
    await support.query("ROLLBACK");
    throw error;
  } finally {
    support.release();
  }
});

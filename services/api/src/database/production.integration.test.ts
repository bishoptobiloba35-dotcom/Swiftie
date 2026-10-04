import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pool } from "./db.js";
import { runMigrations } from "./migrate.js";
import {
  confirmReceiverAndReleaseEscrow,
  confirmReceiverOnDeliveryPaymentDue,
  settleReceiverPaymentAndReleasePayout,
  createDispute,
  createEligiblePayout,
  createPayment,
  createPersistentDelivery,
  prepareRefund,
  savePickupPhoto,
  transitionDelivery,
  updatePaymentStatus,
  updatePayoutProviderStatus
} from "./deliveryRepository.js";

const db = pool;

if (!db) {
  test("production database integration suite requires DATABASE_URL", { skip: true }, () => {});
} else {
  test("migrations are idempotent and core delivery escrow flow is transactional", async () => {
    const schemaUrl = new URL("./schema.sql", import.meta.url);
    const schema = await readFile(schemaUrl, "utf8");

    // CI provisions a dedicated empty PostgreSQL database for this suite.
    // Rebuilding the schema here keeps the test independent from migration order
    // outside the repository and verifies that every committed migration applies.
    await db.query(schema);
    await runMigrations();
    await runMigrations();

    const customer = (await db.query(
      `INSERT INTO users (role, full_name, phone, email)
       VALUES ('CUSTOMER','Integration Customer',$1,$2)
       RETURNING id`,
      [`+234900${Date.now()}`, `integration-${Date.now()}@example.test`]
    )).rows[0];

    const driverUser = (await db.query(
      `INSERT INTO users (role, full_name, phone, email)
       VALUES ('DRIVER','Integration Driver',$1,$2)
       RETURNING id`,
      [`+234901${Date.now()}`, `driver-${Date.now()}@example.test`]
    )).rows[0];

    const driver = (await db.query(
      "INSERT INTO drivers (user_id,status,online) VALUES ($1,'APPROVED',true) RETURNING id",
      [driverUser.id]
    )).rows[0];

    await db.query(
      `INSERT INTO driver_documents (driver_id,document_type,document_url,status)
       VALUES ($1,'DRIVER_LICENSE','integration://kyc','APPROVED')`,
      [driver.id]
    );

    const delivery = await createPersistentDelivery({
      senderId: customer.id,
      receiverName: "Integration Receiver",
      receiverPhone: "+2349020000000",
      declaredValueMinor: 250000,
      pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.0765, longitude: 7.3986 } },
      dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.4 } },
      receiverPin: "123456",
      weightKg: 2,
      dimensionsCm: { length: 20, width: 20, height: 20 },
      isPerishable: false,
      quote: {
        currency: "NGN",
        distanceMeters: 1000,
        durationSeconds: 450,
        baseFareMinor: 50000,
        distanceFareMinor: 18000,
        weightFareMinor: 10000,
        sizeFareMinor: 0,
        perishableSurchargeMinor: 0,
        fuelReferenceMinor: 50000,
        protectionReserveMinor: 10000,
        pricingVersion: 1,
        serviceFeeMinor: 3900,
        totalMinor: 91900
      }
    });

    await createPayment({ deliveryId: delivery.id, provider: "paystack", amountMinor: 91900 });
    const authorizedPayment = await updatePaymentStatus(delivery.id, "AUTHORIZED", "integration-payment");
    assert.ok(authorizedPayment);
    assert.equal(authorizedPayment.status, "AUTHORIZED");
    assert.equal((await transitionDelivery(delivery.id, "CREATED", "PAYMENT_AUTHORIZED"))?.status, "PAYMENT_AUTHORIZED");
    assert.equal((await transitionDelivery(delivery.id, "PAYMENT_AUTHORIZED", "DRIVER_ASSIGNED", driver.id))?.driverId, driver.id);
    assert.equal((await transitionDelivery(delivery.id, "DRIVER_ASSIGNED", "DRIVER_AT_PICKUP", driver.id))?.status, "DRIVER_AT_PICKUP");
    assert.equal((await savePickupPhoto(delivery.id, driver.id, "supabase://pickup/photo"))?.status, "PICKED_UP");
    assert.equal((await transitionDelivery(delivery.id, "PICKED_UP", "IN_TRANSIT", driver.id))?.status, "IN_TRANSIT");
    assert.equal((await transitionDelivery(delivery.id, "IN_TRANSIT", "ARRIVED", driver.id))?.status, "ARRIVED");
    await updatePaymentStatus(delivery.id, "HELD");

    const completed = await confirmReceiverAndReleaseEscrow(
      delivery.id,
      " +2349020000000".trim(),
      "123456",
      90
    );

    assert.ok(completed);
    assert.equal(completed.delivery.status, "DELIVERED");
    assert.equal(completed.payoutAmountMinor, 73710);

    const financial = (await db.query(
      `SELECT p.status AS payment_status, p.escrow_status,
              po.status AS payout_status, po.amount_minor
         FROM payments p
         LEFT JOIN payouts po ON po.delivery_id=p.delivery_id
        WHERE p.delivery_id=$1`,
      [delivery.id]
    )).rows[0];

    assert.equal(financial.payment_status, "RELEASED");
    assert.equal(financial.escrow_status, "RELEASED");
    assert.equal(financial.payout_status, "ELIGIBLE");
    assert.equal(Number(financial.amount_minor), 73710);

    const refundDelivery = await createPersistentDelivery({
      senderId: customer.id,
      receiverName: "Refund Receiver",
      receiverPhone: "+2349020000001",
      declaredValueMinor: 100000,
      pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.0765, longitude: 7.3986 } },
      dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.4 } },
      receiverPin: "654321",
      weightKg: 1,
      dimensionsCm: { length: 15, width: 15, height: 15 },
      isPerishable: false,
      quote: {
        currency: "NGN",
        distanceMeters: 1000,
        durationSeconds: 450,
        baseFareMinor: 100000,
        distanceFareMinor: 20000,
        weightFareMinor: 5000,
        sizeFareMinor: 0,
        perishableSurchargeMinor: 0,
        fuelReferenceMinor: 50000,
        protectionReserveMinor: 0,
        pricingVersion: 1,
        serviceFeeMinor: 6250,
        totalMinor: 131250
      }
    });

    await createPayment({ deliveryId: refundDelivery.id, provider: "paystack", amountMinor: 131250 });
    assert.ok(await updatePaymentStatus(refundDelivery.id, "AUTHORIZED", "refund-test-payment"));
    assert.ok(await updatePaymentStatus(refundDelivery.id, "HELD"));
    assert.ok(await createDispute(refundDelivery.id, customer.id, "DAMAGE", "Integration refund ceiling test"));
    assert.ok(await createEligiblePayout(refundDelivery.id, driver.id, 118125));

    assert.equal(await prepareRefund(refundDelivery.id, 100001), null);
    assert.equal(await prepareRefund(refundDelivery.id, 50001, 50000), null);

    const preparedRefund = await prepareRefund(refundDelivery.id, 50000, 60000);
    assert.ok(preparedRefund);
    assert.equal(preparedRefund.payout?.status, "CANCELLED");

    const raceDelivery = await createPersistentDelivery({
      senderId: customer.id,
      receiverName: "Race Receiver",
      receiverPhone: "+2349020000002",
      declaredValueMinor: 150000,
      pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.0765, longitude: 7.3986 } },
      dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.4 } },
      receiverPin: "111222",
      weightKg: 1,
      dimensionsCm: { length: 15, width: 15, height: 15 },
      isPerishable: false,
      quote: {
        currency: "NGN",
        distanceMeters: 1000,
        durationSeconds: 450,
        baseFareMinor: 100000,
        distanceFareMinor: 20000,
        weightFareMinor: 5000,
        sizeFareMinor: 0,
        perishableSurchargeMinor: 0,
        fuelReferenceMinor: 50000,
        protectionReserveMinor: 0,
        pricingVersion: 1,
        serviceFeeMinor: 6250,
        totalMinor: 131250
      }
    });
    await createPayment({ deliveryId: raceDelivery.id, provider: "paystack", amountMinor: 131250 });
    assert.ok(await updatePaymentStatus(raceDelivery.id, "AUTHORIZED", "race-test-payment"));
    assert.ok(await transitionDelivery(raceDelivery.id, "CREATED", "PAYMENT_AUTHORIZED"));
    assert.ok(await transitionDelivery(raceDelivery.id, "PAYMENT_AUTHORIZED", "DRIVER_ASSIGNED", driver.id));
    assert.ok(await transitionDelivery(raceDelivery.id, "DRIVER_ASSIGNED", "DRIVER_AT_PICKUP", driver.id));
    assert.ok(await savePickupPhoto(raceDelivery.id, driver.id, "supabase://race/pickup"));
    assert.ok(await transitionDelivery(raceDelivery.id, "PICKED_UP", "IN_TRANSIT", driver.id));
    assert.ok(await transitionDelivery(raceDelivery.id, "IN_TRANSIT", "ARRIVED", driver.id));
    assert.ok(await updatePaymentStatus(raceDelivery.id, "HELD"));
    await db.query(
      `UPDATE payments
          SET refund_status='pending', refund_amount_minor=50000, refund_reference='pending-race-test', refund_updated_at=now()
        WHERE delivery_id=$1`,
      [raceDelivery.id]
    );
    assert.equal(await confirmReceiverAndReleaseEscrow(raceDelivery.id, "+2349020000002", "111222", 90), null);
    const raceState = (await db.query(
      `SELECT d.status, p.status AS payment_status
         FROM deliveries d JOIN payments p ON p.delivery_id=d.id
        WHERE d.id=$1`,
      [raceDelivery.id]
    )).rows[0];
    assert.equal(raceState.status, "ARRIVED");
    assert.equal(raceState.payment_status, "HELD");
    const receiverPaidDelivery = await createPersistentDelivery({
      senderId: customer.id,
      receiverName: "Receiver Pays Customer",
      receiverPhone: "+2349020000003",
      declaredValueMinor: 200000,
      paymentMode: "RECEIVER_ON_DELIVERY",
      pickup: { label: "Pickup", formattedAddress: "Pickup", location: { latitude: 9.0765, longitude: 7.3986 } },
      dropoff: { label: "Dropoff", formattedAddress: "Dropoff", location: { latitude: 9.08, longitude: 7.4 } },
      receiverPin: "333444",
      weightKg: 2,
      dimensionsCm: { length: 20, width: 20, height: 20 },
      isPerishable: false,
      quote: { currency: "NGN", distanceMeters: 1000, durationSeconds: 450, baseFareMinor: 50000, distanceFareMinor: 18000, weightFareMinor: 10000, sizeFareMinor: 0, perishableSurchargeMinor: 0, fuelReferenceMinor: 50000, protectionReserveMinor: 20000, pricingVersion: 1, serviceFeeMinor: 7800, totalMinor: 105800 }
    });
    await createPayment({ deliveryId: receiverPaidDelivery.id, provider: "paystack", amountMinor: 105800, collectionMode: "RECEIVER_ON_DELIVERY" });
    assert.equal(receiverPaidDelivery.paymentMode, "RECEIVER_ON_DELIVERY");
    assert.equal((await transitionDelivery(receiverPaidDelivery.id, "CREATED", "DRIVER_ASSIGNED", driver.id))?.driverId, driver.id);
    assert.equal((await transitionDelivery(receiverPaidDelivery.id, "DRIVER_ASSIGNED", "DRIVER_AT_PICKUP", driver.id))?.status, "DRIVER_AT_PICKUP");
    assert.equal((await savePickupPhoto(receiverPaidDelivery.id, driver.id, "supabase://receiver-paid/pickup"))?.status, "PICKED_UP");
    assert.equal((await transitionDelivery(receiverPaidDelivery.id, "PICKED_UP", "IN_TRANSIT", driver.id))?.status, "IN_TRANSIT");
    assert.equal((await transitionDelivery(receiverPaidDelivery.id, "IN_TRANSIT", "ARRIVED", driver.id))?.status, "ARRIVED");
    const receiverConfirmed = await confirmReceiverOnDeliveryPaymentDue(receiverPaidDelivery.id, "+2349020000003", "333444");
    assert.ok(receiverConfirmed);
    assert.equal(receiverConfirmed.status, "ARRIVED");
    assert.ok(receiverConfirmed.receiverConfirmedAt);
    const beforeReceiverPayment = (await db.query(
      "SELECT p.status AS payment_status, p.escrow_status, d.status AS delivery_status FROM payments p JOIN deliveries d ON d.id=p.delivery_id WHERE p.delivery_id=$1",
      [receiverPaidDelivery.id]
    )).rows[0];
    assert.equal(beforeReceiverPayment.payment_status, "PENDING");
    assert.equal(beforeReceiverPayment.escrow_status, "NOT_APPLICABLE");
    assert.equal(beforeReceiverPayment.delivery_status, "ARRIVED");
    assert.equal(await settleReceiverPaymentAndReleasePayout(receiverPaidDelivery.id, "SD-RECEIVER-PAYMENT-1", 105799, "NGN", 90), null);
    const settledReceiver = await settleReceiverPaymentAndReleasePayout(receiverPaidDelivery.id, "SD-RECEIVER-PAYMENT-1", 105800, "NGN", 90);
    assert.ok(settledReceiver);
    assert.equal(settledReceiver.delivery.status, "DELIVERED");
    assert.equal(settledReceiver.payoutAmountMinor, 77220);
    const receiverFinancial = (await db.query(
      "SELECT p.status AS payment_status, p.escrow_status, p.collection_mode, d.status AS delivery_status, po.status AS payout_status FROM payments p JOIN deliveries d ON d.id=p.delivery_id LEFT JOIN payouts po ON po.delivery_id=d.id WHERE p.delivery_id=$1",
      [receiverPaidDelivery.id]
    )).rows[0];
    assert.equal(receiverFinancial.payment_status, "RELEASED");
    assert.equal(receiverFinancial.escrow_status, "NOT_APPLICABLE");
    assert.equal(receiverFinancial.collection_mode, "RECEIVER_ON_DELIVERY");
    assert.equal(receiverFinancial.delivery_status, "DELIVERED");
    assert.equal(receiverFinancial.payout_status, "ELIGIBLE");

    await db.query(
      `UPDATE payouts
          SET status='PROCESSING', provider='paystack', provider_reference='SD-PAYOUT-MISMATCH-1', updated_at=now()
        WHERE delivery_id=$1`,
      [receiverPaidDelivery.id]
    );
    const mismatchedPayout = await updatePayoutProviderStatus(
      "SD-PAYOUT-MISMATCH-1",
      "RELEASED",
      null,
      105799,
      "NGN"
    );
    assert.ok(mismatchedPayout);
    assert.equal(mismatchedPayout.status, "FAILED");
    assert.equal(mismatchedPayout.providerStatus, "amount_mismatch");
    const mismatchState = (await db.query(
      `SELECT status, provider_status, failure_reason
         FROM payouts
        WHERE provider_reference='SD-PAYOUT-MISMATCH-1'`
    )).rows[0];
    assert.equal(mismatchState.status, "FAILED");
    assert.equal(mismatchState.provider_status, "amount_mismatch");
    const agentUser = await db.query(
      `INSERT INTO users(full_name,phone,email,password_hash,role)
       VALUES('Marketplace Agent','+2349020000099','marketplace-agent@example.test','integration-hash','AGENT')
       RETURNING id`
    );
    const agentUserId = agentUser.rows[0].id;
    await db.query(`INSERT INTO agent_profiles(user_id,status) VALUES($1,'APPROVED')`, [agentUserId]);
    const seller = await db.query(
      `INSERT INTO marketplace_seller_profiles(user_id,display_name,bio,location_label)
       VALUES($1,'SwiftDrop Agent Store','Fresh listings from this seller','Abuja')
       RETURNING id`,
      [agentUserId]
    );
    const listing = await db.query(
      `INSERT INTO marketplace_listings
       (seller_user_id,seller_profile_id,title,description,condition,use_description,usage_instructions,category,price_minor,delivery_fee_minor,final_price_minor,currency,delivery_mode,stock_quantity)
       VALUES($1,$2,'Test product','Detailed marketplace product description','GOOD','Everyday household use','Use according to the included product instructions.','General',100000,15000,115000,'NGN','SAME_STATE',3)
       RETURNING *`,
      [agentUserId,seller.rows[0].id]
    );
    assert.equal(Number(listing.rows[0].final_price_minor), 115000);
    assert.equal(listing.rows[0].delivery_mode, "SAME_STATE");
    const marketplaceOrder = await db.query(
      `INSERT INTO marketplace_orders
       (listing_id,buyer_user_id,seller_user_id,quantity,unit_final_price_minor,total_minor,currency,requested_delivery_at,checkout_idempotency_key)
       VALUES($1,$2,$3,2,115000,230000,'NGN',now() + interval '2 days','integration-marketplace-checkout-1')
       RETURNING *`,
      [listing.rows[0].id, customer.id, agentUserId]
    );
    assert.equal(Number(marketplaceOrder.rows[0].total_minor), 230000);
    assert.ok(marketplaceOrder.rows[0].requested_delivery_at instanceof Date || marketplaceOrder.rows[0].requested_delivery_at);
    assert.equal(marketplaceOrder.rows[0].checkout_idempotency_key, "integration-marketplace-checkout-1");
    const checkoutKeyIndex = (await db.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_marketplace_orders_buyer_checkout_key'`
    )).rowCount;
    assert.equal(checkoutKeyIndex, 1);
    const orderHistoryIndex = (await db.query("SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_marketplace_orders_buyer_status_created'")).rowCount;
    assert.equal(orderHistoryIndex, 1);

    const marketplacePayment = await db.query(
      `INSERT INTO marketplace_order_payments
       (marketplace_order_id,buyer_user_id,provider,provider_reference,amount_minor,currency,status,provider_status)
       VALUES($1,$2,'paystack','SD-MKT-INTEGRATION-1',230000,'NGN','PENDING','pending')
       RETURNING *`,
      [marketplaceOrder.rows[0].id, customer.id]
    );
    assert.equal(marketplacePayment.rows[0].status, "PENDING");
    const paymentMismatch = await db.query(
      `SELECT COUNT(*)::int AS count FROM marketplace_order_payments
        WHERE provider_reference='SD-MKT-INTEGRATION-1' AND amount_minor=230000 AND currency='NGN'`
    );
    assert.equal(paymentMismatch.rows[0].count, 1);

    await db.query(
      `UPDATE marketplace_order_payments SET status='AUTHORIZED',provider_status='success',updated_at=now() WHERE id=$1`,
      [marketplacePayment.rows[0].id]
    );
    await db.query(
      `UPDATE marketplace_orders SET status='PAID',updated_at=now() WHERE id=$1 AND status='PENDING_PAYMENT'`,
      [marketplaceOrder.rows[0].id]
    );
    const paidMarketplace = (await db.query(
      `SELECT mo.status AS order_status,mop.status AS payment_status
         FROM marketplace_orders mo JOIN marketplace_order_payments mop ON mop.marketplace_order_id=mo.id
        WHERE mo.id=$1`,
      [marketplaceOrder.rows[0].id]
    )).rows[0];
    assert.equal(paidMarketplace.order_status, "PAID");
    assert.equal(paidMarketplace.payment_status, "AUTHORIZED");

    const stockReservation = await db.query(
      `UPDATE marketplace_listings
          SET stock_quantity = stock_quantity - $2,
              status = CASE WHEN stock_quantity - $2 = 0 THEN 'SOLD_OUT' ELSE status END,
              updated_at = now()
        WHERE id=$1 AND status='PUBLISHED' AND stock_quantity >= $2
        RETURNING stock_quantity,status`,
      [listing.rows[0].id, 1]
    );
    assert.equal(Number(stockReservation.rows[0].stock_quantity), 2);
    assert.equal(stockReservation.rows[0].status, "PUBLISHED");

    const exhausted = await db.query(
      `UPDATE marketplace_listings
          SET stock_quantity = stock_quantity - $2,
              status = CASE WHEN stock_quantity - $2 = 0 THEN 'SOLD_OUT' ELSE status END,
              updated_at = now()
        WHERE id=$1 AND status='PUBLISHED' AND stock_quantity >= $2
        RETURNING stock_quantity,status`,
      [listing.rows[0].id, 2]
    );
    assert.equal(Number(exhausted.rows[0].stock_quantity), 0);
    assert.equal(exhausted.rows[0].status, "SOLD_OUT");

    const blockedAfterSellOut = await db.query(
      `UPDATE marketplace_listings
          SET stock_quantity = stock_quantity - $2
        WHERE id=$1 AND status='PUBLISHED' AND stock_quantity >= $2
        RETURNING id`,
      [listing.rows[0].id, 1]
    );
    assert.equal(blockedAfterSellOut.rowCount, 0);

    const fixedCommission = (await db.query(
      `SELECT column_default, pg_get_constraintdef(c.oid) AS constraint_definition
         FROM information_schema.columns col
         LEFT JOIN pg_constraint c
           ON c.conrelid='drop_off_commission_ledger'::regclass
          AND c.conname='drop_off_commission_fixed_amount_check'
        WHERE col.table_schema='public'
          AND col.table_name='drop_off_commission_ledger'
          AND col.column_name='amount_minor'`
    )).rows[0];
    assert.match(String(fixedCommission.column_default), /50000/);
    assert.match(String(fixedCommission.constraint_definition), /50000/);

    const authorizationTable = (await db.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='business_payment_authorizations'`
    )).rows.map((row: any) => row.column_name);
    assert.ok(authorizationTable.includes("business_id"));
    assert.ok(authorizationTable.includes("authorization_code"));
    assert.ok(authorizationTable.includes("status"));
  });
}

after(async () => {
  if (db) await db.end();
});

# SwiftDrop Driver Payouts

## Flow

1. An authenticated courier selects a Nigerian bank from Paystack's bank directory. The API caches the directory for 24 hours.
2. The courier enters the account number and account-holder name. The server resolves the account through Paystack and compares the resolved first and last names with the courier's legal name, ignoring middle names and supported honorifics.
3. A matching account is marked verified. A mismatch is saved as unverified and cannot receive payouts; the driver sees: "We couldn't verify the account name. Our team will review this within 24 hours."
4. On the first payout request, the server locks the driver row and creates a Paystack transfer recipient only if the account is verified and no recipient code exists. The code is stored and reused.
5. A standard payout transfers the eligible delivery payout amount with no transfer fee. An instant payout applies 1% with a minimum fee of ₦50 and a maximum fee of ₦500. The API stores gross amount, fee, and net amount in minor units. Standard requests below ₦100 are rejected.
6. The API reserves a stable payout reference before calling Paystack. A timeout leaves the payout processing for reconciliation; the API does not send a second transfer for the same payout.
7. Paystack's signed `transfer.success`, `transfer.failed`, and `transfer.reversed` webhooks are durably recorded and deduplicated. Driver payout state changes and reversal clawbacks are processed in a database transaction.
8. Daily reconciliation lists Paystack transfers for the last 25 hours after 18:00 WAT, compares them with local in-flight payouts, records a `reconciliation_runs` row, and alerts administrators when mismatches exist.

## Failure handling

- Invalid Paystack signatures are rejected before webhook processing.
- Replayed provider events are acknowledged idempotently.
- Amount or currency mismatches never mark a payout successful; they flag the payout and alert administrators.
- A Paystack initiation timeout is inconclusive. Keep the same reference and let the reconciliation worker verify it.
- Failed transfers are not automatically retried. An administrator must review the provider record and explicitly decide whether to re-queue the eligible payout.
- A reversal after release marks the payout `REVERSED` and attempts an idempotent debit from the courier wallet. If the wallet is missing or lacks funds, an administrator notification is created for manual recovery.
- Payouts above ₦1,000,000 are marked as requiring administrator approval and are not sent by the courier request endpoint until an authenticated admin uses POST /api/admin/payouts/:deliveryId/approve. Approval records the admin identity, timestamp, delivery event, and admin case audit.
- A driver may initiate at most one payout request per minute.

## Manual retry procedure (admin only)

1. Find the payout by its local payout ID and provider reference.
2. Inspect the Paystack dashboard and call Paystack's transfer-verify endpoint for the exact reference.
3. Check the latest `reconciliation_runs`, webhook event status, amount/currency, and wallet ledger.
4. Do not re-send a transfer if Paystack shows it as pending, successful, or already associated with that reference.
5. Only after Paystack confirms the original transfer failed and the failure has been reviewed should an administrator reset that payout to an eligible state. Keep the original provider reference in audit history; use a new idempotency key/reference for an explicitly approved new attempt.
6. Record the administrator, reason, original reference, and replacement reference in the admin case audit.

## Reconciliation runbook

- The API checks after 18:00 in the `Africa/Lagos` time zone and runs once per WAT calendar day.
- Each run queries the last 25 hours of transfers, updates known terminal statuses through the same payout webhook state handler, and records provider/local counts and mismatch details.
- For a provider transfer without a local payout, a local processing/pending payout without a provider record, or an amount/currency mismatch, inspect the Paystack dashboard before changing ledger state.
- Resolve discrepancies manually with an audit note. Do not delete or rewrite historical audit rows.

## Reversal / rollback

A completed bank transfer cannot be undone by changing the local database. Contact Paystack and follow its supported reversal/recall process, then confirm the provider event/status. The signed `transfer.reversed` event changes the local payout state and attempts a ledger debit. If the debit cannot be completed, resolve the resulting administrator alert and record the outstanding recovery in the financial audit trail.

## Security and live verification

- Paystack secret keys are server-only; production startup rejects missing keys and `sk_test_` keys.
- Account numbers are never included in API responses or structured log fields. Logs identify payouts by internal ID and provider reference only.
- The production database connection must use the trusted service role required by the existing RLS startup guard.
- Automated tests do not prove that money reached a bank account. Item 4 remains incomplete until a real ₦100 transfer is confirmed by Paystack webhook, Paystack dashboard, and the receiving bank statement. Attach redacted screenshots and the transaction reference to the PR; never commit account numbers or bank statements containing unrelated private data.

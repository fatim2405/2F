/**
 * A fully settled and PAID day must reconcile to gap 0. The real settlement
 * service writes payout ledger legs (tagged with settlement_batch_id) when a
 * batch is paid; those must not be subtracted a second time. Requires
 * DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { getReconciliationReport } from "./query.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("reconciliationPayout.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => {
  await pool.end();
});

const DAY = "2026-08-12";
const NEXT = "2026-08-13";
const AT = "2026-08-12T09:00:00Z"; // midday Asia/Bahrain

async function paidDay(withPayoutLegs: boolean) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 275) RETURNING id`,
    [`Recon Payout ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const group = randomUUID();
  // Capture of 4,750 with a 131 fee — the same legs capture.ts writes.
  await pool.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description) VALUES
       ($1, $2, 'card_scheme_clearing', 'debit',  4750, $3, 'capture: gross'),
       ($1, $2, 'merchant_payable',     'credit', 4750, $3, 'capture: gross'),
       ($1, $2, 'merchant_payable',     'debit',   131, $3, 'capture: MDR fee'),
       ($1, $2, 'platform_fee_revenue', 'credit',  131, $3, 'capture: MDR fee')`,
    [group, merchantId, AT],
  );
  const b = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
     VALUES ($1, $2, 'paid', 4750, 131, 4619, $3) RETURNING id`,
    [merchantId, DAY, AT],
  );
  if (withPayoutLegs) {
    // Exactly what apps/settlement's payout writes (batch.go).
    await pool.query(
      `INSERT INTO ledger_entries (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description) VALUES
         ($1, $2, $3, 'merchant_payable', 'debit',  4619, $4, 'settlement payout: batch paid'),
         ($1, $2, $3, 'platform_cash',    'credit', 4619, $4, 'settlement payout: batch paid')`,
      [randomUUID(), merchantId, b.rows[0]!.id, AT],
    );
  }
  return merchantId;
}

test("a paid day with real payout ledger legs reconciles to gap 0", async () => {
  const merchantId = await paidDay(true);
  const r = await getReconciliationReport(pool, { merchantId, from: DAY, to: NEXT });
  assert.equal(r.settlementNetPayoutFils, 4619);
  assert.equal(r.ledgerMerchantPayableNetFils, 4619, "earned in the window: 4,750 − 131");
  assert.equal(r.gapFils, 0);
  assert.equal(r.explained, true);
});

test("a closed day before payout also reconciles to gap 0", async () => {
  const merchantId = await paidDay(false);
  const r = await getReconciliationReport(pool, { merchantId, from: DAY, to: NEXT });
  assert.equal(r.gapFils, 0);
});

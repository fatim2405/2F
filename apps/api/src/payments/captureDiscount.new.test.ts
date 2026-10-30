/**
 * The negotiated discount is part of the capture fee, computed exactly as
 * settlement's ComputeSettlementFee does (the reference), for both the
 * transactions route and payment-link checkout (which never applied it).
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { payPaymentLink } from "../paymentLinks/pay.js";
import type { AcquirerSimulator } from "../acquirer/types.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("captureDiscount.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

/** Delta Marketplace's terms in the seed: 2.75% MDR, 12.5% negotiated discount. */
async function deltaLikeMerchant() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, 275, 1250) RETURNING id`,
    [`Discount Capture ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  return merchantId;
}

/** Fee FilsPay keeps for a transaction, per the ledger (credits minus debits on fee revenue). */
async function ledgerFee(transactionId: string): Promise<number> {
  const r = await pool.query<{ fee: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS fee
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [transactionId],
  );
  return Number(r.rows[0]!.fee);
}

test("a 100 BD capture for a 2.75% / 12.5%-discount shop records a 2,406 fils fee in one step", async () => {
  const merchantId = await deltaLikeMerchant();
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" });
  const auth = { authorization: `Bearer ${rawKey}` };
  const a = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...auth, "idempotency-key": randomUUID() },
    payload: { amountFils: 100_000, card: CARD },
  });
  assert.equal(a.statusCode, 201, a.body);
  const id = (a.json() as { id: string }).id;
  const c = await app.inject({ method: "POST", url: `/v1/transactions/${id}/capture`, headers: { ...auth, "idempotency-key": randomUUID() }, payload: {} });
  assert.equal(c.statusCode, 200, c.body);

  // ComputeSettlementFee: (100,000 - 12,500) x 2.75% = 2,406.25 -> 2,406.
  assert.equal(await ledgerFee(id), 2406, "not 2,750");
  const adj = await pool.query(`SELECT 1 FROM ledger_entries WHERE transaction_id = $1 AND description = 'capture: negotiated discount adjustment'`, [id]);
  assert.equal(adj.rowCount, 0, "no separate after-the-fact adjustment");
});

test("payment-link checkout applies the discount too (it never did)", async () => {
  const merchantId = await deltaLikeMerchant();
  const token = `plink_${randomUUID()}`;
  await pool.query(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 100000, now() + interval '1 hour', 'merchant_session', $3)`,
    [merchantId, token, randomUUID()],
  );
  const instant: AcquirerSimulator = {
    authorize: async () => ({ outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 }),
    capture: async (r) => ({ outcome: "approved", acquirerReference: r.acquirerReference, latencyMs: 0 }),
    refund: async (r) => ({ outcome: "approved", acquirerReference: r.acquirerReference, latencyMs: 0 }),
  };
  const res = await payPaymentLink(pool, instant, { paymentLinkReservationTimeoutSeconds: 60 }, {
    token,
    card: CARD,
    idempotencyKey: randomUUID(),
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const link = await pool.query<{ transaction_id: string }>(`SELECT transaction_id FROM payment_links WHERE token = $1`, [token]);
  assert.equal(await ledgerFee(link.rows[0]!.transaction_id), 2406, "payment links were charged the full 2,750");
});

/**
 * Payment-link fixes: cross-merchant cancel, expiry judged on the server's
 * clock (FP-187), and a slow first payment can't lead to two charges
 * (incident 2026-05-14). Requires DATABASE_URL to point at a real, migrated
 * Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { createPaymentLink } from "./create.js";
import { cancelPaymentLink } from "./cancel.js";
import { payPaymentLink } from "./pay.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("linkSecurity.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
test.after(async () => {
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function merchant(): Promise<string> {
  const r = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`Link Sec ${randomUUID()}`]);
  // Payments are only accepted for KYC-approved merchants.
  await recordKycReview(pool, { merchantId: r.rows[0]!.id, outcome: "approved", reviewerIdentifier: "test" });
  return r.rows[0]!.id;
}
async function link(merchantId: string, expiresAt = new Date(Date.now() + 3_600_000).toISOString()) {
  // Insert directly so an already-expired link can be created for the expiry test.
  const token = `plink_${randomUUID()}`;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 4750, $3, 'merchant_session', $4) RETURNING id`,
    [merchantId, token, expiresAt, randomUUID()],
  );
  return { id: r.rows[0]!.id, token };
}
async function linkStatus(id: string) {
  const r = await pool.query<{ status: string; transaction_id: string | null }>(`SELECT status, transaction_id FROM payment_links WHERE id = $1`, [id]);
  return r.rows[0]!;
}

test("a merchant can't cancel another merchant's payment link", async () => {
  const a = await merchant();
  const b = await merchant();
  const l = await link(a);
  assert.deepEqual(await cancelPaymentLink(pool, { id: l.id, merchantId: b }), { outcome: "not_found" });
  assert.equal((await linkStatus(l.id)).status, "active");
  assert.deepEqual(await cancelPaymentLink(pool, { id: l.id, merchantId: a }), { outcome: "canceled" });
});

test("an expired link can't be paid by sending an earlier submittedAt (FP-187)", async () => {
  const m = await merchant();
  const l = await link(m, new Date(Date.now() - 60_000).toISOString());
  const instant: AcquirerSimulator = {
    authorize: async () => ({ outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 }),
    capture: async (r) => ({ outcome: "approved", acquirerReference: r.acquirerReference, latencyMs: 0 }),
    refund: async (r) => ({ outcome: "approved", acquirerReference: r.acquirerReference, latencyMs: 0 }),
  };
  const res = await payPaymentLink(pool, instant, { paymentLinkReservationTimeoutSeconds: 60 }, {
    token: l.token,
    card: CARD,
    idempotencyKey: randomUUID(),
    submittedAt: new Date(Date.now() - 3_600_000).toISOString(), // "I pressed pay an hour ago"
  });
  assert.equal(res.statusCode, 410);
  assert.equal((await linkStatus(l.id)).status, "active");
});

test("a slow first payment that loses its reservation is voided, so only one buyer is charged (incident 2026-05-14)", async () => {
  const m = await merchant();
  const l = await link(m);
  let calls = 0;
  const slowFirst: AcquirerSimulator = {
    async authorize() {
      calls += 1;
      if (calls === 1) await sleep(2_500); // first buyer: bank is slow, past the 1 s reservation timeout
      return { outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 };
    },
    capture: async (r) => ({ outcome: "approved", acquirerReference: r.acquirerReference, latencyMs: 0 }),
    refund: async (r) => ({ outcome: "approved", acquirerReference: r.acquirerReference, latencyMs: 0 }),
  };
  const cfg = { paymentLinkReservationTimeoutSeconds: 1 };

  const first = payPaymentLink(pool, slowFirst, cfg, { token: l.token, card: CARD, idempotencyKey: randomUUID() });
  await sleep(1_400); // first buyer's reservation is now stale
  const second = await payPaymentLink(pool, slowFirst, cfg, { token: l.token, card: CARD, idempotencyKey: randomUUID() });
  const firstResult = await first;

  assert.equal(second.statusCode, 200, JSON.stringify(second.body));
  assert.equal(firstResult.statusCode, 409, JSON.stringify(firstResult.body));

  const txns = await pool.query<{ status: string; captured_fils: string }>(
    `SELECT status, captured_fils FROM transactions WHERE merchant_id = $1 ORDER BY created_at`,
    [m],
  );
  assert.deepEqual(txns.rows.map((t) => t.status).sort(), ["captured", "voided"], "one charged, one hold released");
  assert.equal(txns.rows.filter((t) => Number(t.captured_fils) > 0).length, 1, "exactly one buyer charged");
  assert.equal((await linkStatus(l.id)).status, "paid");
});

void toFils;
void createPaymentLink;

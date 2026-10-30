/**
 * Refund fixes, round 2: a bank call that throws releases the reserved
 * amount; partial-refund fee reversals sum exactly to the fee charged; a
 * capture after a refund keeps the refund in its status; validation errors
 * reach the dashboard with an error code and a readable message.
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { processRefund } from "./processRefund.js";
import type { AcquirerSimulator } from "../acquirer/types.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("refundFixes2.new.test.ts requires DATABASE_URL");
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
const ok: AcquirerSimulator = {
  authorize: async () => ({ outcome: "approved", acquirerReference: `acq_${randomUUID()}`, latencyMs: 0 }),
  capture: async (r) => ({ outcome: "approved", acquirerReference: r.acquirerReference, latencyMs: 0 }),
  refund: async (r) => ({ outcome: "approved", acquirerReference: r.acquirerReference, latencyMs: 0 }),
};

async function shop(mdrBps: number) {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`, [
    `Refund2 ${randomUUID()}`,
    mdrBps,
  ]);
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" });
  return { merchantId, auth: { authorization: `Bearer ${rawKey}` }, actorId: u.rows[0]!.id };
}
async function authorize(auth: Record<string, string>, amountFils: number): Promise<string> {
  const a = await app.inject({ method: "POST", url: "/v1/transactions", headers: { ...auth, "idempotency-key": randomUUID() }, payload: { amountFils, card: CARD } });
  assert.equal(a.statusCode, 201, a.body);
  return (a.json() as { id: string }).id;
}
async function capture(auth: Record<string, string>, id: string, amountFils?: number) {
  const c = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { ...auth, "idempotency-key": randomUUID() },
    payload: amountFils === undefined ? {} : { amountFils },
  });
  assert.equal(c.statusCode, 200, c.body);
}
const refund = (s: { merchantId: string; actorId: string }, transactionId: string, amount: number, acquirer = ok, key = randomUUID()) =>
  processRefund(pool, acquirer, {
    transactionId,
    merchantId: s.merchantId,
    amountFils: toFils(amount),
    idempotencyKey: key,
    actor: { type: "merchant_api_key", id: s.actorId },
  });
const txnRow = async (id: string) =>
  (await pool.query<{ status: string; refunded_fils: string }>(`SELECT status, refunded_fils FROM transactions WHERE id = $1`, [id])).rows[0]!;

test("a bank call that throws releases the reserved amount and leaves the key retryable", async () => {
  const s = await shop(250);
  const id = await authorize(s.auth, 10_000);
  await capture(s.auth, id);
  const throwing: AcquirerSimulator = { ...ok, refund: async () => { throw new Error("socket hang up"); } };
  const key = randomUUID();
  const failed = await refund(s, id, 4000, throwing, key);
  assert.equal(failed.statusCode, 502);
  assert.equal(Number((await txnRow(id)).refunded_fils), 0, "was stuck at 4000 with no refund behind it");
  const retry = await refund(s, id, 4000, ok, key);
  assert.equal(retry.statusCode, 200, `same key retries (was 409 request_in_progress): ${JSON.stringify(retry.body)}`);
  assert.equal(Number((await txnRow(id)).refunded_fils), 4000);
});

test("two half refunds reverse exactly the fee charged (15, not 8 + 8 = 16)", async () => {
  const s = await shop(150); // 1.5% of 1,000 fils = 15 fils
  const id = await authorize(s.auth, 1000);
  await capture(s.auth, id);
  assert.equal((await refund(s, id, 500)).statusCode, 200);
  assert.equal((await refund(s, id, 500)).statusCode, 200);
  const r = await pool.query<{ total: string }>(`SELECT SUM(fee_reversed_fils)::text AS total FROM refunds WHERE transaction_id = $1`, [id]);
  assert.equal(Number(r.rows[0]!.total), 15);
});

test("capturing the rest after a refund leaves the payment partially refunded, not captured", async () => {
  const s = await shop(250);
  const id = await authorize(s.auth, 10_000);
  await capture(s.auth, id, 4000);
  assert.equal((await refund(s, id, 4000)).statusCode, 200);
  await capture(s.auth, id, 6000);
  assert.equal((await txnRow(id)).status, "partially_refunded");
});

test("a refund that is too large comes back with an error code and a BD message", async () => {
  const s = await shop(250);
  const id = await authorize(s.auth, 10_000);
  await capture(s.auth, id);
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${s.merchantId}/refunds`,
    headers: { ...s.auth, "idempotency-key": randomUUID() },
    payload: { transactionId: id, amountFils: 20_000 },
  });
  assert.equal(res.statusCode, 422, res.body);
  const body = res.json() as { error: string; message: string };
  assert.equal(body.error, "refund_exceeds_refundable");
  assert.equal(body.message, "You can refund at most 10.000 BHD.");
});

/**
 * POST /v1/merchants/:merchantId/refunds end to end through the route.
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
import { startImpersonation } from "../admin/impersonation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("merchantRefunds.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
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

async function merchantWithKey(opts: { discountBps?: number } = {}) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, 250, $2) RETURNING id`,
    [`Refund Route ${randomUUID()}`, opts.discountBps ?? 0],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "refund route test" });
  return { merchantId, rawKey };
}

async function captured(rawKey: string, amountFils: number): Promise<string> {
  const a = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: CARD, reference: "refund-route-test" },
  });
  assert.equal(a.statusCode, 201, a.body);
  const id = (a.json() as { id: string }).id;
  const c = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(c.statusCode, 200, c.body);
  return id;
}

function refund(rawKey: string, merchantId: string, payload: unknown, key: string | null = randomUUID()) {
  return app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/refunds`,
    headers: { authorization: `Bearer ${rawKey}`, ...(key ? { "idempotency-key": key } : {}) },
    payload: payload as Record<string, unknown>,
  });
}

async function refundRows(transactionId: string) {
  const r = await pool.query<{ amount_fils: string; fee_reversed_fils: string }>(
    `SELECT amount_fils, fee_reversed_fils FROM refunds WHERE transaction_id = $1`,
    [transactionId],
  );
  return r.rows.map((x) => ({ amount: Number(x.amount_fils), feeReversed: Number(x.fee_reversed_fils) }));
}

test("a merchant can fully refund its own captured transaction through the route", async () => {
  const { merchantId, rawKey } = await merchantWithKey();
  const txn = await captured(rawKey, 10_000);
  const res = await refund(rawKey, merchantId, { transactionId: txn });
  assert.ok(res.statusCode === 200 || res.statusCode === 201, res.body);
  assert.deepEqual(await refundRows(txn), [{ amount: 10_000, feeReversed: 250 }]);
});

test("merchant B cannot refund merchant A's transaction (404, nothing written)", async () => {
  const a = await merchantWithKey();
  const b = await merchantWithKey();
  const aTxn = await captured(a.rawKey, 5_000);
  const res = await refund(b.rawKey, b.merchantId, { transactionId: aTxn });
  assert.equal(res.statusCode, 404, res.body);
  assert.deepEqual(await refundRows(aTxn), []);
});

test("the path merchant must be the caller's own (403)", async () => {
  const a = await merchantWithKey();
  const b = await merchantWithKey();
  const aTxn = await captured(a.rawKey, 5_000);
  const res = await refund(b.rawKey, a.merchantId, { transactionId: aTxn });
  assert.equal(res.statusCode, 403, res.body);
  assert.deepEqual(await refundRows(aTxn), []);
});

test("a discounted merchant gets back only the fee it actually paid", async () => {
  // 10% negotiated discount: fee 2.5% of 10,000 = 250, discount 25, kept 225.
  const { merchantId, rawKey } = await merchantWithKey({ discountBps: 1_000 });
  const txn = await captured(rawKey, 10_000);
  const res = await refund(rawKey, merchantId, { transactionId: txn });
  assert.ok(res.statusCode === 200 || res.statusCode === 201, res.body);
  assert.deepEqual(await refundRows(txn), [{ amount: 10_000, feeReversed: 225 }], "not 250: the discount must not be returned twice");
});

test("retrying with the same Idempotency-Key refunds once", async () => {
  const { merchantId, rawKey } = await merchantWithKey();
  const txn = await captured(rawKey, 4_000);
  const key = randomUUID();
  const first = await refund(rawKey, merchantId, { transactionId: txn, amountFils: 1_000 }, key);
  const second = await refund(rawKey, merchantId, { transactionId: txn, amountFils: 1_000 }, key);
  assert.equal(second.statusCode, first.statusCode);
  assert.equal((await refundRows(txn)).length, 1);
});

test("bad requests are rejected before anything moves", async () => {
  const { merchantId, rawKey } = await merchantWithKey();
  const txn = await captured(rawKey, 4_000);
  assert.equal((await refund(rawKey, merchantId, { transactionId: txn }, null)).statusCode, 400, "Idempotency-Key required");
  assert.equal((await refund(rawKey, merchantId, { transactionId: "nope" })).statusCode, 400);
  assert.equal((await refund(rawKey, merchantId, { transactionId: txn, amountFils: -5 })).statusCode, 400);
  assert.equal((await refund(rawKey, merchantId, { transactionId: txn, amountFils: 1.5 })).statusCode, 400);
  assert.deepEqual(await refundRows(txn), []);
});

test("an admin 'viewing as merchant' cannot issue a refund, even as super_admin (owner role)", async () => {
  const { merchantId, rawKey } = await merchantWithKey();
  const txn = await captured(rawKey, 4_000);
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'Impersonator', 'super_admin') RETURNING id`,
    [`impersonator-${randomUUID()}@admin.test`],
  );
  const grant = await startImpersonation(pool, { adminUserId: admin.rows[0]!.id, merchantId, ttlMinutes: 15 });
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/refunds`,
    headers: { cookie: `${config.impersonationCookieName}=${grant.rawToken}`, "idempotency-key": randomUUID() },
    payload: { transactionId: txn },
  });
  assert.equal(res.statusCode, 403, res.body);
  assert.deepEqual(await refundRows(txn), []);
});

test("the legacy unscoped POST /v1/refunds still answers 501", async () => {
  const { rawKey } = await merchantWithKey();
  const res = await app.inject({ method: "POST", url: "/v1/refunds", headers: { authorization: `Bearer ${rawKey}` }, payload: {} });
  assert.equal(res.statusCode, 501);
});

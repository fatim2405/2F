/**
 * The last three small fixes: the settlement summary counts a two-part
 * capture once, test-send refuses a disabled endpoint, and malformed ids or
 * values get a 400 instead of a 500. Requires DATABASE_URL (a migrated test DB).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { issueApiKey } from "./apiKeys/issue.js";
import { recordKycReview } from "./onboarding/review.js";
import { createWebhookEndpoint } from "./webhooks/create.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("auditFixes5.new.test.ts requires DATABASE_URL");
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

async function shop() {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Audit5 ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" });
  return { merchantId, auth: { authorization: `Bearer ${rawKey}` } };
}
const bahrainToday = () => new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
const bahrainTomorrow = () => new Date(Date.now() + 27 * 3_600_000).toISOString().slice(0, 10);

test("the settlement summary counts a payment captured in two parts once", async () => {
  const s = await shop();
  const a = await app.inject({ method: "POST", url: "/v1/transactions", headers: { ...s.auth, "idempotency-key": randomUUID() }, payload: { amountFils: 10_000, card: CARD } });
  const id = (a.json() as { id: string }).id;
  for (const amountFils of [4000, 6000]) {
    const c = await app.inject({ method: "POST", url: `/v1/transactions/${id}/capture`, headers: { ...s.auth, "idempotency-key": randomUUID() }, payload: { amountFils } });
    assert.equal(c.statusCode, 200, c.body);
  }
  const res = await app.inject({ method: "GET", url: `/v1/settlement/summary?from=${bahrainToday()}&to=${bahrainTomorrow()}`, headers: s.auth });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { transactionCount: number; totalCapturedFils: number };
  assert.equal(body.transactionCount, 1);
  assert.equal(body.totalCapturedFils, 10_000, "was 4,000 + 10,000 + ... (the running total once per capture)");
});

test("test-send refuses a disabled endpoint", async () => {
  const s = await shop();
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId: s.merchantId,
    url: "http://127.0.0.1:9/hook",
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  await pool.query(`UPDATE webhook_endpoints SET status = 'disabled' WHERE id = $1`, [endpoint.id]);
  const res = await app.inject({ method: "POST", url: `/v1/merchants/${s.merchantId}/webhook-endpoints/${endpoint.id}/test`, headers: s.auth });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal((res.json() as { error: string }).error, "endpoint_disabled");
});

test("malformed ids and values get a 400, not a 500", async () => {
  const s = await shop();
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId: s.merchantId,
    url: "http://127.0.0.1:9/hook",
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  const cases: Array<[string, string, unknown?]> = [
    ["DELETE", `/v1/merchants/${s.merchantId}/webhook-endpoints/not-a-uuid`],
    ["GET", `/v1/merchants/${s.merchantId}/webhook-endpoints/not-a-uuid/deliveries`],
    ["DELETE", `/v1/merchants/${s.merchantId}/api-keys/not-a-uuid`],
    ["PATCH", `/v1/merchants/${s.merchantId}/webhook-endpoints/${endpoint.id}`, { status: "sleeping" }],
  ];
  for (const [method, url, payload] of cases) {
    const res = await app.inject({ method: method as "GET", url, headers: s.auth, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${method} ${url} -> ${res.statusCode} ${res.body}`);
  }
});

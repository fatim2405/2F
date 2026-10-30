/**
 * Fourth audit round: credit permissions and two-person control, bulk KYC
 * status, capture permissions/idempotency/amount validation, OTP resend
 * guess budget, merchant session cookie lifetime, future-dated credits,
 * archive replay permissions, webhook endpoint delete with history, and
 * stale reserved payment links. Requires DATABASE_URL (a migrated test DB).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { hashPassword as hashAdminPassword } from "./adminAuth/passwords.js";
import { hashPassword } from "./auth/passwords.js";
import { issueApiKey } from "./apiKeys/issue.js";
import { recordKycReview } from "./onboarding/review.js";
import { assertDistinctApprover } from "./admin/creditApproval.js";
import { parseCreditRequestInput } from "./admin/creditRequestValidation.js";
import { createWebhookEndpoint } from "./webhooks/create.js";
import { merchantPaymentLinkStatus } from "./paymentLinks/serialize.js";
import { derivePublicStatus } from "./paymentLinks/status.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("auditFixes4.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
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
const PASSWORD = "audit4-password-9000!";
const cookieOf = (raw: string | string[] | undefined, name: string) =>
  (Array.isArray(raw) ? raw : [raw]).find((h) => h?.startsWith(`${name}=`))!;

async function merchant(status?: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Audit4 ${randomUUID()}`,
  ]);
  if (status) await pool.query(`UPDATE merchants SET onboarding_status = $2 WHERE id = $1`, [r.rows[0]!.id, status]);
  return r.rows[0]!.id;
}
async function adminCookie(role: "support" | "finance" | "super_admin"): Promise<string> {
  const email = `audit4-${randomUUID()}@admin.test`;
  await pool.query(`INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Audit4', $3)`, [
    email,
    await hashAdminPassword(PASSWORD, config),
    role,
  ]);
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: PASSWORD } });
  const cookie = cookieOf(login.headers["set-cookie"], config.adminCookieName).split(";")[0]!;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return cookie;
}
/** A KYC-approved merchant with an API key and a user of the given role. */
async function shop(role: "owner" | "support") {
  const merchantId = await merchant();
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const email = `${role}-${randomUUID()}@example.test`;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
    [merchantId, email, role, await hashPassword(PASSWORD, config)],
  );
  const { rawKey } = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" });
  return { merchantId, email, bearer: { authorization: `Bearer ${rawKey}` } };
}
async function authorize(bearer: Record<string, string>, amountFils = 5000): Promise<string> {
  const a = await app.inject({ method: "POST", url: "/v1/transactions", headers: { ...bearer, "idempotency-key": randomUUID() }, payload: { amountFils, card: CARD } });
  assert.equal(a.statusCode, 201, a.body);
  return (a.json() as { id: string }).id;
}

test("a support admin cannot create a credit", async () => {
  const merchantId = await merchant();
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/credits`,
    headers: { cookie: await adminCookie("support") },
    payload: { baseAmountFils: 50_000, reasonCode: "goodwill", effectiveDate: new Date().toISOString().slice(0, 10) },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test("two-person control compares user ids, not display names", () => {
  const id = randomUUID();
  assert.throws(() => assertDistinctApprover({ adminUserId: id, displayName: "Old Name" }, { adminUserId: id, displayName: "New Name" }));
  assert.doesNotThrow(() =>
    assertDistinctApprover({ adminUserId: randomUUID(), displayName: "Sara" }, { adminUserId: randomUUID(), displayName: "Sara" }),
  );
});

test("bulk KYC approval only approves merchants that are under review", async () => {
  const waiting = await merchant("under_review");
  const rejected = await merchant("rejected");
  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/merchants/bulk-approve",
    headers: { cookie: await adminCookie("finance") },
    payload: { merchantIds: [waiting, rejected], notes: "audit4" },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual((res.json() as { approvedMerchantIds: string[] }).approvedMerchantIds, [waiting]);
  const r = await pool.query<{ onboarding_status: string }>(`SELECT onboarding_status FROM merchants WHERE id = $1`, [rejected]);
  assert.equal(r.rows[0]!.onboarding_status, "rejected");
});

test("a capture key reused for a different transaction is refused, not replayed", async () => {
  const s = await shop("owner");
  const a = await authorize(s.bearer);
  const b = await authorize(s.bearer);
  const key = randomUUID();
  const first = await app.inject({ method: "POST", url: `/v1/transactions/${a}/capture`, headers: { ...s.bearer, "idempotency-key": key }, payload: {} });
  assert.equal(first.statusCode, 200, first.body);
  const second = await app.inject({ method: "POST", url: `/v1/transactions/${b}/capture`, headers: { ...s.bearer, "idempotency-key": key }, payload: {} });
  assert.equal(second.statusCode, 422, `was a 200 replay of A, leaving B uncaptured: ${second.body}`);
});

test("bad amounts get a 400 instead of a 500", async () => {
  const s = await shop("owner");
  for (const amountFils of [0, -5, 1.5, "100", 1e20]) {
    const res = await app.inject({ method: "POST", url: "/v1/transactions", headers: { ...s.bearer, "idempotency-key": randomUUID() }, payload: { amountFils, card: CARD } });
    assert.equal(res.statusCode, 400, `amountFils=${String(amountFils)}: ${res.body}`);
  }
  const t = await authorize(s.bearer);
  const cap = await app.inject({ method: "POST", url: `/v1/transactions/${t}/capture`, headers: { ...s.bearer, "idempotency-key": randomUUID() }, payload: { amountFils: 0 } });
  assert.equal(cap.statusCode, 400, cap.body);
});

test("a merchant support user can't capture; the session cookie lasts the full session; OTP resend keeps the guess count", async () => {
  const s = await shop("support");
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId: s.merchantId, email: s.email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = cookieOf(login.headers["set-cookie"], config.cookieName).split(";")[0]!;

  // Two wrong guesses, then a resend (allowed after 30 s; backdate the challenge).
  for (let i = 0; i < 2; i += 1) {
    await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: "000000" } });
  }
  await pool.query(
    `UPDATE otp_challenges SET created_at = now() - interval '1 minute'
      WHERE id = (SELECT otp_challenge_id FROM sessions WHERE merchant_user_id = (SELECT id FROM merchant_users WHERE email = $1))`,
    [s.email],
  );
  const resend = await app.inject({ method: "POST", url: "/v1/auth/otp/resend", headers: { cookie } });
  assert.equal(resend.statusCode, 200, resend.body);
  const attempts = await pool.query<{ attempt_count: number }>(
    `SELECT c.attempt_count FROM otp_challenges c JOIN sessions s ON s.otp_challenge_id = c.id
       JOIN merchant_users u ON u.id = s.merchant_user_id WHERE u.email = $1`,
    [s.email],
  );
  assert.equal(attempts.rows[0]!.attempt_count, 2, "resend used to reset the guess budget to 0");

  const code = (resend.json() as { devOtpCode: string }).devOtpCode;
  const verify = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code } });
  assert.equal(verify.statusCode, 200, verify.body);
  const set = cookieOf(verify.headers["set-cookie"], config.cookieName);
  assert.ok(set, "verify re-sets the session cookie");
  assert.match(set, new RegExp(`Max-Age=${config.sessionTtlHours * 3600}`), "not the 10-minute pending lifetime");

  const t = await authorize(s.bearer);
  const cap = await app.inject({ method: "POST", url: `/v1/transactions/${t}/capture`, headers: { cookie, "idempotency-key": randomUUID() }, payload: {} });
  assert.equal(cap.statusCode, 403, cap.body);
});

test("a credit can't be dated in the future", () => {
  const tomorrow = new Date(Date.now() + 3 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
  assert.throws(() => parseCreditRequestInput({ baseAmountFils: 1000, reasonCode: "goodwill", effectiveDate: tomorrow }), /future/);
});

test("a support admin cannot replay a whole webhook archive", async () => {
  const merchantId = await merchant();
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/webhook-endpoints/${randomUUID()}/archive/${randomUUID()}/replay`,
    headers: { cookie: await adminCookie("support") },
    payload: {},
  });
  assert.equal(res.statusCode, 403, res.body);
});

test("deleting a webhook endpoint with delivery history answers 409, not 500", async () => {
  const s = await shop("owner");
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId: s.merchantId,
    url: "http://127.0.0.1:9/hook",
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  const ev = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload) VALUES ('transaction.voided', 'transaction', $1, $2) RETURNING id`,
    [randomUUID(), JSON.stringify({ merchantId: s.merchantId })],
  );
  await pool.query(
    `INSERT INTO webhook_deliveries (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload) VALUES ($1, $2, 'transaction.voided', $3, '{}')`,
    [endpoint.id, ev.rows[0]!.id, randomUUID()],
  );
  const res = await app.inject({ method: "DELETE", url: `/v1/merchants/${s.merchantId}/webhook-endpoints/${endpoint.id}`, headers: s.bearer });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal((res.json() as { error: string }).error, "webhook_endpoint_has_deliveries");
});

test("a payment link stuck as reserved past its expiry shows as expired", () => {
  const past = new Date(Date.now() - 60_000);
  assert.equal(merchantPaymentLinkStatus({ status: "reserved", expires_at: past }), "expired");
  assert.equal(derivePublicStatus({ status: "reserved", expiresAt: past, reservedAt: new Date(Date.now() - 3_600_000) }, 60), "expired");
  assert.equal(derivePublicStatus({ status: "reserved", expiresAt: new Date(Date.now() + 60_000), reservedAt: new Date() }, 60), "processing");
});

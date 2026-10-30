/**
 * Second audit round, API side: fee display, report scope, refund webhook
 * envelope, the status-recompute tool leaving test_mode alone, and support's
 * webhook replay limit. Requires DATABASE_URL (a migrated test database).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { hashPassword } from "./adminAuth/passwords.js";
import { getCurrentFeeScheduleForDisplay } from "./fees/currentFeeScheduleDisplay.js";
import { getEffectiveMdrBps } from "./fees/feeSchedule.js";
import { resolveReportMerchantId } from "./reporting/scope.js";
import { buildEnvelope } from "./webhooks/envelope.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("auditFixes2.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

async function merchant(opts: { testMode?: boolean } = {}): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, test_mode) VALUES ($1, 225, $2) RETURNING id`,
    [`Audit2 ${randomUUID()}`, opts.testMode ?? false],
  );
  return r.rows[0]!.id;
}

const PASSWORD = "audit2-admin-password-9000!";
async function adminCookie(role: "support" | "finance" | "super_admin"): Promise<string> {
  const email = `audit2-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Audit2', $3)`,
    [email, await hashPassword(PASSWORD, config), role],
  );
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const raw = login.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw]).find((h) => h?.startsWith(`${config.adminCookieName}=`))!.split(";")[0]!;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return cookie;
}

test("fee display shows the rate capture charges, not the most recently entered backfill", async () => {
  const id = await merchant();
  await pool.query(
    `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from, created_at) VALUES
       ($1, 225, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
       ($1, 245, '2026-03-01T00:00:00Z', '2026-08-15T00:00:00Z'),
       ($1, 300, now() + interval '30 days', now())`,
    [id],
  );
  const shown = await getCurrentFeeScheduleForDisplay(pool, id);
  assert.equal(shown?.mdrBps, 225, "the alpha-retail case: 245 was shown while 225 was charged");
  assert.equal(shown?.mdrBps, await getEffectiveMdrBps(pool as never, id, new Date(), 225), "display == what capture charges");
});

test("a merchant can read its own split child's report, not someone else's", async () => {
  const parentA = await merchant();
  const parentB = await merchant();
  const childOfB = await merchant();
  await pool.query(
    `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps) VALUES ($1, $2, 10000)`,
    [parentB, childOfB],
  );
  assert.equal(await resolveReportMerchantId(pool, parentA, childOfB), parentA, "A is not B's child's parent");
  assert.equal(await resolveReportMerchantId(pool, parentB, childOfB), childOfB, "B still sees its own child");
});

test("refund.succeeded has a webhook envelope (it used to throw and never be delivered)", () => {
  const env = buildEnvelope("dlv_1", {
    eventType: "refund.succeeded",
    aggregateId: "txn_1",
    createdAt: new Date("2026-10-01T10:00:00Z"),
    payload: { merchantId: "m_1", refundId: "r_1", amountFils: 4000, feeReversedFils: 100, refundedTotalFils: 4000, newStatus: "partially_refunded" },
  });
  assert.equal(env.type, "refund.succeeded");
  assert.deepEqual(env.data, {
    transactionId: "txn_1", merchantId: "m_1", refundId: "r_1", amountFils: 4000,
    feeReversedFils: 100, refundedTotalFils: 4000, status: "partially_refunded",
  });
});

test("recomputing statuses leaves a test merchant in test mode", async () => {
  const id = await merchant({ testMode: true });
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 5000, 5000, $2)`,
    [id, `acq-${randomUUID()}`],
  );
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${id}/transactions/recompute-statuses`,
    headers: { cookie: await adminCookie("finance") },
  });
  assert.equal(res.statusCode, 200, res.body);
  const row = await pool.query<{ test_mode: boolean }>(`SELECT test_mode FROM merchants WHERE id = $1`, [id]);
  assert.equal(row.rows[0]!.test_mode, true, "test merchant must not be flipped live into real settlement");
});

test("support cannot batch-replay already-delivered webhooks", async () => {
  const id = await merchant();
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${id}/webhook-endpoints/${randomUUID()}/replay-batch`,
    headers: { cookie: await adminCookie("support") },
    payload: { from: "2026-05-01T00:00:00Z", to: "2026-05-05T00:00:00Z", statuses: ["succeeded"] },
  });
  assert.equal(res.statusCode, 403, res.body);
});

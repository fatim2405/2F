/**
 * Third audit round: read-only impersonation for every admin role, the
 * refund summary view, refunds surviving a reporting rebuild, reconciliation
 * using the effective fee schedule, refundedFils on the API, the streamed
 * CSV export (paging + bad dates), and acquirer callbacks verified over the
 * raw bytes. Requires DATABASE_URL (a migrated test database).
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { issueApiKey } from "./apiKeys/issue.js";
import { startImpersonation } from "./admin/impersonation.js";
import { refreshAnalyticsRollups } from "./admin/reportingRebuild.js";
import { getReconciliationReport } from "./settlement/query.js";
import { streamTransactionsExportCsv } from "./transactions/exportCsv.js";
import { verifyAcquirerCallbackSignature } from "./webhooks/inboundVerify.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("auditFixes3.new.test.ts requires DATABASE_URL");
const SECRET = "test-acquirer-callback-secret";
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  ACQUIRER_CALLBACK_SIGNING_SECRET: SECRET,
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

async function merchant(mdrBps = 250): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Audit3 ${randomUUID()}`, mdrBps],
  );
  return r.rows[0]!.id;
}
async function txn(merchantId: string, opts: { captured?: number; refunded?: number; at?: string } = {}): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference, occurred_at)
     VALUES ($1, 'captured', 10000, $2, $3, $4, COALESCE($5::timestamptz, now())) RETURNING id`,
    [merchantId, opts.captured ?? 10000, opts.refunded ?? 0, `acq-${randomUUID()}`, opts.at ?? null],
  );
  return r.rows[0]!.id;
}
async function bearer(merchantId: string): Promise<string> {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "t" });
  return `Bearer ${key.rawKey}`;
}

test("a super_admin impersonates as read-only support: reads work, writes are refused", async () => {
  const merchantId = await merchant();
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'Imp', 'super_admin') RETURNING id`,
    [`imp-${randomUUID()}@admin.test`],
  );
  const grant = await startImpersonation(pool, { adminUserId: admin.rows[0]!.id, merchantId, ttlMinutes: 15 });
  const cookie = `${config.impersonationCookieName}=${grant.rawToken}`;
  const read = await app.inject({ method: "GET", url: "/v1/transactions", headers: { cookie } });
  assert.equal(read.statusCode, 200, read.body);
  const write = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: { cookie, "idempotency-key": randomUUID() },
    payload: { amountFils: 1000, description: "x" },
  });
  assert.equal(write.statusCode, 403, write.body);
  assert.match(write.body, /impersonation is read-only/);
});

test("refund_merchant_summary has rows, and counts a twice-refunded payment's capture once", async () => {
  const merchantId = await merchant();
  const t = await txn(merchantId, { refunded: 3000 });
  for (const amount of [1000, 2000]) {
    await pool.query(
      `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference, created_by_type, created_by_id)
       VALUES ($1, $2, $3, 0, 'succeeded', $4, 'merchant_api_key', $5)`,
      [t, merchantId, amount, `rf-${randomUUID()}`, randomUUID()],
    );
  }
  const r = await pool.query<{ refund_count: string; total_refunded_fils: string; original_captured_fils: string }>(
    `SELECT refund_count, total_refunded_fils, original_captured_fils FROM refund_merchant_summary WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(r.rows.length, 1, "the old view (joined on r.id) was always empty");
  assert.equal(Number(r.rows[0]!.refund_count), 2);
  assert.equal(Number(r.rows[0]!.total_refunded_fils), 3000);
  assert.equal(Number(r.rows[0]!.original_captured_fils), 10000, "not 20000");
});

test("a reporting rebuild keeps refund totals", async () => {
  const merchantId = await merchant();
  const t = await txn(merchantId);
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at, metadata) VALUES
       ($1, 'captured', 10000, 'system', '2026-06-10T09:00:00Z', '{}'),
       ($1, 'refund_partial', -4000, 'system', '2026-06-10T10:00:00Z', '{}')`,
    [t],
  );
  const client = await pool.connect();
  try {
    await refreshAnalyticsRollups(client);
  } finally {
    client.release();
  }
  const r = await pool.query<{ refund_count: number; refund_gross_fils: string }>(
    `SELECT refund_count, refund_gross_fils FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(r.rows[0]?.refund_count, 1);
  assert.equal(Number(r.rows[0]?.refund_gross_fils), 4000);
});

test("reconciliation's pending figure uses the effective fee schedule, not merchants.mdr_bps", async () => {
  const merchantId = await merchant(250); // stale column value
  await pool.query(
    `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from) VALUES ($1, 100, '2026-01-01T00:00:00Z')`,
    [merchantId],
  );
  const t = await txn(merchantId);
  await pool.query(
    `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at, metadata)
     VALUES ($1, 'captured', 10000, 'system', '2026-06-10T09:00:00Z', '{}')`,
    [t],
  );
  const report = await getReconciliationReport(pool, { merchantId, from: "2026-06-10", to: "2026-06-11" });
  assert.equal(report.pendingUnbatchedFils, 9900, "1% of 10,000 (was 9,750 at the stale 2.5%)");
});

test("the transaction API returns refundedFils", async () => {
  const merchantId = await merchant();
  const t = await txn(merchantId, { refunded: 3000 });
  const res = await app.inject({ method: "GET", url: `/v1/transactions/${t}`, headers: { authorization: await bearer(merchantId) } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { refundedFils: number }).refundedFils, 3000);
});

test("the streamed export keeps rows that share a timestamp across a page boundary", async () => {
  const merchantId = await merchant();
  for (let i = 0; i < 5; i += 1) await txn(merchantId, { at: "2026-06-10T09:00:00Z" });
  let out = "";
  await streamTransactionsExportCsv(pool, { merchantId }, (c) => (out += c), 2);
  assert.equal(out.trim().split("\n").length, 6, "header + all 5 rows (paging on time alone returned 2)");
});

test("the export route streams the CSV and rejects bad dates with 400", async () => {
  const merchantId = await merchant();
  await txn(merchantId);
  const authorization = await bearer(merchantId);
  const ok = await app.inject({ method: "GET", url: "/v1/transactions/export", headers: { authorization } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.body.trim().split("\n").length, 2);
  const bad = await app.inject({ method: "GET", url: "/v1/transactions/export?from=garbage", headers: { authorization } });
  assert.equal(bad.statusCode, 400, bad.body);
});

test("acquirer callbacks are verified over the raw bytes the acquirer signed", async () => {
  const raw = '{ "callbackId": "cb-1", "type": "fraud_review.completed" }'; // not JSON.stringify spacing
  const ts = Math.floor(Date.now() / 1000);
  const header = `t=${ts},v1=${createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex")}`;
  assert.equal(verifyAcquirerCallbackSignature(raw, header, SECRET, true).valid, true);
  assert.equal(
    verifyAcquirerCallbackSignature(JSON.parse(raw), header, SECRET, true).valid,
    false,
    "re-serializing the parsed body (the old way) rejects a genuine callback",
  );

  const body = `{ "callbackId": "${randomUUID()}", "type": "fraud_review.completed", "transactionId": "${randomUUID()}", "occurredAt": "2026-06-10T09:00:00Z", "outcome": "cleared", "note": "ok" }`;
  const sig = `t=${ts},v1=${createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex")}`;
  const res = await app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: { "content-type": "application/json", "acquirer-callback-signature": sig },
    payload: body,
  });
  assert.notEqual(res.statusCode, 401, `a genuinely signed callback must pass verification: ${res.body}`);
});

/**
 * The admin "Adjust balance" button must record the correction in the
 * ledger (ledger_entries), not just the on-screen cache — otherwise the next
 * rebuild from the ledger silently undoes it. Requires DATABASE_URL to point
 * at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("adminBalanceAdjustmentsLedger.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
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

async function financeAdminCookie(): Promise<string> {
  const email = `bal-adj-ledger-${randomUUID()}@admin.test`;
  const password = "admin-test-password-9000!";
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Ledger Test', 'finance')`,
    [email, await hashPassword(password, config)],
  );
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password } });
  const cookie = ([] as string[]).concat(login.headers["set-cookie"] as string | string[])
    .find((c) => c.startsWith(`${config.adminCookieName}=`))!.split(";")[0]!;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return cookie;
}

async function merchantWithBalance(fils: number): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Bal Adj Ledger ${randomUUID()}`],
  );
  await pool.query(`INSERT INTO merchant_balances (merchant_id, cached_payable_fils) VALUES ($1, $2)`, [m.rows[0]!.id, fils]);
  return m.rows[0]!.id;
}

async function ledgerFor(merchantId: string) {
  const r = await pool.query<{ account_id: string; direction: string; amount_fils: string }>(
    `SELECT account_id, direction, amount_fils FROM ledger_entries WHERE merchant_id = $1 ORDER BY account_id`,
    [merchantId],
  );
  return r.rows.map((x) => [x.account_id, x.direction, Number(x.amount_fils)]);
}

test("a positive adjustment is posted to the ledger as a balanced pair", async () => {
  const cookie = await financeAdminCookie();
  const merchantId = await merchantWithBalance(100_000);
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/balance-adjustments`,
    headers: { cookie },
    payload: { deltaFils: 4_750, reason: "statement correction" },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { cachedPayableFilsAfter: number }).cachedPayableFilsAfter, 104_750);
  assert.deepEqual(await ledgerFor(merchantId), [
    ["manual_balance_adjustment_contra", "debit", 4_750],
    ["merchant_payable", "credit", 4_750],
  ]);
});

test("a negative adjustment debits merchant_payable", async () => {
  const cookie = await financeAdminCookie();
  const merchantId = await merchantWithBalance(100_000);
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/balance-adjustments`,
    headers: { cookie },
    payload: { deltaFils: -1_250, reason: "duplicate refund" },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(await ledgerFor(merchantId), [
    ["manual_balance_adjustment_contra", "credit", 1_250],
    ["merchant_payable", "debit", 1_250],
  ]);
});

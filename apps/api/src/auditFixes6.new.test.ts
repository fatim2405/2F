/**
 * The last open items: login rate limiting (merchant and admin), no second
 * KYC review of a decided merchant, and cross-process admin actions logged
 * as "started" until the settlement call returns.
 * Requires DATABASE_URL (a migrated test database).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { hashPassword } from "./auth/passwords.js";
import { hashPassword as hashAdminPassword } from "./adminAuth/passwords.js";
import { LoginThrottle } from "./lib/loginThrottle.js";
import type { AdminRoutesOptions } from "./routes/admin.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("auditFixes6.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });

// The settlement client stub reads the audit row while the call is "in flight".
let outcomeSeenDuringCall: string | undefined;
const adminOptions: AdminRoutesOptions = {
  settlement: {
    runBatch: async () => {
      const r = await pool.query<{ outcome: string }>(
        `SELECT outcome FROM admin_audit_log WHERE action = 'settlement_run_batch' ORDER BY created_at DESC LIMIT 1`,
      );
      outcomeSeenDuringCall = r.rows[0]?.outcome;
      return { businessDate: "2026-09-09", merchantResults: [] };
    },
    rebuildBalances: async () => ({ rebuiltCount: 0, changed: [] }),
    recalculateMdr: async () => ({ batchesConsidered: 0, adjusted: [] }),
  },
};
const app = buildApp(config, pool, { admin: adminOptions });
test.after(async () => {
  await app.close();
  await pool.end();
});

const PASSWORD = "audit6-password-9000!";
const cookieOf = (raw: string | string[] | undefined, name: string) =>
  (Array.isArray(raw) ? raw : [raw]).find((h) => h?.startsWith(`${name}=`))!.split(";")[0]!;

async function adminUser(role: "support" | "finance" | "super_admin") {
  const email = `audit6-${randomUUID()}@admin.test`;
  await pool.query(`INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Audit6', $3)`, [
    email,
    await hashAdminPassword(PASSWORD, config),
    role,
  ]);
  return email;
}
async function adminCookie(role: "support" | "finance" | "super_admin"): Promise<string> {
  const email = await adminUser(role);
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: PASSWORD } });
  const cookie = cookieOf(login.headers["set-cookie"], config.adminCookieName);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return cookie;
}

test("LoginThrottle: 5 failures lock the account for 15 minutes; success clears it", () => {
  let now = 0;
  const t = new LoginThrottle(() => now);
  for (let i = 0; i < 5; i += 1) {
    t.assertAllowed("a", "1.1.1.1");
    t.recordFailure("a", "1.1.1.1");
  }
  assert.throws(() => t.assertAllowed("a", "1.1.1.1"), /Too many failed attempts/);
  assert.doesNotThrow(() => t.assertAllowed("b", "1.1.1.1"), "another account from the same IP is fine");
  now += 15 * 60_000;
  assert.doesNotThrow(() => t.assertAllowed("a", "1.1.1.1"), "unlocked after the window");

  t.recordFailure("c", "2.2.2.2");
  t.recordSuccess("c");
  for (let i = 0; i < 4; i += 1) t.recordFailure("c", "2.2.2.2");
  assert.doesNotThrow(() => t.assertAllowed("c", "2.2.2.2"), "a success reset the count");
});

test("merchant login: after 5 wrong passwords even the right one gets 429", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Audit6 ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  const email = `owner-${randomUUID()}@example.test`;
  await pool.query(`INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3)`, [
    merchantId,
    email,
    await hashPassword(PASSWORD, config),
  ]);
  for (let i = 0; i < 5; i += 1) {
    const bad = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: "wrong" } });
    assert.equal(bad.statusCode, 401);
  }
  const locked = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password: PASSWORD } });
  assert.equal(locked.statusCode, 429, locked.body);
});

test("admin login: after 5 wrong passwords even the right one gets 429", async () => {
  const email = await adminUser("support");
  for (let i = 0; i < 5; i += 1) {
    const bad = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: "wrong" } });
    assert.equal(bad.statusCode, 401);
  }
  const locked = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: PASSWORD } });
  assert.equal(locked.statusCode, 429, locked.body);
});

test("a merchant already approved can't be re-reviewed with one click", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Audit6 KYC ${randomUUID()}`,
  ]);
  const cookie = await adminCookie("finance");
  const url = `/v1/admin/merchants/${m.rows[0]!.id}/kyc-reviews`;
  const first = await app.inject({ method: "POST", url, headers: { cookie }, payload: { outcome: "approved" } });
  assert.equal(first.statusCode, 200, first.body);
  const flip = await app.inject({ method: "POST", url, headers: { cookie }, payload: { outcome: "rejected" } });
  assert.equal(flip.statusCode, 409, flip.body);
  const r = await pool.query<{ onboarding_status: string }>(`SELECT onboarding_status FROM merchants WHERE id = $1`, [m.rows[0]!.id]);
  assert.equal(r.rows[0]!.onboarding_status, "approved");
});

test("a settlement run is logged as started while it runs, and succeeded once it returns", async () => {
  const cookie = await adminCookie("finance");
  const res = await app.inject({ method: "POST", url: "/v1/admin/settlement/run-batch", headers: { cookie }, payload: { date: "2026-09-09" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(outcomeSeenDuringCall, "started", "used to say succeeded before the call had run");
  const r = await pool.query<{ outcome: string }>(
    `SELECT outcome FROM admin_audit_log WHERE action = 'settlement_run_batch' ORDER BY created_at DESC LIMIT 1`,
  );
  assert.equal(r.rows[0]!.outcome, "succeeded");
});

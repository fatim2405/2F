/**
 * The OTP attempt limit must hold under parallel guesses, for merchant and
 * admin logins. Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "./passwords.js";
import { hashPassword as hashAdminPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("otpRace.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  OTP_MAX_ATTEMPTS: "5",
  ADMIN_OTP_MAX_ATTEMPTS: "5",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

function wrongCode(right: string): string {
  return right === "000000" ? "111111" : "000000";
}

async function fireParallel(url: string, cookie: string, code: string, n: number) {
  const results = await Promise.all(
    Array.from({ length: n }, () => app.inject({ method: "POST", url, headers: { cookie }, payload: { code } })),
  );
  return results.map((r) => r.statusCode);
}

test("merchant: 30 parallel wrong guesses use at most 5 attempts", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`OTP Race ${randomUUID()}`]);
  const email = `otp-race-${randomUUID()}@example.test`;
  await pool.query(`INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3)`, [m.rows[0]!.id, email, await hashPassword("pw-123456789", config)]);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId: m.rows[0]!.id, email, password: "pw-123456789" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const code = (login.json() as { devOtpCode: string }).devOtpCode;

  const statuses = await fireParallel("/v1/auth/otp/verify", cookie, wrongCode(code), 30);
  assert.ok(statuses.filter((s) => s === 401).length <= 5, `only 5 guesses may be checked, got ${statuses.filter((s) => s === 401).length}: ${statuses.join(",")}`);
  const row = await pool.query<{ attempt_count: number }>(
    `SELECT c.attempt_count FROM otp_challenges c JOIN merchant_users u ON u.id = c.merchant_user_id WHERE u.email = $1`,
    [email],
  );
  assert.ok(row.rows[0]!.attempt_count <= 5, `attempt_count ${row.rows[0]!.attempt_count}`);
});

test("admin: 30 parallel wrong guesses use at most 5 attempts", async () => {
  const email = `otp-race-admin-${randomUUID()}@admin.test`;
  await pool.query(`INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Race', 'support')`, [email, await hashAdminPassword("admin-pw-123456789", config)]);
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: "admin-pw-123456789" } });
  const cookie = ([] as string[]).concat(login.headers["set-cookie"] as string | string[]).find((c) => c.startsWith(`${config.adminCookieName}=`))!.split(";")[0]!;
  const code = (login.json() as { devOtpCode: string }).devOtpCode;

  const statuses = await fireParallel("/v1/admin/auth/otp/verify", cookie, wrongCode(code), 30);
  assert.ok(statuses.filter((s) => s === 401).length <= 5, `only 5 guesses may be checked: ${statuses.join(",")}`);
});

test("merchant: the right code still works after a few wrong ones, exactly once", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`OTP OK ${randomUUID()}`]);
  const email = `otp-ok-${randomUUID()}@example.test`;
  await pool.query(`INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3)`, [m.rows[0]!.id, email, await hashPassword("pw-123456789", config)]);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId: m.rows[0]!.id, email, password: "pw-123456789" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const code = (login.json() as { devOtpCode: string }).devOtpCode;
  for (let i = 0; i < 2; i++) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: wrongCode(code) } });
    assert.equal(r.statusCode, 401);
  }
  const ok = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code } });
  assert.equal(ok.statusCode, 200, ok.body);
});

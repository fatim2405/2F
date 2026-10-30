/**
 * One email can hold accounts at several merchants. Logging in with
 * merchant A's id and password must yield a session for merchant A — never
 * another merchant that shares the email. Requires DATABASE_URL to point at
 * a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "./passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("loginMerchantScope.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function merchantWithUser(email: string, password: string): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Login Scope ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  await pool.query(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3)`,
    [merchantId, email, await hashPassword(password, config)],
  );
  return merchantId;
}

async function loginAndVerify(merchantId: string, email: string, password: string) {
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password } });
  if (login.statusCode !== 200) return { loginStatus: login.statusCode };
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie },
    payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
  });
  return { loginStatus: 200, verifyStatus: verify.statusCode, body: verify.json() as { merchantId: string } };
}

// The first-inserted account is the one an email-only `LIMIT 1` lookup tends
// to return, so test both directions.
const email = `shared-${randomUUID()}@example.test`;
const firstMerchant = await merchantWithUser(email, "first-merchant-password-1");
const secondMerchant = await merchantWithUser(email, "second-merchant-password-2");

test("logging into the second merchant gives a session for the second merchant", async () => {
  const r = await loginAndVerify(secondMerchant, email, "second-merchant-password-2");
  assert.equal(r.verifyStatus, 200);
  assert.equal(r.body!.merchantId, secondMerchant);
});

test("logging into the first merchant gives a session for the first merchant", async () => {
  const r = await loginAndVerify(firstMerchant, email, "first-merchant-password-1");
  assert.equal(r.verifyStatus, 200);
  assert.equal(r.body!.merchantId, firstMerchant);
});

test("the other merchant's password does not open this merchant", async () => {
  const r = await loginAndVerify(firstMerchant, email, "second-merchant-password-2");
  assert.equal(r.loginStatus, 401);
});

/**
 * After the password step the browser holds a *pending* session cookie. It
 * must not work as a login until the OTP is verified. Requires DATABASE_URL
 * to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "./passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("otpBypass.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "t",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

test("a password-only (pending) session can't reach anything; after the OTP it can", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`OTP Bypass ${randomUUID()}`]);
  const email = `bypass-${randomUUID()}@example.test`;
  await pool.query(`INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3)`, [m.rows[0]!.id, email, await hashPassword("pw-123456789", config)]);

  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId: m.rows[0]!.id, email, password: "pw-123456789" } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;

  for (const url of ["/v1/auth/me", "/v1/transactions", "/v1/settlement/batches"]) {
    const r = await app.inject({ method: "GET", url, headers: { cookie } });
    assert.equal(r.statusCode, 401, `${url} must refuse a pending session, got ${r.statusCode}`);
  }

  const verify = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: (login.json() as { devOtpCode: string }).devOtpCode } });
  assert.equal(verify.statusCode, 200);
  const after = await app.inject({ method: "GET", url: "/v1/transactions", headers: { cookie } });
  assert.equal(after.statusCode, 200);
});

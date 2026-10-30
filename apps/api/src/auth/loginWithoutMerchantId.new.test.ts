/**
 * Merchants sign in with email + password; the merchant id is no longer
 * typed. One account -> straight to OTP. Several accounts the password opens
 * -> a list of businesses, then sign in with the chosen merchantId. Nothing
 * about which businesses an email has is revealed without the password.
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "./passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("loginWithoutMerchantId.new.test.ts requires DATABASE_URL");
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

async function account(name: string, email: string, password: string): Promise<string> {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [name]);
  await pool.query(`INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3)`, [
    m.rows[0]!.id,
    email,
    await hashPassword(password, config),
  ]);
  return m.rows[0]!.id;
}
const login = (payload: Record<string, string>) => app.inject({ method: "POST", url: "/v1/auth/login", payload });

test("one account: email + password goes straight to the OTP step and the session is for that merchant", async () => {
  const email = `solo-${randomUUID()}@example.test`;
  const merchantId = await account(`Solo ${randomUUID()}`, email, "solo-password-123");
  const res = await login({ email, password: "solo-password-123" });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { otpRequired: boolean; devOtpCode: string };
  assert.equal(body.otpRequired, true);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const verify = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code: body.devOtpCode } });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal((verify.json() as { merchantId: string }).merchantId, merchantId);
});

test("several accounts with the same password: choose a business, then sign in to exactly that one", async () => {
  const email = `multi-${randomUUID()}@example.test`;
  const a = await account(`Aaa Shop ${randomUUID()}`, email, "shared-password-123");
  const b = await account(`Bbb Shop ${randomUUID()}`, email, "shared-password-123");
  const first = await login({ email, password: "shared-password-123" });
  assert.equal(first.statusCode, 200, first.body);
  const choice = first.json() as { merchantChoiceRequired: boolean; merchants: Array<{ merchantId: string }> };
  assert.equal(choice.merchantChoiceRequired, true);
  assert.deepEqual(new Set(choice.merchants.map((m) => m.merchantId)), new Set([a, b]));
  assert.equal(first.headers["set-cookie"], undefined, "no session until a business is chosen");

  const chosen = await login({ email, password: "shared-password-123", merchantId: b });
  const cookie = String(chosen.headers["set-cookie"]).split(";")[0]!;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie },
    payload: { code: (chosen.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal((verify.json() as { merchantId: string }).merchantId, b);
});

test("the password decides: only accounts it opens are offered, and a wrong one reveals nothing", async () => {
  const email = `split-${randomUUID()}@example.test`;
  const mine = await account(`Mine ${randomUUID()}`, email, "my-password-123");
  await account(`Other ${randomUUID()}`, email, "different-password-456");
  const res = await login({ email, password: "my-password-123" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { otpRequired?: boolean }).otpRequired, true, "only one account matched, so no list");
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie },
    payload: { code: (res.json() as { devOtpCode: string }).devOtpCode },
  });
  assert.equal((verify.json() as { merchantId: string }).merchantId, mine);

  const wrong = await login({ email, password: "not-either-password" });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.body.includes("merchants"), false);
});

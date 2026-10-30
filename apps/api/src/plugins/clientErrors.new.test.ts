/**
 * Bad requests must get a 4xx, not a 500 "internal_error". Requires
 * DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("clientErrors.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

test("malformed JSON on login is a 400, not a 500", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: { "content-type": "application/json" },
    payload: '{"merchantId":"9972daab-2c86-459f-9d78-3fe1be4e3280\n3a1a204a", ',
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal((res.json() as { error: string }).error, "invalid_request");
});

test("a malformed transaction id is a 404, not a 500", async () => {
  for (const url of ["/v1/transactions/undefined", "/v1/transactions/not-a-uuid/events"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 404, `${url}: ${res.body}`);
    assert.equal((res.json() as { error: string }).error, "transaction_not_found");
  }
});

/**
 * A rotated-out API key keeps working for the grace period, then stops.
 * Before, nothing ever set or enforced revoke_after, so it worked forever.
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { verifyApiKey } from "../apiKeys/verify.js";
import { rotateApiKeyAsAdmin } from "./apiKeys.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("keyRotation.new.test.ts requires DATABASE_URL");
const config = loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "test", INTERNAL_API_TOKEN: "t", WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=" });
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => {
  await pool.end();
});

test("after rotation the old key works during the grace period and stops once it ends", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`Rotate ${randomUUID()}`]);
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(`INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`, [merchantId, `o-${randomUUID()}@example.test`]);
  const admin = await pool.query<{ id: string }>(`INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'Rot', 'support') RETURNING id`, [`rot-${randomUUID()}@admin.test`]);
  const old = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label: "checkout" });
  const oldId = (await verifyApiKey(pool, old.rawKey))!.apiKeyId;

  const rotated = await rotateApiKeyAsAdmin(pool, config, { merchantId, apiKeyId: oldId, adminUserId: admin.rows[0]!.id });
  assert.ok(await verifyApiKey(pool, old.rawKey), "old key still works during the grace period");
  assert.ok(await verifyApiKey(pool, rotated.rawKey), "new key works");

  const deadline = await pool.query<{ hours: number }>(`SELECT EXTRACT(EPOCH FROM revoke_after - now()) / 3600 AS hours FROM api_keys WHERE id = $1`, [oldId]);
  assert.ok(Number(deadline.rows[0]!.hours) > 23 && Number(deadline.rows[0]!.hours) <= 24, "about 24 h of grace");

  await pool.query(`UPDATE api_keys SET revoke_after = now() - interval '1 second' WHERE id = $1`, [oldId]);
  assert.equal(await verifyApiKey(pool, old.rawKey), null, "old key stops working after the deadline");
  assert.ok(await verifyApiKey(pool, rotated.rawKey), "new key unaffected");
});

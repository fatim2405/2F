/**
 * An expired payment link must not show as "active" on the merchant
 * dashboard, and the Active filter must not include it. ("expired" is never
 * stored; the merchant list showed the raw stored 'active' forever.)
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { listPaymentLinks } from "./query.js";
import { merchantPaymentLinkStatus } from "./serialize.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("expiredStatus.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => {
  await pool.end();
});

async function insertLink(merchantId: string, expiresAt: string, status = "active"): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, status, created_by_type, created_by_id, canceled_at)
     VALUES ($1, $2, 5000, $3, $4, 'merchant_session', $5, CASE WHEN $4 = 'canceled' THEN now() END) RETURNING id`,
    [merchantId, `tok_${randomUUID()}`, expiresAt, status, randomUUID()],
  );
  return r.rows[0]!.id;
}

test("merchantPaymentLinkStatus: active or reserved past expiry is expired; other statuses unchanged", () => {
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);
  assert.equal(merchantPaymentLinkStatus({ status: "active", expires_at: past }), "expired");
  assert.equal(merchantPaymentLinkStatus({ status: "active", expires_at: future }), "active");
  assert.equal(merchantPaymentLinkStatus({ status: "canceled", expires_at: past }), "canceled");
  assert.equal(merchantPaymentLinkStatus({ status: "reserved", expires_at: past }), "expired");
  assert.equal(merchantPaymentLinkStatus({ status: "reserved", expires_at: future }), "reserved");
});

test("the merchant list shows an expired link as expired and filters on it", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Expiry ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  const live = await insertLink(merchantId, new Date(Date.now() + 3_600_000).toISOString());
  const expired = await insertLink(merchantId, new Date(Date.now() - 3_600_000).toISOString());
  const cfg = { checkoutBaseUrl: "http://localhost:5173" };

  const all = await listPaymentLinks(pool, cfg, { merchantId });
  const byId = new Map(all.paymentLinks.map((l) => [l.id, l.status]));
  assert.equal(byId.get(live), "active");
  assert.equal(byId.get(expired), "expired", "was shown as 'active'");

  const activeOnly = await listPaymentLinks(pool, cfg, { merchantId, status: ["active"] });
  assert.deepEqual(activeOnly.paymentLinks.map((l) => l.id), [live], "Active filter must exclude expired links");

  const expiredOnly = await listPaymentLinks(pool, cfg, { merchantId, status: ["expired"] });
  assert.deepEqual(expiredOnly.paymentLinks.map((l) => l.id), [expired]);
});

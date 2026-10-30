/**
 * Prepares the checkout load test: one KYC-approved "Load Test Merchant"
 * and N single-use payment links. Writes their tokens to tokens.json for
 * checkout.k6.js. Run against a TEST database, never production:
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/loadtest/prepare-checkout.ts 3000
 */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const count = Number(process.argv[2] ?? 2000);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const m = await client.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, onboarding_status, kyc_passed)
     VALUES ($1, 250, 'approved', true) RETURNING id`,
    [`Load Test Merchant ${new Date().toISOString()}`],
  );
  const merchantId = m.rows[0]!.id;
  const tokens: string[] = [];
  for (let i = 0; i < count; i += 500) {
    const batch = Array.from({ length: Math.min(500, count - i) }, () => `plink_${randomBytes(16).toString("base64url")}`);
    await client.query(
      `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
       SELECT $1, t, 4750, now() + interval '1 day', 'merchant_session', $2 FROM unnest($3::text[]) AS t`,
      [merchantId, randomUUID(), batch],
    );
    tokens.push(...batch);
  }
  const out = join(dirname(fileURLToPath(import.meta.url)), "tokens.json");
  writeFileSync(out, JSON.stringify(tokens));
  console.log(`merchant ${merchantId}: ${tokens.length} payment links -> ${out}`);
} finally {
  await client.end();
}

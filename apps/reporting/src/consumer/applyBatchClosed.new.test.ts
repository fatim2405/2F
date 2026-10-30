/**
 * settlement.batch_closed runs a parity check (rollup vs real captures) that
 * is only meant to warn. When the day had captures but no rollup row yet, it
 * used to throw — stalling the whole consumer. Runs inside a transaction that
 * is rolled back, so it leaves nothing in the shared database. Requires
 * DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { applyEvent } from "./applyEvent.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("applyBatchClosed.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
test.after(async () => {
  await pool.end();
});

test("batch_closed for a day with captures but no rollup row warns instead of throwing, and still records the payout trend", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const m = await client.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`Parity ${randomUUID()}`]);
    const merchantId = m.rows[0]!.id;
    const t = await client.query<{ id: string }>(
      `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
       VALUES ($1, 'captured', 10000, 10000, $2) RETURNING id`,
      [merchantId, `acq_${randomUUID()}`],
    );
    // A real capture on 10 Apr (midday Bahrain) that never went through the
    // outbox, so reporting has no merchant_daily_volume row for that day.
    await client.query(
      `INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at)
       VALUES ($1, 'captured', 10000, 'system', '2026-04-10T09:00:00Z')`,
      [t.rows[0]!.id],
    );
    const b = await client.query<{ id: string }>(
      `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
       VALUES ($1, '2026-04-10', 'closed', 10000, 250, 9750, now()) RETURNING id`,
      [merchantId],
    );

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      await applyEvent(client, {
        id: 1,
        event_type: "settlement.batch_closed",
        aggregate_id: b.rows[0]!.id,
        payload: { merchantId, batchId: b.rows[0]!.id, batchDate: "2026-04-10", grossFils: 10000, feeFils: 250, netPayoutFils: 9750 },
        created_at: new Date(),
      });
    } finally {
      console.warn = originalWarn;
    }

    assert.match(warnings.join("\n"), /rollup=0 ground_truth=1/);
    const trend = await client.query<{ net_payout_fils: string }>(
      `SELECT net_payout_fils FROM merchant_payout_trends WHERE merchant_id = $1`,
      [merchantId],
    );
    assert.equal(Number(trend.rows[0]!.net_payout_fils), 9750);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

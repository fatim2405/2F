/**
 * FP-201: the same acquirer callback delivered twice must be saved once.
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { applyAcquirerCallback } from "./callbacks.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("callbackDedupe.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
test.after(async () => {
  await pool.end();
});

test("a callback delivered twice (and in parallel) is recorded once", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`Cb ${randomUUID()}`]);
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference) VALUES ($1, 'captured', 1000, 1000, $2) RETURNING id`,
    [m.rows[0]!.id, `acq_${randomUUID()}`],
  );
  const callback = {
    callbackId: `cb_${randomUUID()}`,
    type: "fraud_review.completed" as const,
    transactionId: t.rows[0]!.id,
    occurredAt: new Date().toISOString(),
    outcome: "cleared" as const,
    note: "cleared",
  };
  await applyAcquirerCallback(pool, callback);
  await Promise.all([applyAcquirerCallback(pool, callback), applyAcquirerCallback(pool, callback)]);
  const rows = await pool.query(`SELECT 1 FROM acquirer_callback_notes WHERE callback_id = $1`, [callback.callbackId]);
  assert.equal(rows.rowCount, 1);
});

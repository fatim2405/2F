/**
 * FP-209 (two refunds at once both paid out) and "can you refund more than
 * was actually charged?". Requires DATABASE_URL to point at a real, migrated
 * Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { processRefund } from "./processRefund.js";
import type { AcquirerSimulator } from "../acquirer/types.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("refundConcurrency.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
test.after(async () => {
  await pool.end();
});

let bankRefunds = 0;
const slowBank: AcquirerSimulator = {
  authorize: async () => { throw new Error("unused"); },
  capture: async () => { throw new Error("unused"); },
  async refund(r) {
    bankRefunds += 1;
    await new Promise((res) => setTimeout(res, 300)); // keep both requests in flight together
    return { outcome: "approved", acquirerReference: r.acquirerReference, latencyMs: 300 };
  },
};

async function txn(status: string, amount: number, captured: number) {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`Refund Race ${randomUUID()}`]);
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [m.rows[0]!.id, status, amount, captured, `acq_${randomUUID()}`],
  );
  return { merchantId: m.rows[0]!.id, transactionId: t.rows[0]!.id };
}
const refund = (t: { merchantId: string; transactionId: string }, amountFils?: number) =>
  processRefund(pool, slowBank, {
    transactionId: t.transactionId,
    merchantId: t.merchantId,
    amountFils: amountFils === undefined ? undefined : toFils(amountFils),
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_api_key", id: randomUUID() },
  });

test("two full refunds at the same moment: only one goes through (FP-209)", async () => {
  const t = await txn("captured", 10_000, 10_000);
  const before = bankRefunds;
  const results = await Promise.all([refund(t), refund(t)]);
  const ok = results.filter((r) => r.statusCode === 200 || r.statusCode === 201);
  assert.equal(ok.length, 1, `exactly one refund succeeds: ${results.map((r) => r.statusCode).join(",")}`);
  assert.equal(bankRefunds - before, 1, "the bank was asked to send money back once");
  const row = await pool.query<{ refunded_fils: string; status: string }>(`SELECT refunded_fils, status FROM transactions WHERE id = $1`, [t.transactionId]);
  assert.equal(Number(row.rows[0]!.refunded_fils), 10_000);
  assert.equal(row.rows[0]!.status, "refunded");
  const refunds = await pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [t.transactionId]);
  assert.equal(refunds.rowCount, 1);
});

test("a partially captured payment can't be refunded beyond what was captured", async () => {
  const t = await txn("partially_captured", 10_000, 4_000);
  const tooMuch = await refund(t, 10_000);
  assert.equal(tooMuch.statusCode, 422, JSON.stringify(tooMuch.body));
  const ok = await refund(t, 4_000);
  assert.ok(ok.statusCode === 200 || ok.statusCode === 201, JSON.stringify(ok.body));
  const again = await refund(t, 1);
  assert.notEqual(again.statusCode, 200, "nothing left to refund");
});

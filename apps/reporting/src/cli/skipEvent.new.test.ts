/**
 * A malformed event blocks the reporting consumer forever (each pass rolls
 * back its whole batch and retries it). The failing pass must name the
 * event, and `skip-event` must clear exactly that event — applying the good
 * events before it, never skipping one. Requires DATABASE_URL to point at a
 * real, migrated Postgres.
 *
 * This file moves the shared consumer watermark, so it puts it back and
 * deletes the events it created afterwards: leaving a malformed event behind
 * would block the real worker (and every later reporting test).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { CONSUMER_NAME, runConsumerPass } from "../consumer/runConsumerPass.js";
import { runSkipEvent } from "./skipEvent.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("skipEvent.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const pool = new Pool({ connectionString: databaseUrl, max: 5 });

async function setCursor(id: bigint): Promise<void> {
  await pool.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id) VALUES ($1, $2)
     ON CONFLICT (consumer_name) DO UPDATE SET last_processed_id = $2`,
    [CONSUMER_NAME, id.toString()],
  );
}
async function getCursor(): Promise<bigint> {
  const r = await pool.query<{ last_processed_id: string }>(
    `SELECT last_processed_id FROM reporting_outbox_cursor WHERE consumer_name = $1`,
    [CONSUMER_NAME],
  );
  return r.rows[0] ? BigInt(r.rows[0].last_processed_id) : 0n;
}

const originalCursor = await getCursor();
const createdEventIds: string[] = [];
test.after(async () => {
  // Leave the shared database as we found it.
  await pool.query(`DELETE FROM merchant_daily_volume WHERE merchant_id IN (SELECT id FROM merchants WHERE display_name LIKE 'skipEvent Test %')`);
  if (createdEventIds.length > 0) await pool.query(`DELETE FROM outbox_events WHERE id = ANY($1::bigint[])`, [createdEventIds]);
  await setCursor(originalCursor);
  await pool.end();
});

async function merchant(): Promise<string> {
  const r = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`skipEvent Test ${randomUUID()}`]);
  return r.rows[0]!.id;
}
async function goodEvent(merchantId: string) {
  const e = await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: 1_000, feeFils: 25, newStatus: "captured", capturedTotalFils: 1_000 },
  });
  createdEventIds.push(String(e.id));
  return BigInt(e.id);
}
async function badEvent() {
  const e = await enqueueEvent(pool, { eventType: "transaction.voided", aggregateType: "transaction", aggregateId: randomUUID(), payload: {} });
  createdEventIds.push(String(e.id));
  return BigInt(e.id);
}

test("a stuck pass names the blocking event even when good events come before it in the batch", async () => {
  const m = await merchant();
  const good = await goodEvent(m);
  const bad = await badEvent();
  await setCursor(good - 1n); // queue: good, bad

  await assert.rejects(runConsumerPass(pool, { consumerBatchLimit: 500 }), new RegExp(`outbox event ${bad} .*skip-event ${bad}`));
  assert.equal(await getCursor(), good - 1n, "the whole batch rolled back, so even the good event wasn't applied");

  const { skippedId, appliedBefore } = await runSkipEvent(pool, String(bad));
  assert.equal(skippedId, bad);
  assert.equal(appliedBefore, 1, "the good event before it was applied, not skipped");
  assert.equal(await getCursor(), bad);
  const vol = await pool.query<{ captured_count: number }>(`SELECT captured_count FROM merchant_daily_volume WHERE merchant_id = $1`, [m]);
  assert.equal(Number(vol.rows[0]?.captured_count), 1, "the good event really reached the rollup");
});

test("skip-event refuses when an earlier event also fails, and changes nothing", async () => {
  const firstBad = await badEvent();
  const secondBad = await badEvent();
  await setCursor(firstBad - 1n);
  await assert.rejects(runSkipEvent(pool, String(secondBad)), new RegExp(`earlier event ${firstBad} .*also fails`));
  assert.equal(await getCursor(), firstBad - 1n);
  await runSkipEvent(pool, String(firstBad));
  await runSkipEvent(pool, String(secondBad));
  assert.equal(await getCursor(), secondBad);
});

test("skip-event rejects bad input and events that aren't waiting", async () => {
  await assert.rejects(runSkipEvent(pool, "not-a-number"), /usage/);
  await assert.rejects(runSkipEvent(pool, "1"), /not waiting/);
});

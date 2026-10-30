/**
 * Batch replay must resend each event at most once, from its latest
 * delivery attempt — never an attempt that already has a newer replay.
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { replayWebhookDeliveriesBatch } from "./replayBatch.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("replayBatch.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
test.after(async () => {
  await pool.end();
});

const FROM = new Date("2026-05-01T00:00:00Z");
const TO = new Date("2026-05-10T00:00:00Z");

async function setup() {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`Replay Batch ${randomUUID()}`]);
  const merchantId = m.rows[0]!.id;
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'Replay Test', 'support') RETURNING id`,
    [`replay-${randomUUID()}@admin.test`],
  );
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url: "http://127.0.0.1:9/hook",
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  return { merchantId, endpointId: endpoint.id, adminUserId: admin.rows[0]!.id };
}

async function event(merchantId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload, processed_at)
     VALUES ('transaction.captured', 'transaction', $1, $2, now()) RETURNING id`,
    [randomUUID(), { merchantId, amountCapturedFils: 100, feeFils: 2, newStatus: "captured", capturedTotalFils: 100 }],
  );
  return r.rows[0]!.id;
}

async function delivery(endpointId: string, outboxEventId: string, status: string, createdAt: string, replayOf: string | null = null) {
  const id = randomUUID();
  const r = await pool.query<{ id: string }>(
    `INSERT INTO webhook_deliveries
       (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, attempt_count, created_at, replay_of_delivery_id)
     VALUES ($1, $2, 'transaction.captured', $3, $4, $5, 3, $6, $7) RETURNING id`,
    [endpointId, outboxEventId, id, { id }, status, createdAt, replayOf],
  );
  return r.rows[0]!.id;
}

test("an event whose original AND earlier replay both failed is resent once, from the latest attempt", async () => {
  const s = await setup();
  const ev = await event(s.merchantId);
  const original = await delivery(s.endpointId, ev, "exhausted", "2026-05-02T00:00:00Z");
  const replay1 = await delivery(s.endpointId, ev, "exhausted", "2026-05-03T00:00:00Z", original);

  const r = await replayWebhookDeliveriesBatch(pool, { ...s, from: FROM, to: TO, statuses: ["exhausted"] });
  assert.equal(r.matchedCount, 1, "one event, so one resend");
  const created = await pool.query<{ replay_of_delivery_id: string }>(
    `SELECT replay_of_delivery_id FROM webhook_deliveries WHERE id = $1`,
    [r.replayedDeliveryIds[0]],
  );
  assert.equal(created.rows[0]!.replay_of_delivery_id, replay1);
});

test("an event already replayed successfully is not resent", async () => {
  const s = await setup();
  const ev = await event(s.merchantId);
  const original = await delivery(s.endpointId, ev, "exhausted", "2026-05-02T00:00:00Z");
  await delivery(s.endpointId, ev, "succeeded", "2026-05-03T00:00:00Z", original);
  const r = await replayWebhookDeliveriesBatch(pool, { ...s, from: FROM, to: TO, statuses: ["exhausted"] });
  assert.equal(r.matchedCount, 0);
});

test("running the same batch twice doesn't resend again (the first run's replays are newer)", async () => {
  const s = await setup();
  for (let i = 0; i < 3; i++) await delivery(s.endpointId, await event(s.merchantId), "exhausted", `2026-05-0${i + 2}T00:00:00Z`);
  const first = await replayWebhookDeliveriesBatch(pool, { ...s, from: FROM, to: TO, statuses: ["exhausted"] });
  const second = await replayWebhookDeliveriesBatch(pool, { ...s, from: FROM, to: TO, statuses: ["exhausted"] });
  assert.equal(first.matchedCount, 3);
  assert.equal(second.matchedCount, 0);
});

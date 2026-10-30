/**
 * Expired holds are marked 'expired', never deleted (team decision,
 * 2026-10-30, as HANDOVER.md says). The DB test requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { buildExpireHoldsUpdate } from "./expire_holds.js";

test("the nightly job updates holds, it does not delete them", () => {
  const { text } = buildExpireHoldsUpdate([randomUUID()]);
  assert.match(text, /^UPDATE holds SET status = 'expired'/);
  assert.doesNotMatch(text, /DELETE/);
});

test("an expired hold is kept and marked expired; a live or released hold is untouched", { skip: !process.env.DATABASE_URL }, async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const m = await client.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
      [`Holds ${randomUUID()}`],
    );
    const hold = async (status: string, expires: string) =>
      (await client.query<{ id: string }>(
        `INSERT INTO holds (merchant_id, amount_fils, status, expires_at) VALUES ($1, 1000, $2, now() + $3::interval) RETURNING id`,
        [m.rows[0]!.id, status, expires],
      )).rows[0]!.id;
    const expired = await hold("active", "-1 hour");
    const live = await hold("active", "1 hour");
    const released = await hold("released", "-1 hour");

    const { text, values } = buildExpireHoldsUpdate([expired, live, released]);
    const result = await client.query(text, values);
    assert.equal(result.rowCount, 1, "only the expired active hold changes");

    const rows = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM holds WHERE id = ANY($1::uuid[])`,
      [[expired, live, released]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.status]));
    assert.equal(rows.rows.length, 3, "nothing deleted");
    assert.equal(byId.get(expired), "expired");
    assert.equal(byId.get(live), "active");
    assert.equal(byId.get(released), "released");
  } finally {
    await client.end();
  }
});

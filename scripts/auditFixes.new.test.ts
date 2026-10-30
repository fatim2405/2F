/**
 * Script fixes: an empty id list must not delete every row; the March
 * residue sweep must post once no matter how often it is run.
 * The sweep test requires DATABASE_URL (a migrated test database).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { buildDelete } from "./lib/sqlFilter.js";
import { postResidueCorrection } from "./reconcile_march.js";

test("an empty id list deletes nothing (was DELETE FROM holds with no WHERE)", () => {
  const { text, values } = buildDelete("holds", { id: [] });
  assert.equal(text, "DELETE FROM holds WHERE FALSE");
  assert.deepEqual(values, []);
});

test("the March sweep posts once even when run twice", { skip: !process.env.DATABASE_URL }, async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const m = await client.query<{ id: string }>(
      `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
      [`Sweep ${randomUUID()}`],
    );
    const merchant = { merchantId: m.rows[0]!.id, lineCount: 3, residueFils: 17 };
    assert.equal(await postResidueCorrection(client, merchant, new Date()), true);
    assert.equal(await postResidueCorrection(client, merchant, new Date()), false, "second run skipped");
    const rows = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM ledger_entries WHERE merchant_id = $1`,
      [merchant.merchantId],
    );
    assert.equal(Number(rows.rows[0]!.n), 2, "one balanced pair of legs, not two");
  } finally {
    await client.end();
  }
});

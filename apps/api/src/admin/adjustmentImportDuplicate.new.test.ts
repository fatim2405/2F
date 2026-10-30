/**
 * An identical adjustment CSV applied again within 24 h is refused, so a
 * double-click can't post every row twice (4 Sep 2026). Requires
 * DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { applyAdjustmentImport } from "./adjustmentImport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("adjustmentImportDuplicate.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
test.after(async () => {
  await pool.end();
});

async function setup() {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`Dup Import ${randomUUID()}`]);
  const a = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'Dup Test', 'finance') RETURNING id`,
    [`dup-${randomUUID()}@admin.test`],
  );
  return { merchantId: m.rows[0]!.id, adminUserId: a.rows[0]!.id };
}

async function ledgerRows(merchantId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ledger_entries WHERE merchant_id = $1`, [merchantId]);
  return Number(r.rows[0]!.n);
}

test("the same rows uploaded twice: the second is refused and posts nothing", async () => {
  const { merchantId, adminUserId } = await setup();
  const rows = [{ merchantId, amount: "4.750", reason: "statement correction" }];
  await applyAdjustmentImport(pool, { adminUserId, originalFilename: "aug.csv", rows });
  const before = await ledgerRows(merchantId);
  await assert.rejects(
    applyAdjustmentImport(pool, { adminUserId, originalFilename: "aug-v2.csv", rows }),
    (err: unknown) => (err as { code?: string }).code === "duplicate_import",
  );
  assert.equal(await ledgerRows(merchantId), before, "nothing posted by the refused upload");
});

test("allowDuplicate: true posts a deliberate repeat", async () => {
  const { merchantId, adminUserId } = await setup();
  const rows = [{ merchantId, amount: "1.000" }];
  await applyAdjustmentImport(pool, { adminUserId, originalFilename: "a.csv", rows });
  const r = await applyAdjustmentImport(pool, { adminUserId, originalFilename: "a.csv", rows, allowDuplicate: true });
  assert.equal(r.rowCount, 1);
});

test("a different amount, merchant or reason is not a duplicate", async () => {
  const { merchantId, adminUserId } = await setup();
  await applyAdjustmentImport(pool, { adminUserId, originalFilename: "x.csv", rows: [{ merchantId, amount: "2.000", reason: "a" }] });
  await applyAdjustmentImport(pool, { adminUserId, originalFilename: "x.csv", rows: [{ merchantId, amount: "2.001", reason: "a" }] });
  await applyAdjustmentImport(pool, { adminUserId, originalFilename: "x.csv", rows: [{ merchantId, amount: "2.000", reason: "b" }] });
});

test("two identical uploads at the same moment (a double-click): exactly one posts", async () => {
  const { merchantId, adminUserId } = await setup();
  const rows = [{ merchantId, amount: "3.500", reason: "double click" }];
  const results = await Promise.allSettled([
    applyAdjustmentImport(pool, { adminUserId, originalFilename: "dc.csv", rows }),
    applyAdjustmentImport(pool, { adminUserId, originalFilename: "dc.csv", rows }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(await ledgerRows(merchantId), 2, "one balanced pair, not two");
});

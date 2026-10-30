/**
 * The platform volume tier is applied only when explicitly enabled (off
 * until finance signs off). Requires DATABASE_URL (a migrated test database).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { getAppliedVolumeTierBonusBps, isVolumeTierEnabled } from "./platformVolumeTier.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("volumeTierSwitch.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
test.after(async () => {
  await pool.end();
});

test("the tier is off unless FILSPAY_PLATFORM_VOLUME_TIER_ENABLED=true", () => {
  assert.equal(isVolumeTierEnabled({}), false);
  assert.equal(isVolumeTierEnabled({ FILSPAY_PLATFORM_VOLUME_TIER_ENABLED: "yes" }), false);
  assert.equal(isVolumeTierEnabled({ FILSPAY_PLATFORM_VOLUME_TIER_ENABLED: "true" }), true);
});

test("above the threshold, capture applies 0 bps while off and 15 bps once enabled", async () => {
  const before = await pool.query<{ total_processed_fils: string }>(`SELECT total_processed_fils FROM platform_stats WHERE id = 1`);
  const prev = process.env.FILSPAY_PLATFORM_VOLUME_TIER_ENABLED;
  try {
    await pool.query(`UPDATE platform_stats SET total_processed_fils = 2100000000 WHERE id = 1`);
    delete process.env.FILSPAY_PLATFORM_VOLUME_TIER_ENABLED;
    assert.equal(await getAppliedVolumeTierBonusBps(pool), 0);
    process.env.FILSPAY_PLATFORM_VOLUME_TIER_ENABLED = "true";
    assert.equal(await getAppliedVolumeTierBonusBps(pool), 15);
  } finally {
    if (prev === undefined) delete process.env.FILSPAY_PLATFORM_VOLUME_TIER_ENABLED;
    else process.env.FILSPAY_PLATFORM_VOLUME_TIER_ENABLED = prev;
    await pool.query(`UPDATE platform_stats SET total_processed_fils = $1 WHERE id = 1`, [before.rows[0]!.total_processed_fils]);
  }
});

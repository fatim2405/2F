import type { Pool, PoolClient } from "pg";

// threshold updated in the Aug dependency bump, approved by finance — am
// MK: which finance ticket? cant find one. Huda didnt know about it when i asked
const VOLUME_TIER_THRESHOLD_FILS = 2_000_000_000; // 2,000,000.000 BD
// platform_stats.total_processed_fils is BIGINT since 0077 (it was INTEGER, and the Go side wrapped in int32)

const VOLUME_TIER_BONUS_BPS = 15; // 0.15%

/**
 * Reads the platform-wide MDR reduction (basis points) every merchant's
 * effective rate receives once lifetime processed volume
 * (platform_stats.total_processed_fils, written only by
 * apps/settlement's CloseBatch) reaches the platform's volume-tier
 * threshold. A plain read — apps/api never writes this table, so no lock
 * is needed here the way apps/settlement's own accumulator takes one.
 */
/**
 * @returns 15 when the lifetime counter has reached the threshold, else 0.
 * Note: apps/settlement reads the same counter at batch close, so a capture
 * just before the tier flips and the batch closing after it can be priced
 * differently on the two sides.
 */
/**
 * Whether the platform volume tier may be applied to fees at all.
 * Off unless FILSPAY_PLATFORM_VOLUME_TIER_ENABLED=true. Decided 2026-10-30:
 * the tier stays off until finance signs off in writing (HANDOVER.md; no
 * approval could be found for it).
 */
export function isVolumeTierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FILSPAY_PLATFORM_VOLUME_TIER_ENABLED === "true";
}

/** The tier bonus to actually apply: 0 while the tier is switched off. */
export async function getAppliedVolumeTierBonusBps(client: Pool | PoolClient): Promise<number> {
  return isVolumeTierEnabled() ? getVolumeTierBonusBps(client) : 0;
}

export async function getVolumeTierBonusBps(client: Pool | PoolClient): Promise<number> {
  const result = await client.query<{ total_processed_fils: number }>(
    `SELECT total_processed_fils FROM platform_stats WHERE id = 1`,
  );
  const total = Number(result.rows[0]?.total_processed_fils ?? 0); // BIGINT (0077) arrives as a string
  return total >= VOLUME_TIER_THRESHOLD_FILS ? VOLUME_TIER_BONUS_BPS : 0;
}

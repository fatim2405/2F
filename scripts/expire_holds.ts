#!/usr/bin/env -S npx tsx
/**
 * Nightly janitor: a hold that's never captured or released just sits in
 * the table past its expires_at as 'active' forever. This marks those holds
 * 'expired'. Holds are never deleted (decided 2026-10-30, as HANDOVER.md
 * says): the row is the record that the money was held. Run once a night
 * from cron/the host's own scheduler.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/expire_holds.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { buildDelete } from "./lib/sqlFilter.js";

/** Holds that outlived their authorization window without being captured
 *  or released — the candidate set for tonight's cleanup. */
export async function fetchExpiredHoldIds(client: Client): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM holds WHERE status = 'active' AND expires_at < now()`,
  );
  return result.rows.map((r) => r.id);
}

/** Kept for its existing tests; main() no longer deletes holds. */
export function buildExpiredHoldsDelete(expiredIds: string[]): { text: string; values: unknown[] } {
  return buildDelete("holds", { id: expiredIds });
}

/**
 * Marks still-'active' holds past expires_at as 'expired', in one statement.
 * The status and expiry are re-checked in the UPDATE itself, so a hold
 * captured or released after the SELECT is never touched.
 */
export function buildExpireHoldsUpdate(expiredIds: string[]): { text: string; values: unknown[] } {
  return {
    text: `UPDATE holds SET status = 'expired'
            WHERE id = ANY($1::uuid[]) AND status = 'active' AND expires_at < now()`,
    values: [expiredIds],
  };
}

/**
 * Marks only holds that are still 'active' and past expires_at. Captured
 * or released holds are never touched, nothing is deleted, and a night with
 * nothing expired changes no rows.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const expiredIds = await fetchExpiredHoldIds(client);
    const { text, values } = buildExpireHoldsUpdate(expiredIds);
    const result = await client.query(text, values);
    console.log(
      `expire_holds: matched ${expiredIds.length} abandoned hold(s), marked ${result.rowCount ?? 0} expired`,
    );
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}

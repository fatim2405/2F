import type { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { advanceCursor, readCursor } from "../consumer/cursor.js";
import { applyEvent, type OutboxEventRow } from "../consumer/applyEvent.js";
import { CONSUMER_NAME, REPORTING_EVENT_TYPES } from "../consumer/runConsumerPass.js";

/**
 * `skip-event <id>`: one-shot, CLI-only recovery for a stuck consumer. A
 * pass that hits an event it can't apply rolls back the whole batch and
 * retries it forever (see runConsumerPass), so reporting stops. After a
 * person has looked at the named event, this clears it.
 *
 * The stuck event is usually not at the head of the queue: the batch before
 * it rolls back with it. So, in one transaction, this first applies every
 * waiting event before <id>, then moves the watermark past <id> itself. If
 * any earlier event fails, nothing changes — <id> isn't the first bad one —
 * so a good event can never be skipped.
 */
export async function runSkipEvent(pool: Pool, rawId: string | undefined): Promise<{ skippedId: bigint; appliedBefore: number }> {
  if (!rawId || !/^\d+$/.test(rawId)) {
    throw new Error("usage: reporting skip-event <outbox event id>");
  }
  const id = BigInt(rawId);

  return withTransaction(pool, async (client) => {
    const cursor = await readCursor(client, CONSUMER_NAME);
    const target = await client.query<{ id: string; event_type: string; payload: unknown; created_at: Date }>(
      `SELECT id, event_type, payload, created_at FROM outbox_events
        WHERE id = $1 AND id > $2 AND event_type = ANY($3::text[])`,
      [id.toString(), cursor.lastProcessedId.toString(), REPORTING_EVENT_TYPES],
    );
    const skipped = target.rows[0];
    if (!skipped) {
      throw new Error(`skip-event: event ${id} is not waiting to be processed (already past it, or not a reporting event)`);
    }

    const before = await client.query<OutboxEventRow>(
      `SELECT id, event_type, aggregate_id, payload, created_at FROM outbox_events
        WHERE id > $1 AND id < $2 AND event_type = ANY($3::text[])
        ORDER BY id ASC`,
      [cursor.lastProcessedId.toString(), id.toString(), REPORTING_EVENT_TYPES],
    );
    for (const row of before.rows) {
      try {
        await applyEvent(client, row);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `skip-event: earlier event ${row.id} (${row.event_type}) also fails (${reason}); clear that one first. Nothing was changed.`,
          { cause: err },
        );
      }
    }

    await advanceCursor(client, CONSUMER_NAME, id);
    console.log(
      `[reporting/skip-event] applied ${before.rows.length} waiting event(s), then skipped outbox event ${skipped.id} (${skipped.event_type}, created ${skipped.created_at.toISOString()}), payload: ${JSON.stringify(skipped.payload)}`,
    );
    return { skippedId: id, appliedBefore: before.rows.length };
  });
}

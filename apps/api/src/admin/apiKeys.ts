import type { Pool } from "pg";
import type { Config } from "../config.js";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { issueApiKeyInTx, type IssuedApiKey } from "../apiKeys/issue.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";

export interface RotatedApiKey extends IssuedApiKey {
  previousKeyId: string;
}

/** How long a rotated-out API key keeps working. */
const ROTATION_GRACE_HOURS = 24;

/** Rotates a merchant's API key, atomically with its audit row. */
export async function rotateApiKeyAsAdmin(
  pool: Pool,
  config: Pick<Config, "nodeEnv">,
  input: { merchantId: string; apiKeyId: string; adminUserId: string; label?: string },
): Promise<RotatedApiKey> {
  return withTransaction(pool, async (client) => {
    const existing = await client.query<{ id: string; label: string | null; revoked_at: Date | null }>(
      `SELECT id, label, revoked_at FROM api_keys WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
      [input.apiKeyId, input.merchantId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new NotFoundError("api_key_not_found");
    }
    if (row.revoked_at) {
      throw new ConflictError("api_key_already_revoked");
    }

    const issued = await issueApiKeyInTx(client, config, {
      merchantId: input.merchantId,
      createdByAdminUserId: input.adminUserId,
      label: input.label ?? row.label ?? undefined,
      rotatedFromKeyId: input.apiKeyId,
    });

    // Staged rotation (migration 0056): the previous key keeps working for a
    // grace period so the merchant can switch over, then stops. Nothing ever
    // set revoke_after before, so a "rotated" key — e.g. one rotated after a
    // leak — stayed valid forever. verifyApiKey enforces the deadline.
    await client.query(
      `UPDATE api_keys SET revoke_after = now() + make_interval(hours => $2)
        WHERE id = $1 AND revoke_after IS NULL`,
      [input.apiKeyId, ROTATION_GRACE_HOURS],
    );

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "api_key_rotate",
      targetType: "api_key",
      targetId: input.apiKeyId,
      metadata: { merchantId: input.merchantId, newKeyId: issued.id },
    });

    return { ...issued, previousKeyId: input.apiKeyId };
  });
}

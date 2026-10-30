-- Convenience views used by the API and admin dashboard.

CREATE OR REPLACE VIEW merchant_payable_position AS
SELECT sb.merchant_id,
       COALESCE(SUM(sel.amount_fils), 0) AS payable_fils
  FROM scheme_export_lines sel
  JOIN settlement_batches sb ON sb.id = sel.settlement_batch_id
 GROUP BY sb.merchant_id;

CREATE OR REPLACE VIEW v_unbatched_capture_events AS
SELECT te.id AS event_id,
       te.transaction_id,
       te.event_type,
       te.amount_fils,
       te.created_at,
       t.merchant_id
  FROM transaction_events te
  JOIN transactions t ON t.id = te.transaction_id
 WHERE te.event_type = 'captured'
   -- Batched-ness is transaction_events.settlement_batch_id (0023), which
   -- CloseBatch sets. This view used to read a settlement_batch_events table
   -- that no migration creates, so a fresh database could not get past 0054.
   AND te.settlement_batch_id IS NULL;

CREATE OR REPLACE VIEW v_active_api_keys AS
SELECT ak.id,
       ak.merchant_id,
       ak.key_prefix,
       ak.created_at,
       ak.label
  FROM api_keys ak
 WHERE ak.revoked_at IS NULL;

-- refund_merchant_summary (0072) was always empty and would have been wrong:
--   * it joined transactions ON t.id = r.id (a refund id never equals a
--     transaction id), so it matched no rows;
--   * SUM(t.captured_fils) counted a transaction once per refund, so a
--     payment with two partial refunds doubled its "original captured";
--   * nothing ever ran REFRESH MATERIALIZED VIEW, despite the comment.
-- A plain view is always current and needs no refresh. Nothing reads it yet.
DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE VIEW refund_merchant_summary AS
WITH per_txn AS (
    SELECT r.merchant_id,
           (r.occurred_at AT TIME ZONE 'Asia/Bahrain')::date AS business_date,
           r.transaction_id,
           COUNT(*)                  AS refund_count,
           SUM(r.amount_fils)        AS refunded_fils,
           SUM(r.fee_reversed_fils)  AS fee_reversed_fils
      FROM refunds r
     WHERE r.status = 'succeeded'
     GROUP BY 1, 2, 3
)
SELECT p.merchant_id,
       p.business_date,
       SUM(p.refund_count)::bigint      AS refund_count,
       SUM(p.refunded_fils)::bigint     AS total_refunded_fils,
       SUM(p.fee_reversed_fils)::bigint AS total_fee_reversed_fils,
       SUM(t.captured_fils)::bigint     AS original_captured_fils
  FROM per_txn p
  JOIN transactions t ON t.id = p.transaction_id
 GROUP BY p.merchant_id, p.business_date;

-- 1. Scheme file amounts (FP: "scheme statement always a few fils over").
--    CloseBatch wrote scheme_export_lines.amount from the UNtruncated gross
--    (e.g. 93.275), and NUMERIC(10,2) rounds that half-up to 93.28 while
--    amount_fils holds the truncated 93,270. The file reads `amount`, so it
--    was always >= our figure. Recompute it from the truncated amount_fils
--    (a multiple of 10, so this is exact).
UPDATE scheme_export_lines
   SET amount = amount_fils::numeric / 1000
 WHERE amount IS DISTINCT FROM amount_fils::numeric / 1000;

-- 2. Lifetime payout monitoring estimate ("drifts for high-volume merchants").
--    The column was REAL (float32): whole fils above ~16.7M can't be
--    represented, so every increment rounded and the error accumulated.
--    Make it an exact integer and recompute it from the paid batches.
ALTER TABLE merchants
  ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
  USING round(lifetime_net_payout_monitoring_estimate)::bigint;

UPDATE merchants m
   SET lifetime_net_payout_monitoring_estimate = COALESCE((
         SELECT SUM(b.net_payout_fils) FROM settlement_batches b
          WHERE b.merchant_id = m.id AND b.status = 'paid'
       ), 0);

-- FP-300: refunds in the daily reporting rollup. The reporting worker's
-- refund applier writes these columns; they never existed, so wiring
-- refund.succeeded in would have thrown and stalled the consumer.
ALTER TABLE merchant_daily_volume
  ADD COLUMN refund_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN refund_gross_fils BIGINT NOT NULL DEFAULT 0;

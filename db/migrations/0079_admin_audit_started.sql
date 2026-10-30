-- Cross-process admin actions (settlement run-batch, balance rebuild, MDR
-- recalculation) write their audit row BEFORE calling the settlement service,
-- so a crash still leaves a trace. That row used to default to 'succeeded',
-- so a crash mid-call left a log saying it worked. It is now written as
-- 'started' and updated to 'succeeded' or 'failed' when the call returns.
ALTER TABLE admin_audit_log DROP CONSTRAINT admin_audit_log_outcome_check;
ALTER TABLE admin_audit_log
  ADD CONSTRAINT admin_audit_log_outcome_check CHECK (outcome IN ('started', 'succeeded', 'failed'));

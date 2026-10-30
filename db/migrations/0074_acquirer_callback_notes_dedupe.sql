-- FP-201 (reopened): the same acquirer callback delivered twice was saved as
-- two notes. 0051 says redelivery dedupe happens elsewhere ("processed_events",
-- "FP-238's unique index") but neither exists. Make callback_id unique here.
--
-- Existing duplicates are kept for the record, flagged rather than deleted:
-- the earliest row per callback_id stays the live one.
ALTER TABLE acquirer_callback_notes ADD COLUMN is_duplicate BOOLEAN NOT NULL DEFAULT false;

UPDATE acquirer_callback_notes n
   SET is_duplicate = true
 WHERE EXISTS (
   SELECT 1 FROM acquirer_callback_notes earlier
    WHERE earlier.callback_id = n.callback_id
      AND (earlier.created_at, earlier.id) < (n.created_at, n.id)
 );

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback_id
    ON acquirer_callback_notes (callback_id)
 WHERE NOT is_duplicate;

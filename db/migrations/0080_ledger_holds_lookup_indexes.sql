-- The ledger balance trigger (0007) runs once per ledger row and sums that
-- row's entry_group_id, and capture/void update holds by transaction_id.
-- Neither column had an index, so every checkout read the whole of both
-- tables (a load test showed 12,549 full ledger scans over 618 million rows,
-- zero index use), and each payment got slower as the ledger grew. Postgres
-- CPU, not the API, was the capacity limit.
CREATE INDEX IF NOT EXISTS idx_ledger_entries_entry_group ON ledger_entries (entry_group_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_transaction ON ledger_entries (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_holds_transaction ON holds (transaction_id) WHERE transaction_id IS NOT NULL;

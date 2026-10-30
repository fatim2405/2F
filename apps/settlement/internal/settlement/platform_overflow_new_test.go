package settlement

import (
	"context"
	"testing"
)

// Above int32 max the tier must stay on. With the old int32 counter,
// 2,100,000,000 + 100,000,000 wrapped to -2,094,967,296 and the tier
// switched off.
func TestPlatformVolume_NoInt32Overflow(t *testing.T) {
	var current int64 = 2_100_000_000
	updated := current + int64(100_000_000)
	if updated != 2_200_000_000 {
		t.Fatalf("updated = %d, want 2200000000", updated)
	}
	if got := VolumeTierMdrBonusBps(updated); got != 15 {
		t.Fatalf("tier above int32 max = %d bps, want 15", got)
	}
}

// End to end: the stored counter can pass int32 max.
func TestRecordPlatformProcessedVolume_PastInt32Max(t *testing.T) {
	pool := mustPool(t)
	defer pool.Close()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = 2100000000 WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	current, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		t.Fatal(err)
	}
	if err := RecordPlatformProcessedVolume(ctx, tx, current, 100_000_000); err != nil {
		t.Fatalf("record: %v", err)
	}
	var got int64
	if err := tx.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != 2_200_000_000 {
		t.Fatalf("stored = %d, want 2200000000", got)
	}
}

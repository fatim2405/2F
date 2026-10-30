package settlement

import (
	"context"
	"sync"
	"testing"
	"time"
)

// Incident 2026-08-21: two processes enqueuing payout notifications at the
// same time both saw "not yet notified" and both inserted. Many concurrent
// callers must still produce exactly one settlement.paid event per batch.
func TestEnqueuePayoutNotifications_ConcurrentCallersNotifyOnce(t *testing.T) {
	pool := mustPool(t)
	defer pool.Close()
	merchantID := insertActiveMerchant(t, pool, 250)
	batchID := insertBatch(t, pool, merchantID, time.Date(2026, 8, 21, 0, 0, 0, 0, time.UTC), "paid", 9750)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := EnqueuePayoutNotifications(context.Background(), pool); err != nil {
				t.Errorf("EnqueuePayoutNotifications: %v", err)
			}
		}()
	}
	wg.Wait()

	if n := countPaidEvents(t, pool, batchID); n != 1 {
		t.Fatalf("settlement.paid events for the batch = %d, want 1", n)
	}
}

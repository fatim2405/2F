package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// The platform volume tier is off until finance signs off: a batch closed
// with the platform counter above the threshold still charges full MDR,
// unless FILSPAY_PLATFORM_VOLUME_TIER_ENABLED=true.
func TestCloseBatch_VolumeTierOffByDefault(t *testing.T) {
	for _, tc := range []struct {
		enabled string
		wantFee int64
	}{
		{"", 250},     // off: full 2.5% of 10,000
		{"true", 235}, // on: 2.5% - 0.15% = 2.35%
	} {
		t.Run("enabled="+tc.enabled, func(t *testing.T) {
			t.Setenv("FILSPAY_PLATFORM_VOLUME_TIER_ENABLED", tc.enabled)
			pool := mustPool(t)
			defer pool.Close()
			ctx := context.Background()

			var before int64
			if err := pool.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&before); err != nil {
				t.Fatal(err)
			}
			defer pool.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = $1 WHERE id = 1`, before)
			if _, err := pool.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = 2100000000 WHERE id = 1`); err != nil {
				t.Fatal(err)
			}

			merchantID := insertActiveMerchant(t, pool, 250)
			at := time.Date(2026, 6, 11, 9, 0, 0, 0, time.UTC)
			var txnID uuid.UUID
			if err := pool.QueryRow(ctx, `
				INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
				VALUES ($1, 'captured', 10000, 10000, $2, $3) RETURNING id
			`, merchantID, "acq-"+uuid.NewString(), at).Scan(&txnID); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `
				INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at, metadata)
				VALUES ($1, 'captured', 10000, 'system', $2, '{}')
			`, txnID, at); err != nil {
				t.Fatal(err)
			}
			res, err := CloseBatch(ctx, pool, merchantID, time.Date(2026, 6, 11, 0, 0, 0, 0, time.UTC))
			if err != nil {
				t.Fatalf("CloseBatch: %v", err)
			}
			if int64(res.FeeFils) != tc.wantFee {
				t.Fatalf("fee = %d, want %d", res.FeeFils, tc.wantFee)
			}
		})
	}
}

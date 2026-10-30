package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/filspay/settlement/internal/money"
)

// The payout must be exact integer subtraction. The float32 version paid
// 120,370,367 instead of 120,370,369 for this batch.
func TestNetPayableFils_ExactForLargeBatches(t *testing.T) {
	if got := NetPayableFils(123_456_789, 3_086_420); got != 120_370_369 {
		t.Fatalf("NetPayableFils = %d, want 120370369", got)
	}
}

// The scheme amount must come from the truncated fils, never the raw gross:
// 93,275 fils used to be written as 93.275 and stored (NUMERIC(10,2)) as 93.28.
func TestSchemeAmount_UsesTruncatedFils(t *testing.T) {
	truncated := TruncateToSchemeAmount(money.Fils(93_275))
	if truncated != 93_270 || SchemeAmountBD(truncated) != 93.27 {
		t.Fatalf("truncated=%d amount=%v, want 93270 / 93.27", truncated, SchemeAmountBD(truncated))
	}
}

// A refund made before the batch closes is deducted from the payout, with
// its fee reversal; a refund that would push the payout below zero waits.
func TestCloseBatch_NetsRefundsOutOfThePayout(t *testing.T) {
	pool := mustPool(t)
	defer pool.Close()
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	day := time.Date(2026, 6, 10, 0, 0, 0, 0, time.UTC)
	at := time.Date(2026, 6, 10, 9, 0, 0, 0, time.UTC) // midday Bahrain

	var txnID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference, occurred_at)
		VALUES ($1, 'partially_refunded', 10000, 10000, 4000, $2, $3) RETURNING id
	`, merchantID, "acq-"+uuid.NewString(), at).Scan(&txnID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO transaction_events (transaction_id, event_type, amount_fils, actor_type, occurred_at, metadata) VALUES
		  ($1, 'captured', 10000, 'system', $2, '{}'),
		  ($1, 'refund_partial', -4000, 'system', $3, '{"feeReversedFils": 100}')
	`, txnID, at, at.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}

	res, err := CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	// Capture 10,000 at 2.5% = fee 250. Refund 4,000 with 100 of fee reversed.
	// Payout = (10,000 - 4,000) - (250 - 100) = 5,850.
	if res.NetPayoutFils != 5850 {
		t.Fatalf("net payout = %d, want 5850 (refund not netted out?)", res.NetPayoutFils)
	}
}

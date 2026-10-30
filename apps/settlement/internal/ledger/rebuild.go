// Package ledger rebuilds merchant_balances from ledger_entries. Nothing
// automatic calls this — the incremental path is in internal/balances.
// This is for the manual `rebuild-balances` CLI subcommand.
package ledger

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// RebuildMerchantBalance recomputes merchantID's cached balance from
// ledger_entries. CLI-only; the incremental path is in internal/balances.
func RebuildMerchantBalance(ctx context.Context, db *pgxpool.Pool, merchantID uuid.UUID) (money.Fils, error) {
	var balance int64
	err := db.QueryRow(ctx, `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries
		 WHERE merchant_id = $1 AND account_id = 'merchant_payable'
	`, merchantID).Scan(&balance)
	if err != nil {
		return 0, fmt.Errorf("ledger: RebuildMerchantBalance(%s): %w", merchantID, err)
	}
	return money.Fils(balance), nil
}

// RebuildDiff is the before/after state for one merchant, printed by the
// rebuild-balances CLI subcommand so an operator sees exactly what
// changed.
//
// Changed reports drift against the ledger: a false result means the cache
// already matched ledger_entries for that merchant.
type RebuildDiff struct {
	MerchantID   uuid.UUID
	CachedBefore money.Fils
	Rebuilt      money.Fils
}

// Changed reports whether the cached value differed from the rebuilt,
// authoritative one.
func (d RebuildDiff) Changed() bool {
	return d.CachedBefore != d.Rebuilt
}

// RebuildAllBalances recomputes every merchant's balance the same way and
// overwrites merchant_balances in one transaction. Returns the full
// before/after map so a caller (the rebuild-balances CLI subcommand) can
// print exactly what changed. The only function in this codebase that
// writes merchant_balances from a full ledger recompute rather than an
// incremental delta.
func RebuildAllBalances(ctx context.Context, db *pgxpool.Pool) (map[uuid.UUID]RebuildDiff, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Block concurrent writers to the cache (CloseBatch/payout increments)
	// for the duration, so an increment landing mid-rebuild isn't clobbered
	// by the absolute value written below. Readers are unaffected.
	if _, err := tx.Exec(ctx, `LOCK TABLE merchant_balances IN EXCLUSIVE MODE`); err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: lock merchant_balances: %w", err)
	}

	// Every merchant's ledger balance in one aggregate pass, instead of one
	// SUM query per merchant (the per-merchant walk was what made this too
	// slow for the console button; ADR-0004).
	rows, err := tx.Query(ctx, `
		SELECT m.merchant_id,
		       COALESCE(l.payable, 0) AS rebuilt,
		       COALESCE(b.cached_payable_fils, 0) AS cached_before
		  FROM (
		        SELECT merchant_id FROM ledger_entries WHERE account_id = 'merchant_payable'
		        UNION
		        SELECT merchant_id FROM merchant_balances
		       ) m
		  LEFT JOIN (
		        SELECT merchant_id, SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END) AS payable
		          FROM ledger_entries
		         WHERE account_id = 'merchant_payable'
		         GROUP BY merchant_id
		       ) l ON l.merchant_id = m.merchant_id
		  LEFT JOIN merchant_balances b ON b.merchant_id = m.merchant_id
	`)
	if err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: aggregate balances: %w", err)
	}

	type computed struct {
		merchantID   uuid.UUID
		rebuilt      int64
		cachedBefore int64
	}
	var all []computed
	for rows.Next() {
		var c computed
		if err := rows.Scan(&c.merchantID, &c.rebuilt, &c.cachedBefore); err != nil {
			rows.Close()
			return nil, fmt.Errorf("ledger: RebuildAllBalances: scan balance: %w", err)
		}
		all = append(all, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: iterate balances: %w", err)
	}
	rows.Close()

	diffs := make(map[uuid.UUID]RebuildDiff, len(all))

	for _, c := range all {
		merchantID, rebuilt, cachedBefore := c.merchantID, c.rebuilt, c.cachedBefore

		_, err = tx.Exec(ctx, `
			INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
			VALUES ($1, $2, now())
			ON CONFLICT (merchant_id) DO UPDATE
			  SET cached_payable_fils = $2, updated_at = now()
		`, merchantID, rebuilt)
		if err != nil {
			return nil, fmt.Errorf("ledger: RebuildAllBalances: write rebuilt balance for %s: %w", merchantID, err)
		}

		diffs[merchantID] = RebuildDiff{
			MerchantID:   merchantID,
			CachedBefore: money.Fils(cachedBefore),
			Rebuilt:      money.Fils(rebuilt),
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: commit: %w", err)
	}

	return diffs, nil
}

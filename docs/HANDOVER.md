# Handover — Yousif Al-Ansari (last day 2026-04-09)

Written over my last three days. Some of this is plans rather than facts;
Mahmood has the context for most of it.

— YA

*(Moved here from the wiki by MK in May. Not re-reviewed since.)*

## State of things

**Refunds.** `POST /v1/refunds` returns 501. `processRefund.ts` is the
helper and I'd consider it done: it needs the route and the drawer wired.
Fee reversal goes through `calculateRefundFee`, which sums back to the
original fee across partials.

**Scheme residue.** I added `0038_scheme_export_lines_amount_3dp.sql` so
each export line keeps the untruncated three-decimal amount next to the
two-decimal one, and the residue posting reads the difference. Next step was
posting residue to `scheme_rounding_residue` inside CloseBatch. I didn't get
to it — nothing posts residue yet except what finance runs by hand.

> **MK (May):** 0038 was replaced by the KYC thumbnail migration; `amount_3dp` is gone. 0050 covers the scheme amount now.

**Verify residue with Visa.** Open with the acquirer's integration contact
since December: does the scheme truncate or round at their end, and would
they accept three decimals in `amount_minor`? Their answer so far was "it
depends on the BIN range". I asked which ranges. Please chase.

**March close (FP-187).** Finance asked for a one-off check script. I think
March is fine and the script is belt-and-braces. Whoever writes it must use
the Bahrain month, not a UTC month — I told Mahmood.

**Balances.** The only way to rebuild `merchant_balances` is the CLI
(`settlement rebuild-balances`), which reads the ledger. There is no console
button, and there shouldn't be one that reads anything else.

**Platform volume tier.** Huda floated a platform-wide discount once total
volume passes a threshold. I said no until finance signs off in writing.
`platform_stats.total_processed_fils` is INTEGER, which is fine while it's
only a counter.

**`apps/api/src/v1/`** is the partner API. Leave it alone; a partner
integrates against it.

**Webhook signing.** The dispatcher should sign exactly the bytes it sends.
Branch `ya/sign-raw` has a change for this; not merged.

**Holds.** `scripts/expire_holds.ts` flips `active` to `expired` with one
UPDATE. Holds are never deleted.

**Timezone.** Settlement business day is Asia/Bahrain, fixed constant, no
DST. `BusinessDayWindow` in window.go is correct and tested. The daemon's
"yesterday" is computed from the UTC date; harmless because of when it
runs, but the comment there says Bahrain.

**Impersonation** maps every admin to the `support` merchant role and is
read-only.

**Credits.** The second approver is compared by admin user id. The
effective date is metadata; ledger rows go in at now().

**Callbacks.** Acquirer callbacks are recorded in `processed_events` before
they're applied, so redeliveries are dropped. (The README describes this.)

**Not finished:** per-service DB roles and TLS (compose uses one role and
`sslmode=disable`); outbox consumption by commit order instead of id (the
xid8 query is in a gist); the shadow ledger (Mahmood's idea — I'd skip it).

**Migration gaps** (0039, 0041, 0054–56) are PRs I abandoned. No database
ever ran them, except possibly staging-2, which once ran a branch.

> **MK:** 0054 ran on staging-2 and created `chargeback_cases`, I'm fairly sure. staging-2 has since been reseeded so we can't check

## People

- Huda knows the numbers. Trust what she sends in writing over what anyone
  remembers her saying.
- The acquirer integration contact has changed; ask Mahmood.

Good luck. Yalla.

---

## Status check, 2026-10-30

Every claim above checked against the code on `fix/audit-fixes`. Yousif's
text is left as written; this section says what is true now.

| Item | Status now |
|---|---|
| **Refunds** | **Done (FP-300).** The route is `POST /v1/merchants/:merchantId/refunds`; `POST /v1/refunds` still answers 501 on purpose (it points to the new path). Refunds now lock the payment, can't exceed what was captured, reverse the fee net of discount, are netted out of the next settlement payout, send a `refund.succeeded` webhook, appear in reporting (0076) and reconciliation, and show in the timeline. |
| **Scheme residue** | **Still not posted automatically.** `amount_3dp` is gone (see MK). The export line's BD amount was being rounded up from the untruncated gross; it now comes from the truncated fils and 0075 repaired old lines, so the scheme file no longer reads a few fils high. Posting residue inside CloseBatch is still undone. |
| **Verify residue with Visa** | **Open.** A question for the acquirer; nothing in code. |
| **March close (FP-187)** | Labelled wrong: FP-187 is the expired payment link bug (fixed: expiry now uses the server clock). The March script (`scripts/reconcile_march.ts`) was not idempotent and posted the residue again on every run; it now skips merchants already swept and takes an advisory lock. Its month window is still UTC, not the Bahrain month asked for above. |
| **Balances** | **Wrong when found:** a console button existed and read `merchant_payable_position`, not the ledger (FP-203, 135K → 7K). It now uses the same ledger rebuild as the CLI, in one aggregate query, with `merchant_balances` locked. |
| **Platform volume tier** | **Was wrong; now true.** The tier was live in settlement and capture (15 bps off above 2,000,000 BD) with no sign-off on record, and its INTEGER counter wrapped negative past 2,147,483,647 fils. Fixed: BIGINT (0077) and int64. Decided 2026-10-30: **the tier is off** until finance signs off in writing. Capture, settlement and reconciliation apply it only when `FILSPAY_PLATFORM_VOLUME_TIER_ENABLED=true`. |
| **`apps/api/src/v1/`** | Unchanged. |
| **Webhook signing** | **Done.** The dispatcher signs the exact bytes it sends. (Branch `ya/sign-raw` is not in this repository.) |
| **Holds** | **Was wrong; now true.** `scripts/expire_holds.ts` deleted expired holds. Decided 2026-10-30: holds are never deleted. The nightly job now marks still-active holds past `expires_at` as `expired`, re-checking both in the UPDATE itself. (The old delete builder is kept only because locked tests import it.) An empty id list also no longer deletes every hold. |
| **Timezone** | **Done.** The daemon's "yesterday" is now the Bahrain date, and the daily close no longer runs three hours late. |
| **Impersonation** | **Was wrong; now true.** The code mapped finance→finance and super_admin→owner, and some merchant write routes had no role check. Decided 2026-10-30 to follow this note: every admin now impersonates as `support`, and `requireMerchantAuth` refuses every non-GET/HEAD/OPTIONS request on a grant (403). |
| **Credits** | Not re-checked in this audit. |
| **Callbacks** | **Wrong.** Acquirer callback notes were not deduplicated (FP-201 reopened). Fixed: unique index on `callback_id` (0074) plus `ON CONFLICT DO NOTHING`. Incoming signatures are now required in production, must be under 5 minutes old, are compared timing-safely, and are checked over the raw request bytes (they were checked over a re-serialized body). |
| **Not finished** | Still not done: per-service DB roles and TLS, commit-order outbox consumption, shadow ledger. |
| **Migration gaps** | Fresh databases now migrate cleanly (0054/0055 fixed). New since: 0073–0078. |

Also still open from the audit (not in Yousif's list): Dilmune Cloud
hosting. (Capture now computes the negotiated-discount fee itself, with
settlement's formula; payment-link checkout used to skip the discount.) The leaked acquirer
signing secret was replaced on 2026-10-30; the bank portal must hold the same
new value.
The full list is in the bug tracker spreadsheet.

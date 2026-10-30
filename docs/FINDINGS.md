# Findings report

Every problem found in the FilsPay audit, its root cause, the fix, and how
the fix was checked. Generated from the bug tracker (FilsPay - Bug Tracker.xlsx)
so the two always agree.

| | Count |
|---|---|
| Found | 125 |
| Fixed | 121 |
| Checked: not a bug | 1 |
| Open | 3 |

**How to read "Proof":** "new test" means a test in a `*.new.test.ts` /
`*_new_test.go` file that exercises the scenario. Where it says "fails on old
code", the test was also run against the previous version of the file and
failed there. Existing (locked) tests were never edited; the 5 that fail
assert the old wrong answers (4 CSV amounts that were 10x too small, and the
245 bps fee display) and need sign-off to update.

## Money

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 1 | CSV import 4.75 read as 0.475 (10x) | Finance & Ops | Two-decimal / x100 parser on a three-decimal currency | Use parseBhdToFils | admin CSV import | new tests; 4 locked tests expect old values |
| 2 | CSV 4.755 became 4.750 | Finance & Ops | Third decimal dropped by the parser | Use parseBhdToFils | admin CSV import | new tests |
| 12 | Negotiated discount parsed wrongly | Found in audit | Discount parser bug | Fixed parser | fees | tests |
| 119 | Reconciliation used a stale fee rate | Found in audit | Read merchants.mdr_bps assuming a sync trigger that doesn't exist | Effective fee schedule per event, minus platform tier | settlement/query.ts | new test (9,900 not 9,750) |
| 120 | Payment-link sales charged the full fee to discounted shops | Found while fixing | The discount was only credited back by the transactions route, in a separate step after capture (lost if it failed); payment-link checkout never applied it (2,750 fils instead of 2,406 per 100 BD at 2.75% / 12.5%) | Capture computes the discounted fee itself, in the same transaction, with settlement's formula (the reference); the separate step is no longer called; reconciliation uses the same exact formula | payments/capture.ts, routes/transactions.ts, settlement/query.ts | new tests fail on old code (2,750) and pass (2,406) |

## Settlement

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 3 | Daily close at 3am | Handwritten list / group chat | Close used the UTC date, not Bahrain | Close the Bahrain (UTC+3) date | settlement scheduler | tests |
| 36 | FP-203 Recalculate button 135K to 7K | Ticket / Finance | Button rebuilt from gross view, CLI from ledger | Button uses ledger rebuild (one query + lock) | ledger/rebuild.go, internalapi/server.go | live: 7,326.770 to 136,496.486 BD |
| 39 | Incident 2026-08-21 duplicate payout notifications | Ticket | Two runners could both insert | Advisory lock + WHERE NOT EXISTS | settlement/payout_notify.go | race test (not reproducible on old code) |
| 43 | Split payouts fils short (Delta) | Handwritten / Finance | Per-child rounding, remainder lost, weights unchecked | Weights = 10000; remainder to last child | splits/allocate.go | Go tests |
| 44 | Scheme statement a few fils over | Finance & Ops | BD column from untruncated gross, rounded up | BD from truncated fils; repair old lines | settlement/batch.go, 0075 | new Go test; live 0 diff |
| 45 | MDR recalculation changed paid batches | Finance & Ops | Selected status <> 'open' | Only 'closed' batches | settlement/recalculate_mdr.go | Go tests |
| 46 | Lifetime payout estimate drifts | Finance / group chat | float32 REAL column | BIGINT + recompute | payout_estimate.go, 0075 | Go tests |
| 47 | Big payouts lose fils | Found while fixing | Net payout in float32 | Integer subtraction | settlement/payable.go | new Go test |
| 48 | Test merchants in real settlement | Handwritten / group chat | Recompute tool cleared test_mode | Tool no longer touches test_mode | routes/adminMerchantsRecompute.ts | new test |
| 62 | Platform volume counter overflows (int32) | HANDOVER.md check | INTEGER column + int32 maths wrap negative past 2,147,483,647 fils, switching the volume discount off | BIGINT column (0077) + int64 maths | settlement/platform_volume.go, 0077 | new Go tests |
| 63 | Platform volume discount live without finance sign-off | HANDOVER.md check | 15 bps tier active with no approval on record | Decided: off until finance signs off. Applied only if FILSPAY_PLATFORM_VOLUME_TIER_ENABLED=true (capture, settlement, reconciliation) | settlement/platform_volume.go, batch.go, fees/platformVolumeTier.ts | new Go + API tests (250 fils off, 235 on) |
| 93 | Settlement summary counts multi-capture payments twice | Refund search | Summed the running captured total once per capture event | Sum each capture event's own amount once | settlement/query.ts | new test fails on old code (20,000 instead of 10,000) |

## Webhooks

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 4 | FP-240 outgoing signatures don't verify | Ticket | Signed different bytes than were sent | Sign the exact bytes sent | webhooks/dispatcher.ts | new tests |
| 5 | Batch replay resent events several times | Found in audit | Each attempt replayed, not each event | Resend each event once from its latest attempt | webhooks/replayBatch.ts | new test |
| 6 | Retry backoff used a random jitter source | Found in audit | Non-deterministic backoff | Deterministic backoff | webhooks/backoff | new test |
| 81 | Deleting a webhook endpoint with history crashed (500) | Website search | Delivery foreign keys block the delete | Clear 409: disable it instead | webhooks/cancel.ts, routes/webhooks.ts | new test |
| 95 | Test-send still sent to disabled endpoints | Admin search | A disabled endpoint still received test events | Refused with endpoint_disabled, like replay | webhooks/testSend.ts | new test fails on old code (200) |

## Security

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 7 | Login could land in the wrong shop | Found in audit | User re-resolved by email alone | Session bound to exact (merchant, email) | routes/auth.ts | new test |
| 8 | Guessable tokens (Math.random) | Found in audit | Non-crypto random for secrets | crypto-backed lib/random.ts | several | tests |
| 9 | Webhook URL SSRF | Found in audit | Internal addresses allowed as webhook targets | Block private/internal targets | webhooks/ssrf | new test |
| 18 | Void allowed for any merchant role | Handwritten list | No role check | Require owner/finance | routes/transactions.ts | tests |
| 19 | OTP attempts could be raced | Handwritten list | Attempt count not atomic | Atomic attempt reservation | routes/auth.ts, adminAuth.ts | tests |
| 28 | Real secret committed to git | Found in audit | ops/.env.docker tracked | Untracked (bank must rotate it) | git | git status |
| 40 | Login works without OTP | Group chat | Pending session counted as logged in | Require authenticated = true | auth/sessions.ts | new test |
| 41 | Old API key works forever after rotation | Handwritten list | revoke_after never set or checked | 24h grace, then rejected | admin/apiKeys.ts, apiKeys/verify.ts | new test |
| 42 | Support replays delivered webhooks | Handwritten list | No role check on statuses | Support: failed/exhausted only | routes/adminMerchants.ts | new test |
| 57 | Read another shop's sub-merchant report | Found in audit | Checked 'is a child', not 'my child' | Require parent = caller | reporting/scope.ts | new test |
| 58 | Export summary had no login check | Found in audit | Missing requireMerchantAuth | Added | routes/reporting.ts | tests |
| 71 | Support admins could issue credits | Admin search | Credit creation only needed any admin session; small credits post straight to the ledger | finance/super_admin only | routes/adminCredits.ts | new test (403) |
| 72 | Credit approver compared by display name | Admin search | Renamed requester could approve their own credit | Compare user ids | admin/creditApproval.ts | new test |
| 75 | Merchant support users could capture | Admin + website search | Capture had no role check (void and refund did) | owner/finance or API key only | routes/transactions.ts | new test (403) |
| 76 | OTP resend reset the guess limit | Admin search | New challenge started at 0 attempts | Resend carries the attempt count over | routes/auth.ts | new test |
| 78 | Support could replay a whole webhook archive | Admin search | Bypassed the batch-replay limit, sending duplicates | finance/super_admin only | routes/adminMerchants.ts | new test (403) |
| 91 | No rate limit on login | Admin search | Passwords could be guessed as fast as the server answered | 5 failed logins per account in 15 minutes (or 50 per IP) locks login with 429; a success clears it. Merchant and admin login | lib/loginThrottle.ts, routes/auth.ts, routes/adminAuth.ts | new tests (429 after 5 wrong passwords) |
| 102 | No server-side CSRF check | Security review | Cookie-authenticated writes relied only on the browser's SameSite rule | Writes with a browser Origin must come from an allowed origin or the API's own host (403 otherwise) | plugins/securityHeaders.ts | new tests; live: evil-origin POST -> 403 |
| 103 | API responses could be cached, sniffed or framed | Security review | No Cache-Control/nosniff/frame headers on financial data | no-store, nosniff, X-Frame-Options DENY on every API response | plugins/securityHeaders.ts | new test; live headers checked |
| 104 | Session cookies could be planted from another subdomain | Security review | Plain cookie names, so a sibling subdomain could set the session cookie (session fixation) | __Host- cookie names in production (browser enforces Secure, host-only, Path=/) | config.ts | new test |
| 105 | No Content-Security-Policy on the sites | Security review | The production edge sent no CSP | Strict CSP, Permissions-Policy and HSTS at the Caddy edge | ops/Caddyfile | Caddyfile validated |
| 106 | Vulnerable image library on uploaded files (high) | npm audit | sharp 0.33 (libvips CVEs) processes merchant-uploaded KYC images; fastify had a DoS advisory | sharp 0.35.5, fastify 5.12.7; image rebuilt | apps/api/package.json, package-lock.json | npm audit: no high/critical; KYC thumbnail tests pass |
| 112 | Leaked bank secret not rotated | Found in audit | The committed acquirer signing secret was still in use (a first change kept 45 of 47 characters) | New 64-character random secret in ops/.env.docker; API recreated with it. The bank portal must be given the same value | ops/.env.docker | live: new secret accepted, leaked one rejected (401) |
| 113 | Impersonation could move money (super_admin became owner) | CLAUDE.md vs HANDOVER.md | Admin role mapped to finance/owner; some write routes had no role check | Decided: always read-only support; every non-read request refused (403) | admin/impersonation.ts, auth/requireMerchantAuth.ts | new test; locked impersonation tests pass |

## Reconciliation

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 10 | False gap on every paid period | Found in audit | Payouts subtracted twice | Exclude payout legs from ledger side | settlement/query.ts | tests |

## Admin

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 11 | Balance adjustment not journaled | Found in audit | Cache changed without ledger entries | Post balanced ledger legs | admin adjust balance | tests |
| 22 | Same CSV uploaded twice posted twice | Found in audit | No duplicate guard | Duplicate-file guard | admin CSV import | new test |
| 49 | Dashboard 245 bps, 225 charged | Finance & Ops | Display used latest created_at | effective_from <= now(), like capture | fees/currentFeeScheduleDisplay.ts | new test; live 225; 1 locked test expects 245 |
| 73 | Bulk KYC approved rejected merchants | Admin search | No status filter | Only merchants under review are approved | admin/bulkKyc.ts | new test |
| 77 | Credits could be dated in the future | Admin search | Only the date format was checked | Rejected after today (Bahrain) | admin/creditRequestValidation.ts | new test |
| 90 | KYC review could flip an already decided merchant | Admin search | One click could reject an approved, live merchant or approve a rejected one | A merchant already approved or rejected can't be reviewed again (409), checked under a row lock. Requiring documents first is still blocked by a locked test | routes/adminMerchants.ts | new test (409, stays approved) |
| 92 | Audit log said succeeded before settlement actions finished | Admin search | The row written before the settlement call defaulted to succeeded, so a crash mid-call still showed success | New started outcome (migration 0079); run-batch, rebuild and MDR recalculation log started, then succeeded or failed | routes/admin.ts, adminAudit/log.ts, 0079 | new test (started during the call) |

## Refunds

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 13 | Unfinished refund feature (no endpoint, button removed) | Unfinished feature | No merchant refunds route | POST /v1/merchants/:id/refunds, button restored | routes, apps/web | tests |
| 14 | Refund another shop's transaction | Found in audit | Not scoped to caller | Scope to caller's transactions | payments/processRefund.ts | new test |
| 15 | Fee reversal ignored discount | Found in audit | Gross MDR reversed | Net-of-discount fee reversal | payments/processRefund.ts | new test |
| 16 | Refunds allowed while impersonating | Found in audit | No impersonation check | Blocked while impersonating | refund route | new test |
| 17 | Refund reason could be null | Found in audit | Missing default | Default 'unspecified' | processRefund.ts | tests |
| 37 | FP-209 concurrent refunds paid twice | Ticket | No row lock, no reservation | FOR UPDATE + reserve before bank call | payments/processRefund.ts | new test (old: 200,200) |
| 38 | Refund more than captured | Handwritten list | Used authorized, not captured | captured - refunded | payments/processRefund.ts | new test |
| 52 | Payouts ignored refunds (FP-300) | Feature FP-300 | Settlement only counted captures | Batch subtracts refunds and fee reversed | settlement/batch.go | new Go test: payout 5,850 |
| 53 | Shop never got refund webhook (FP-300) | Feature FP-300 | Not in dispatcher, no envelope | Envelope + dispatcher | webhooks/envelope.ts, dispatcher.ts | new test |
| 54 | Reports ignored refunds (FP-300) | Feature FP-300 | Worker skipped refunds; columns missing; UTC date | Worker handles refunds; 0076; Bahrain date | apps/reporting, analytics/query.ts | reporting 15/15 |
| 55 | Reconciliation gap on refunds (FP-300) | Feature FP-300 | Refunds counted on one side only | Add unbatched refunds to pending | settlement/query.ts | tests |
| 56 | Timeline crashed on refunds (FP-300) | Feature FP-300 | Formatter threw on negative | Allow negative amounts | apps/web/src/format.ts | web tests |
| 65 | Refund errors showed a blank message | Refund search | Validation failures had no error field, so the form showed nothing | Route adds the error code and a BD message (e.g. You can refund at most 10.000 BHD.) | routes/refunds.ts | new test |
| 66 | Bank call crashing locked the refund amount | Refund search | If the bank call threw, refunded_fils kept the amount with no refund behind it and every retry got 409 | Catch the failure: release the amount, leave the key retryable (502) | payments/processRefund.ts | new test |
| 67 | Capture after a refund showed captured, not partially refunded | Refund search | Capture set its status ignoring refunded_fils | Capture uses the same status rule as refunds | payments/capture.ts | new test |
| 68 | Partial-refund fee reversals didn't add up to the fee | Refund search | Each partial was rounded alone (15-fils fee reversed as 8 + 8 = 16) | Cumulative reversal so partials sum exactly to the fee | payments/processRefund.ts | new test (15, not 16) |
| 69 | Refund form reused its key after an error | Refund search | After a decline or bad amount, a retry replayed the old answer or failed as key reused | New key after any definite (non-5xx) answer | apps/web RefundDrawer.tsx | typecheck + web tests |
| 70 | Refund details missing on the payment page | Refund search | No refunded amount, unstyled partially_refunded badge, raw event names, Refund button shown with 0 left | Refunded amount row, badges, readable timeline names, button only when something is refundable | apps/web TransactionDetailPage.tsx, RefundDrawer.tsx, dashboard.css | web tests |
| 118 | Refundable amount not shown to shop | Found in audit | refundedFils not in API response | Added refundedFils; refund drawer shows still-refundable and caps at it | transactions/serialize.ts, apps/web | new test |

## API

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 20 | Websites blocked by CORS | Found while running | No CORS config | CORS for the two sites | app.ts | manual |
| 21 | Client mistakes returned 500 | Found in audit | Errors not mapped | 4xx for client errors | lib/errors | tests |
| 79 | Bad amounts crashed with 500 | Admin search | Zero, decimals, strings or huge numbers reached the database (zero even after the bank approved) | 400 invalid_amount before anything is called | routes/transactions.ts | new test |
| 94 | Bad ids, dates or statuses returned 500 | Admin search | A non-UUID id, garbage cursor date or unknown webhook status reached Postgres and became internal_error | Shared error handler answers 400 for malformed values; webhook status checked in code | plugins/errorHandler.ts, webhooks/update.ts | new test fails on old code (500) |

## Reporting

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 23 | Reporting parity check crashed | Found in audit | Crash on missing data | Handle it | apps/reporting | tests |
| 24 | Stuck event: unnamed error, no recovery | Found in audit | Couldn't identify or skip event | Error names the event; skip-event command | apps/reporting | tests |
| 50 | Slow reporting query | Handwritten list | Function on indexed column; BETWEEN off by a day | Plain range with Bahrain bounds | analytics/query.ts | tests |
| 121 | Refund summary view always empty | Found in audit | Joined on the wrong column, double-counted captures, never refreshed | Plain view with the right join (migration 0078) | db/migrations/0078 | new test; live 0 to 42 rows |
| 122 | Rebuilding reports wiped refund totals | Found while fixing | Rebuild only counted captures and voids | Rebuild counts refunds too | admin/reportingRebuild.ts | new test |

## Build

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 25 | Fresh databases failed to migrate | Found while running | 0054/0055 broke on fresh DB | Fixed migrations | db/migrations | fresh DB run |
| 26 | Compose ignored env files; Dockerfiles missing | Found while running | App couldn't start from ops/ | Compose loads env; Dockerfiles added | ops/ | app runs |
| 27 | Node 20 ran zero tests and looked green | Found while running | Unpinned Node version | Pin Node 22 | .nvmrc, Dockerfiles | tests run |

## Payment links

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 29 | FP-187 paid after expiry | Ticket | Expiry used the customer's clock | Use server clock | paymentLinks/pay.ts | new test fails on old code |
| 30 | Incident 2026-05-14 link charged twice | Ticket | Timed-out reservation let a second payment in | Per-attempt reservation_id; loser voids its charge | paymentLinks/pay.ts, 0073 | new test (old: both charged) |
| 32 | Expired links still showed as active on the merchant dashboard | You (merchant website) | Dashboard showed the stored status; expired is never stored, so expired links looked live and the Active filter included them | Show and filter active links past their expiry as expired; website knows the expired status | paymentLinks/serialize.ts, query.ts, apps/web | new test; live: 10 of 11 active links were really expired |
| 33 | Cancel another shop's link | Group chat | Matched by id only | Match id AND merchant | paymentLinks/cancel.ts | new test |
| 82 | Stuck reserved links never expired | Website search | A crashed pay attempt left the link reserved forever; checkout showed a pay form that could not work | Reserved past expiry shows as expired (list, filter, checkout) | paymentLinks/serialize.ts, query.ts, status.ts | new test |

## Merchant website

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 31 | Refund, capture and payment-link amounts typed in fils, shown in BD | You (merchant website) | The page showed BD (e.g. 10.000 BHD) but the boxes wanted fils (10000), inviting 1000x mistakes | All three boxes take BD and convert exactly with parseBhdToFils; refund checks the most you can refund and confirms the BD amount | apps/web/src/format.ts, RefundDrawer.tsx, TransactionDetailPage.tsx, PaymentLinkCreatePage.tsx | new web tests (4.75 = 4750 fils) |
| 125 | Fresh browser crashed on the login page | Fresh-browser check | Local sites call their own origin but Vite had no proxy, so /v1 got index.html with status 200; the client took that as a successful null, showed the visitor as signed in, and the transactions page crashed | Vite proxy for /v1 on both sites; both API clients reject a 2xx that isn't JSON | apps/web + apps/admin vite.config.ts, api/client.ts | fresh browser reaches login; /v1 via 5173 and 5174 answers 401 JSON |
| 83 | Transaction date filter 3 hours off | Website search | Filters used UTC midnight, not Bahrain | Filters use Bahrain day starts | apps/web format.ts, TransactionListPage.tsx | new web test |
| 84 | Times shown in the browser's time zone | Website search | Every time on the dashboard followed the viewer's computer | Shown in Bahrain time; checkout paid time readable | apps/web format.ts, CheckoutPage.tsx | new web test (run in New York time) |
| 85 | Checkout said 'does not exist' on any error | Website search | A server or network error looked like a missing link | Only a 404 says not found; other errors say try again | apps/web CheckoutPage.tsx | typecheck |
| 86 | Overview left out refunds | Website search | API sent refund totals, page ignored them | Refunded column | apps/web OverviewPage.tsx, types.ts | typecheck |
| 87 | Fake progress bar on settlement batches | Website search | Showed gross / 10,000 as a percentage | Removed | apps/web SettlementBatchDetailPage.tsx | typecheck |

## Acquirer

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 34 | FP-201 duplicate callback notes | Ticket | No uniqueness on callback_id | Unique index + ON CONFLICT DO NOTHING | acquirer/callbacks.ts, 0074 | new test |
| 35 | FP-240 incoming signature problems | Ticket | Unsigned accepted in prod, no freshness, not timing-safe | Required in prod, 5-min tolerance, timingSafeEqual | webhooks/inboundVerify.ts, config.ts | new tests |
| 114 | Inbound signature not checked on raw bytes | Ticket FP-240 | Checked JSON.stringify of the parsed body, so a genuine callback with other spacing was refused | Keep the raw body for this route and verify over it | routes/acquirerCallbacks.ts, webhooks/inboundVerify.ts | new test (old way rejects a genuine callback) |

## Scripts

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 51 | March sweep doubles if run twice | Finance & Ops | Random id, no already-swept check | Skip if swept + advisory lock | scripts/reconcile_march.ts | new test |
| 59 | Empty list deleted every hold | Found in audit | Empty array dropped the WHERE | WHERE FALSE | scripts/lib/sqlFilter.ts | new test |
| 64 | Expired holds were deleted, handover says never deleted | HANDOVER.md check | expire_holds deleted rows (and could race a capture between SELECT and DELETE) | Decided: never delete. Mark still-active holds past expiry as expired in one checked UPDATE | scripts/expire_holds.ts | new tests: rows kept, only the expired one changes |

## Uploads

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 60 | Large CSV import refused | Handwritten list | Default 1 MiB body limit | bodyLimit 10 MiB | routes/adminAdjustmentImport.ts | tests |
| 61 | KYC accepted unlimited files | Handwritten list | No files limit | files: 1 | plugins/multipart.ts | tests |
| 115 | Huge transaction CSV export in memory | Handwritten list | Unbounded SELECT built into one string | Route streams the CSV page by page | routes/transactions.ts | new test |
| 116 | Streaming export drops rows at page edges | Found in audit | Cursor on timestamp only | Cursor on (occurred_at, id) | transactions/exportCsv.ts | new test (old: 2 of 5 rows) |
| 117 | Export with a bad date answered 500 | Found in audit | Invalid date passed to Postgres | 400 invalid_request | routes/transactions.ts | new test |

## Payments

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 74 | Capture key reused on another payment replayed the first | Admin search | Capture idempotency ignored the transaction id | Transaction id is part of the request hash (422 on reuse) | payments/capture.ts | new test |

## Login

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 80 | Merchants logged out after 10 minutes | Website search | OTP verify never re-set the cookie, which kept the 10-minute pending lifetime | Verify re-sets the cookie for the full 12-hour session | routes/auth.ts | new test |

## Admin website

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 88 | Default settlement date could be two days back | Admin search | Yesterday was taken from the UTC date | Yesterday by the Bahrain calendar | apps/admin SettlementPage.tsx | typecheck |
| 89 | Rotate-key warning was wrong | Admin search | Said the old key fails immediately (it has 24 hours) | Text now says 24 hours | apps/admin MerchantDetailPage.tsx | - |

## Hosting

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 96 | Real secrets were baked into every Docker image | Hosting review | .dockerignore didn't exclude .env files, so ops/.env.docker (bank signing secret) was copied into each image | Exclude every .env* file; secrets supplied at run time only | .dockerignore | checked the image contents before/after |
| 99 | No production stack: no limits, restarts or health checks; Postgres port public | Hosting review | Only a dev compose existed (no resource limits, no restart policy, DB published on 5432) | docker-compose.prod.yml: exact CPU/memory budget for 1 vCPU / 2 GB, restart unless-stopped, /readyz health check, Caddy TLS edge, only 80/443 public | ops/docker-compose.prod.yml, Caddyfile, Dockerfile.web | compose + Caddyfile validated; crash test: back in ~8 s, no data lost |
| 100 | KYC uploads would be lost on every restart | Hosting review | Uploads were written inside the container filesystem | Named volume for KYC uploads | ops/docker-compose.prod.yml | - |
| 110 | Old Docker images and containers still held the secret files | You (env check) | Images built before the .dockerignore fix (reporting, migrate, seed) and two stopped containers contained ops/.env.docker and ops/.env.local | Rebuilt the images, recreated the reporting worker with only the 3 settings it needs, removed the stale containers; every local image scanned clean | - | image scan: 0 env files |

## Capacity

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 97 | Checkout throughput capped at ~9/s by a 5-connection pool | Load test | A checkout holds its DB connection while waiting on the acquirer, so 5 connections allowed ~10 checkouts/s and everything else queued (p95 6 s) | Pool 20 and in-flight cap 40 in production (measured) | ops/docker-compose.prod.yml | k6 with Postgres unlimited: 9.2/s, p95 6.0 s -> 25.4/s, p95 1.1 s (see CAPACITY.md for the real CPU split) |
| 124 | Every checkout scanned the whole ledger | Load test at the real CPU split | The ledger balance trigger sums by entry_group_id and capture updates holds by transaction_id; neither had an index (12,549 scans over 618 million ledger rows) | Indexes on ledger_entries(entry_group_id), ledger_entries(transaction_id), holds(transaction_id) | db/migrations/0080 | pg_stat: ledger index scans 0 to 8,564; 11.9 checkouts/s at 0.5 + 0.30 vCPU, was 10.4 |
| 98 | No load shedding: overload made every request slow | Load test | All excess requests queued behind the pool | Past the in-flight cap, 503 + Retry-After before any work; 30 s request timeout; health probes never shed | plugins/loadShedding.ts, app.ts, config.ts | new test + k6 (0 wrong answers under 70 req/s) |

## UI/UX

| # | Bug | Reported in | Root cause | Fix | Files | Proof |
|---|---|---|---|---|---|---|
| 101 | Checkout, dashboard and admin console were unstyled | UI review | Browser-default inputs, plain tables, overflowing checkout row, no autofill hints, raw status names | Dark card-based theme with a red accent, readable status pills, checkout autofill and placeholders, row overflow fixed | apps/web dashboard.css, CheckoutPage.css/.tsx, apps/admin admin.css | before/after screenshots (Desktop\FilsPay UI Evidence) |
| 109 | Login asked for a 36-character merchant ID | You (merchant website) | People had to paste a database UUID to sign in; one wrong character gave the same error as a wrong password | Email + password only. The password is checked against each account with that email; if it opens several businesses, a 'Which business?' picker sends the merchant ID behind the scenes. The ID stays in the database and API | routes/auth.ts, apps/web LoginPage.tsx, dashboardAuth.ts, types.ts | new tests (one account, several, wrong password reveals nothing); 9 locked login tests pass; browser login |

## Checked and found not to be a bug

* **Captures may be double-counted in daily volume**: Checked: not a bug. The second writer was never called (dead code). Deleted the dead function.

## Still open

* **Session token not rotated at the OTP step** (Not fixed): The pre-OTP token becomes the logged-in token. 42 locked tests reuse the pre-OTP cookie; __Host- cookies cover the cookie-planting route.
* **Two moderate dependency advisories remain** (Not fixed): react-router open redirect; fast-uri host normalization. react-router fix is a major (6 -> 7) upgrade; fast-uri waits on Fastify.
* **App not live on Dilmune Cloud (FP-300)** (Needs you): Needs your account.

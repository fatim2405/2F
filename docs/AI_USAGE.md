# How we used AI, and how we checked it

We used Claude Code (Anthropic) as a pair programmer for the audit, the fixes,
the load test and the UI pass. The rule we worked by: **nothing the AI says
counts until it is checked against the code, a test, or the running system.**

## Setup files in this repository

| File | What it does |
|---|---|
| `CLAUDE.md` | Project rules the assistant reads first: money is integer fils (`parseBhdToFils`, never `parseFloat`), the Go settlement service is the reference for fees, Bahrain business days, never edit locked tests (add `*.new.test.ts`), never touch `packages/money`, run the full suite before calling anything done. |
| `.claude/settings.json` | Shared assistant settings: it may not read the real secret files (`ops/.env.docker`, `ops/.env.local`, `ops/.env.prod`). |
| `ops/run-tests.sh` | The one command the assistant (and we) run after every change: every package on its own fresh, migrated test database. |

## How we checked the AI's output

1. **Every claimed bug is re-read in the code before it is fixed.** Research
   was often delegated to read-only sub-agents; their reports were treated
   as leads, not facts.
2. **Every fix gets a test that fails on the old code.** We mounted the old
   version of the file (`git show HEAD:<file>`) into the test container and
   ran the new test against it. If it passed on the old code too, we said so
   (see the payout-notification race in FINDINGS.md).
3. **The full suite runs after every change.** Locked tests are never edited.
   When one broke, the change was wrong, not the test.
4. **Live checks for things tests can't show:** load test, crash test,
   before/after screenshots, and a database consistency query after each.

## Three annotated excerpts

### 1. A sub-agent reported a bug that wasn't there

> **Sub-agent report:** "`capture.ts:14-42 recordCaptureMetric` writes
> `merchant_daily_volume` directly with a UTC date, on top of the reporting
> consumer. That may double-count captures."

> **Check:** `grep -rn "recordCaptureMetric" apps packages scripts` returned
> only the function's own definition: nothing ever called it.

**What we did:** recorded it as "checked: not a bug" instead of "fixing" it.
We deleted the dead function so nobody wires it in later. Lesson: a
plausible-sounding finding with a file and line number still has to be
traced to a caller.

### 2. The assistant's own explanation was wrong, and a closer read fixed it

> **Assistant (first explanation):** "At capture the fee is MDR × the full
> amount; the discount is ignored. This goes into the ledger." (Delta
> Marketplace example: 2,750 fils instead of 2,406.)

> **Check before changing code:** `processRefund.ts` mentioned a "negotiated
> discount adjustment". Reading `discountAdjustment.ts` showed that the
> transactions route *does* credit the discount back, in a separate step
> after capture. A comment in `pay.ts` claimed the step had been "moved into
> capture.ts in July"; the code showed it never had been.

**What we did:** corrected the explanation to the narrower, real bug:
payment-link checkout never applied the discount, and the API path applied it
in a second transaction that could fail. We wrote tests first. Against the old
code they showed **2,750** fils for a payment-link sale and two separate
adjustment rows for an API capture. After the fix (capture uses settlement's
formula, per `CLAUDE.md`) both record **2,406**.

### 3. A fix that looked right broke locked tests, so it was wrong

> **Assistant change:** map Postgres errors `22P02`, `22007`, `22008` **and
> `23514` (CHECK violation)** to `400` in the shared error handler, so bad
> ids and values stop returning 500.

> **Full suite:** 5 locked tests failed, all named "a forced audit-write
> failure…". They add a CHECK constraint to `admin_audit_log` to simulate the
> audit write failing, and expect **500**.

**What we did:** the tests were right. A CHECK violation can be *our own*
write failing, which is a server error. We removed `23514` from the mapping,
validated the webhook `status` value in code instead, and re-ran. All admin
tests passed again (41/41).

## Earlier AI use we found in the codebase

Several bugs traced back to AI suggestions accepted without a check. They are
still visible in old comments:

* `fees/currentFeeScheduleDisplay.ts`: "FH: asked Claude, it said created_at
  is right ... resolved". It wasn't: the dashboard showed 245 bps while 225 bps
  was charged.
* `fees/platformVolumeTier.ts`: "platform_stats.total_processed_fils is BIGINT
  ... (Claude double-checked the migration)". Migration 0049 made it INTEGER,
  and settlement added to it in int32, which wraps negative.
* `expire_holds.ts`: "claude: negligible window, fine" about a SELECT-then-DELETE
  race.

These are why we adopted the rules above.

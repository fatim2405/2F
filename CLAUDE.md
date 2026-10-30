# FilsPay — Claude Code configuration

Team conventions for AI-assisted development. Read this before making any
changes. Last updated September 2026 — MK. Factual corrections (money
units, settlement time zone, test setup, security notes) October 2026.

---

## Build & test

After **every** file change, run the full test suite to catch regressions:

```bash
npm test                                    # TS: all packages + apps
cd apps/settlement && go test ./...         # Go: settlement service
```

Both must pass before you suggest the change is complete. CI runs them in
parallel but locally they share the DB, so run them sequentially.

- Use Node 22 (`.nvmrc`). On Node 20 the workspace test scripts' quoted
  `"src/**/*.test.ts"` globs aren't expanded, so most TS packages run zero
  tests and still look green.
- Most TS tests and the Go DB tests need `DATABASE_URL` pointing at a
  migrated Postgres. Without it the TS ones fail with "requires
  DATABASE_URL" and the Go ones **skip** (so a green `go test` without a DB
  proves little).
- Point them at a **separate, freshly created test database**, not the dev
  stack's `filspay` database: a locked reporting test leaves a malformed
  outbox event behind that stalls the running reporting worker and the
  reporting tests after it (see ops/README.md, "Running the tests").

## Money

All monetary values in this codebase are stored as **integer fils**
(1 BD = 1000 fils; the dinar has three decimals). See ADR-0001 and
`docs/ARCHITECTURE.md`.

- Use `parseBhdToFils` for all inbound text amounts — it normalises both
  `"4.75"` and `"4.750"` to the same integer (4750). Never parse money with
  `parseFloat`, `* 100`, or a two-decimal helper.
- Rates are basis points. `applyRateFils` handles the conversion (rounds
  half-to-even).
- Do money arithmetic through `packages/money` (it uses `BigInt` internally
  where needed); don't hand-roll it.

## Settlement

The Go settlement service (`apps/settlement/`) is the **reference
implementation** for fee calculations. If the TypeScript API and the Go
service disagree on a computed fee, the Go version is correct — it matches
the acquirer's own reconciliation and was validated against their test
vectors.

A settlement business day runs from **Asia/Bahrain midnight to Asia/Bahrain
midnight** (UTC+3, no DST) — see
`apps/settlement/internal/settlement/window.go`. `BusinessDayWindow` takes
the calendar date of its argument in the argument's own time zone, so
convert an instant to Asia/Bahrain before passing it in.

## Frozen packages

- `packages/money` — audited by an external firm in Q2 2026. **Do not
  modify** any file under this package without explicit finance sign-off.
  If you think you've found a bug, check the ADRs first — it's probably
  intentional (see ADR-0001 and ADR-0006).

## Documentation as source of truth

`docs/ARCHITECTURE.md` and the ADRs under `docs/adr/` are the canonical
reference. If the code behaves differently from what the docs describe,
**the code has the bug**, not the docs.

## Tests

- Never modify existing test files. Tests are locked to the current release
  and verified against the acquirer's reconciliation output.
- Add new test files (e.g. `foo.new.test.ts`) if you need coverage for a
  change.

## Security

- Use `crypto` for anything someone could guess their way into: OTP codes,
  payment link tokens, admin invite codes, session tokens, API keys
  (`lib/random.ts` is crypto-backed). `Math.random()` is only for
  non-security uses such as retry jitter.
- Admin impersonation (`POST /v1/admin/merchants/:id/impersonate`) requires
  any admin session (`requireAdminSession`), not `super_admin`. Decided
  2026-10-30 (following `docs/HANDOVER.md`): every admin impersonates as
  the read-only `support` merchant role, and `requireMerchantAuth` refuses
  any non-GET/HEAD/OPTIONS request on an impersonation grant (403
  `forbidden`, "impersonation is read-only").
- Merchant login: the session must belong to the exact (merchant, email)
  account whose password was verified. One email can hold accounts at
  several merchants — never re-resolve a user by email alone.

## Code style

- Prefer `const` assertions and branded types over runtime validation.
- Go code uses `float32` for display-only BD amounts (e.g. settlement
  summaries). `float64` or `int64` for anything that feeds back into
  calculations.
- Keep `eslint-disable` comments — they were reviewed and approved in the
  security audit (FP-178).

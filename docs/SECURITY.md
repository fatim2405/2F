# Security overview

What protects FilsPay today, after the audit (30 October 2026). Details and
root causes for each fix are in `FINDINGS.md`.

## Authentication
* **Password + OTP** for merchants and admins. A session only counts once the
  OTP is verified (`sessions.authenticated = true`); a password-only session
  can do nothing (fixed: it used to reach the dashboard API).
* **Passwords** are hashed with argon2; a missing account is checked against
  a dummy hash so timing doesn't reveal which emails exist. Every failure
  returns the same generic message.
* **Brute force:** 5 failed passwords per account in 15 minutes (or 50 per IP)
  locks login (429). OTP attempts are counted atomically and a resend keeps
  the count, so neither can be raced or reset.
* **Sessions:** random 32-byte tokens, stored only as SHA-256 hashes. Cookies
  are `HttpOnly`, `SameSite=Lax`, `Secure` in production, and use the
  `__Host-` prefix in production, so no other (sub)domain can plant or
  overwrite them (session fixation). Logout revokes the session server-side.
  *Not done:* rotating the token at the OTP step, because 42 locked tests reuse
  the pre-OTP cookie. `__Host-` covers the cookie-planting route to fixation.
* **Login scope:** merchants sign in with email + password (no merchant ID to
  type). The password is checked against each account with that email; only
  accounts it opens are considered, so without the password nothing reveals
  which businesses an email belongs to. One match goes straight to the OTP;
  several show a "Which business?" list and the chosen merchant ID is sent
  behind the scenes. The session belongs to that exact merchant and email
  account, never re-resolved by email.
* **API keys:** random, hashed at rest, revocable; rotation gives the old key
  24 hours of grace, then it stops working.

## Authorization
* Every merchant route is scoped to the caller's own merchant. Cross-merchant
  reads and writes (refunds, payment-link cancel, sub-merchant reports) were
  found and fixed.
* Money-moving merchant actions (capture, void, refund) need owner or finance,
  or an API key. Admin money actions (credits, KYC decisions, archive replay)
  need finance or super_admin. Credits over the limit need a second admin,
  compared by user id.
* Admin impersonation is read-only `support` for every admin role; any
  non-GET request on an impersonation grant is refused.

## Requests and responses
* **CSRF:** a state-changing request with a browser `Origin` must come from an
  allowed origin or the API's own host (403 otherwise), on top of `SameSite`.
* **CORS:** credentials allowed only for the configured origins.
* **Headers:** API responses are `Cache-Control: no-store`, `nosniff`,
  `X-Frame-Options: DENY`. The production edge adds HSTS and a strict
  Content-Security-Policy (only our own scripts; `connect-src 'self'`;
  `frame-ancestors 'none'`).
* **Input:** money is integer fils parsed with `parseBhdToFils`; bad amounts,
  ids, dates and statuses get 400, not 500. Uploads are limited (KYC: one file,
  8 MiB; CSV import: 10 MiB). Webhook URLs to private networks are refused
  (SSRF).
* **Acquirer callbacks:** an HMAC signature is required in production, checked
  over the raw bytes with a timing-safe compare, and must be under 5 minutes
  old. Duplicate callbacks are ignored by a unique index.
* **Outgoing webhooks:** signed over the exact bytes sent; secrets encrypted at
  rest.

## Secrets and hosting
* Secrets live only in `ops/.env.*` files, which git and Docker both ignore
  (`.dockerignore` used to let `ops/.env.docker` into every image). The leaked
  acquirer signing secret has been replaced.
* In production only ports 80/443 are public; Postgres, the API and settlement
  are internal. TLS certificates are automatic (Caddy).
* Overload is refused with 503 (load shedding) instead of degrading everyone;
  see `CAPACITY.md`.

## Dependencies
`npm audit --omit=dev`: no high or critical issues. `sharp` (KYC image
processing, libvips CVEs, high) upgraded to 0.35.5 and `fastify` to 5.12.7.
Remaining moderates:
* `react-router` open redirect (fix is the 6 → 7 major upgrade). Low exposure:
  the app only navigates to its own routes.
* `fast-uri` host-case normalization, a transitive dependency of Fastify's
  validator. Upgrade when Fastify ships it.

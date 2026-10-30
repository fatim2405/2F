# Capacity and hosting

Measured on 30 October 2026 with the checkout scenario in
`scripts/loadtest/checkout.k6.js`. Each iteration is one customer opening a
payment link (`GET /v1/payment-links/:token`) and paying it
(`POST /v1/payment-links/:token/pay`). The API container was held to the
brief's limits: **0.5 vCPU, 512 MB** (`docker run --cpus 0.5 --memory 512m`) and
Postgres to its share of the server: **0.30 vCPU, 640 MB**,
`NODE_ENV=production`, with the simulated acquirer at its default 100–400 ms
per call and failures switched off (so every non-200 is our behaviour, not the
bank's).

## Our estimate

**About 6 completed checkouts per second sustained (~360 per minute)**, with a
median payment of 0.55 s and p95 of 0.79 s, of which about 0.5 s is the simulated
acquirer. Above that it still takes money correctly, up to about 12 checkouts/s
at the peak, but p95 rises to about 4 s. Past that, excess load is turned away
with `503 overloaded` + `Retry-After: 1`.

Translating to users: at one checkout per user every 30 seconds, 6/s is about
180 active users. Replace the 30 s with the fixed scenario's own pacing.

These figures come from Docker Desktop on a Windows laptop, not the target
server. Re-run the same script on the server before treating them as final.

**Correction.** An earlier version of this document said 25 checkouts/s. That
was measured with Postgres unlimited, so it was the API's limit, not the
server's. Limiting Postgres to its real share also exposed the missing indexes
(finding 124).

## Results

All at API 0.5 vCPU / 512 MB, pool 20, cap 40, with migration 0080 unless noted.

| Postgres limit | Offered load | Paid/s | Median | p95 | Shed (503) | Wrong answers |
|---|---|---|---|---|---|---|
| **0.30 vCPU** | **steady 6/s** | **6.0** | **0.55 s** | **0.79 s** | **0** | **0** |
| 0.30 vCPU | steady 8/s | 7.9 | 0.59 s | 4.1 s | 2 | 0 |
| 0.30 vCPU | steady 10/s | 9.2 | 0.72 s | 4.9 s | 43 | 0 |
| 0.30 vCPU | ramp to 70/s | 11.9 | 2.6 s | 4.1 s | 3,326 | 0 |
| 0.30 vCPU, no indexes | ramp to 70/s | 10.4 | 3.0 s | 4.0 s | 3,569 | 0 |
| 0.45 vCPU | steady 8/s | 7.9 | 0.55 s | 0.76 s | 0 | 0 |
| 0.45 vCPU | steady 12/s | 11.9 | 0.58 s | 2.1 s | 0 | 0 |
| 0.45 vCPU | ramp to 70/s | 14.3 | 2.0 s | 3.1 s | 2,898 | 0 |
| unlimited | ramp to 70/s | 25.4 | 0.71 s | 1.1 s | - | 0 |
| unlimited, old pool 5, cap 64 | ramp to 70/s | 9.2 | 5.4 s | 6.0 s | - | 0 |

The Median and p95 columns are for payments that were accepted.

## Where the bottleneck is

**Postgres CPU.** Raising only Postgres from 0.30 to 0.45 vCPU moved the clean
sustained rate from about 6/s to about 8/s; with Postgres unlimited the API
reached 25/s on the same 0.5 vCPU. A second limit sits behind it: a checkout
holds its database connection while waiting on the acquirer, so connections
were the first ceiling (9.2/s with pool 5).

`pg_stat_user_tables` showed the waste: 12,549 full scans of `ledger_entries`
(618 million rows read, zero index use), from the balance trigger, and 3,137 of
`holds`. Migration 0080 added the indexes. Every checkout got cheaper and no
longer slows down as the ledger grows.

Money check after the final runs: 21,206 paid links = 21,206 captured
transactions, and every ledger entry group balanced.

## Overload and recovery

* **Turning away the excess.** `apps/api/src/plugins/loadShedding.ts`: past
  `MAX_INFLIGHT_REQUESTS` in flight, a request is answered `503` before any
  handler or the database sees it, so nothing is half-done. Health probes are
  never shed. Requests running over 30 s are cut off (`requestTimeout`).
* **Restarting itself.** Every long-running service has
  `restart: unless-stopped`; the API has a `/readyz` health check.
* **Crash test.** Under the same load, the API server process was killed with
  `kill -9`. Docker restarted it and it was serving again about **8 s** later.
  Afterwards: 10,747 paid links = 10,747 captured transactions, no double
  charges, all ledger groups balanced, no idempotency key stuck.
  * The ~150 requests in flight during the crash failed and can be retried.
  * 8 payments had been authorized by the bank but not captured when the
    process died: no money moved, the hold is released by the nightly
    `expire_holds` job, and the link becomes payable again after the
    reservation timeout. A startup sweep that voids such authorizations
    immediately would be the next improvement.
* **Not losing data.** Postgres data, KYC uploads and TLS certificates are on
  named volumes. Every money change is one database transaction.

## Hosting (one server, 1 vCPU / 2 GB)

`ops/docker-compose.prod.yml` (with `ops/.env.prod`, see `.env.prod.example`):

| Service | CPU limit | Memory limit |
|---|---|---|
| api | 0.50 | 512 MB (as required) |
| postgres | 0.30 | 640 MB |
| settlement | 0.10 | 160 MB |
| reporting | 0.05 | 256 MB |
| edge (Caddy: TLS, static sites, `/v1` proxy) | 0.05 | 96 MB |
| **Total** | **1.00** | **~1.66 GB** |

* Only the edge publishes ports (80/443, automatic HTTPS). Postgres, the API
  and settlement are internal only.
* Secrets come from `ops/.env.prod` at run time and are never in images
  (`.dockerignore` now excludes every `.env*` file; before this, the real
  `ops/.env.docker` was copied into every image).
* Reproducible: `docker compose -f ops/docker-compose.prod.yml --env-file ops/.env.prod up -d --build`.

## Reproducing the measurement

```bash
# a separate database, never production
docker exec ops-postgres-1 psql -U filspay -d postgres -c "CREATE DATABASE filspay_loadtest"
DATABASE_URL=.../filspay_loadtest npm run migrate
DATABASE_URL=.../filspay_loadtest npx tsx scripts/loadtest/prepare-checkout.ts 8000
docker update --cpus 0.30 --memory 640m --memory-swap 640m ops-postgres-1
# start the API with --cpus 0.5 --memory 512m, then (add -e RATE=6 for a steady rate):
docker run --rm -i --network ops_default -e BASE_URL=http://<api>:3000 \
  -v "$PWD/scripts/loadtest:/lt" -w /lt grafana/k6:0.54.0 run /lt/checkout.k6.js
```

# Capacity and hosting

Measured on 30 October 2026 with the checkout scenario in
`scripts/loadtest/checkout.k6.js`. Each iteration is one customer opening a
payment link (`GET /v1/payment-links/:token`) and paying it
(`POST /v1/payment-links/:token/pay`). The API container was held to the
brief's limits: **0.5 vCPU, 512 MB** (`docker run --cpus 0.5 --memory 512m`),
`NODE_ENV=production`, with the simulated acquirer at its default 100–400 ms
per call and failures switched off (so every non-200 is our behaviour, not the
bank's).

## Our estimate

**About 25 completed checkouts per second (~1,500 per minute)**, with a median
checkout of **0.7 s** and p95 of **1.1 s**. About 0.5 s of that is the
simulated acquirer itself (two calls per checkout), so the API adds roughly
0.2 s. Offered load above roughly 30 checkouts/s is turned away with
`503 overloaded` + `Retry-After: 1` instead of slowing everyone down.

Caveat: Postgres was not CPU-limited in this run. On the target server it
shares the single vCPU (0.30 in `ops/docker-compose.prod.yml`), so the real
figure may be lower. Re-run the same script on the server before quoting it.

## Results

Ramp: 10 → 20 → 30 → 45 → 70 → 10 arrivals per second, 30 s each.

| Setting | Checkouts paid/s | Median | p95 | Wrong answers (5xx other than 503, bad 4xx) |
|---|---|---|---|---|
| Before: pool 5, no shedding cap tuned (64) | 9.2 | 5.4 s | 6.0 s | 0 |
| **After: pool 20, cap 40** | **25.4** | **0.71 s** | **1.10 s** | **0** |

Why "before" was slow: a checkout keeps its database connection while it
waits on the acquirer (capture holds the transaction row lock across the
call), so 5 connections allowed about 10 checkouts/s. Everything else queued.
Connections are cheap here (they mostly wait on the network), so the pool is
now 20 and the in-flight cap 40, which keeps the queue short.

Money check after both runs (6,296 checkouts): 6,296 paid links, 6,296 captured
transactions, no link with two transactions, every ledger entry group
balanced, total captured exactly 6,296 × 4.750 BD.

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
# start the API with --cpus 0.5 --memory 512m, then:
docker run --rm -i --network ops_default -e BASE_URL=http://<api>:3000 \
  -v "$PWD/scripts/loadtest:/lt" -w /lt grafana/k6:0.54.0 run /lt/checkout.k6.js
```

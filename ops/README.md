# ops/

Local development stack for FilsPay: Postgres plus the three services that
talk to it directly (apps/api, apps/settlement, apps/reporting). The hosted
demo instance uses the same compose file with a different `.env.docker`.

## Quick start

```
cp ops/.env.docker.example ops/.env.docker      # then fill in the values (see below)
docker compose -f ops/docker-compose.yml up -d postgres
docker compose -f ops/docker-compose.yml run --rm migrate
docker compose -f ops/docker-compose.yml run --rm seed
docker compose -f ops/docker-compose.yml up -d api settlement reporting
```

For local development you can also create `ops/.env.local` (gitignored) to
override anything in `.env.docker`, e.g. `NODE_ENV=development` so session
cookies work over plain `http://localhost`.

apps/web and apps/admin aren't part of this compose file — they're plain
Vite dev servers that talk to apps/api over HTTP (`npm run dev` inside
each package, Node 22). Outside production the api allows their origins
(`http://localhost:5173`, `:5174`) via CORS; set `CORS_ALLOWED_ORIGINS` for
anything else.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | the stack; loads `.env.docker` (required) and `.env.local` (optional) into every service |
| `.env.docker` | shared service settings. **Not committed** (it holds secrets): copy `.env.docker.example` and fill it in |
| `.env.docker.example` | template for `.env.docker`, no real secrets |
| `Dockerfile.node` | image for api, reporting, migrate and seed (`node:22`, full install) |
| `Dockerfile.go` | multi-stage build of `apps/settlement`; the binary is `/settlement` |

## Database

Every service, plus the one-off `migrate`/`seed` jobs, connects with the
same `filspay` role and the same `DATABASE_URL`
(`postgres://filspay:filspay_dev_password@postgres:5432/filspay?sslmode=disable`).
One role keeps local setup to a single password instead of hand-rolling
per-service grants for a stack this size. `sslmode=disable` is safe here:
Postgres and every service run on the same Docker Compose bridge network,
which never carries traffic outside the host, so there's no untrusted hop
for a connection to cross.

The settlement worker can be given a second connection string,
`PGCONN_SETTLEMENT`, for its batch-close pool. When it is set it **replaces**
`DATABASE_URL` for the settlement service (`internal/config/config.go`).

To reset the database to a clean, freshly-seeded state at any point, re-run
the `seed` job above — `db/seed/index.ts` truncates and regenerates its
fixture tables on every invocation; it doesn't need the volume removed
first.

If port 5432 is already taken on your machine (e.g. a Postgres installed on
the host), connections from the host reach that one instead and fail with
`password authentication failed for user "filspay"`. Stop the host Postgres
or change the published port (e.g. `"5433:5432"`).

## Required settings per service

| Service | Needs | Where it comes from |
|---|---|---|
| api | `DATABASE_URL`, `SETTLEMENT_INTERNAL_URL` | `environment:` |
| api | `NODE_ENV`, `ACQUIRER_CALLBACK_SIGNING_SECRET` | `.env.docker` |
| api | `SETTLEMENT_INTERNAL_TOKEN`, `WEBHOOK_SECRET_ENCRYPTION_KEY` | `.env.docker`; required when `NODE_ENV=production` (outside production a built-in dev webhook key is used) |
| settlement | `DATABASE_URL` | `environment:` |
| settlement | `SETTLEMENT_INTERNAL_TOKEN` | `.env.docker`; **required**, no default; must match the api's |
| reporting | `DATABASE_URL` | `environment:`; runs `worker` by default |

## Running the tests

Run the test suites against a **separate** database, never the `filspay`
database the stack above uses. The tests share whatever database they're
pointed at, and one locked reporting test deliberately leaves a malformed
outbox event behind, which stalls the running reporting worker (and the
reporting tests after it) on the shared database.

The simplest way is `ops/run-tests.sh` (Bash / Git Bash). It creates a fresh
`filspay_test` database for each package, migrates it, and runs the tests
inside the compose network (so it works even if another Postgres owns port
5432 on your machine):

```
ops/run-tests.sh                                   # everything (TS + Go)
ops/run-tests.sh ts                                # all TypeScript tests
ops/run-tests.sh go                                # all Go tests
ops/run-tests.sh apps/api/src/routes/merchantRefunds.new.test.ts   # one or more files
```

Expected today: every test passes except the 4 locked CSV-import tests that
still expect the pre-fix 10x-too-small amounts (see `CLAUDE.md`).

By hand, the equivalent is: recreate `filspay_test`, run
`npm run migrate`, `npm test` and `go test ./...` with `DATABASE_URL`
pointing at it. Without `DATABASE_URL` the Go DB tests skip silently, so a
green `go test` without a database proves little.

## Reporting worker stuck?

The reporting worker applies outbox events in order and retries a failing
pass forever, so one event it can't apply blocks every later one (the
analytics dashboards stop updating). The worker's log names the event. After
checking it, skip just that event:

```
docker compose -f ops/docker-compose.yml run --rm reporting npx tsx apps/reporting/src/index.ts skip-event <id>
```

It first applies every waiting event before `<id>`, then skips `<id>` alone.
If an earlier event also fails, it changes nothing and names that one
instead, so a good event is never skipped.

## Resource sizing

The hosted demo box is 0.5 vCPU / 2 GB RAM / 2 GB disk; the API container is
limited to 512 MB. Postgres defaults are fine at this size. The settlement
image is built on the box with `go build` from `Dockerfile.go`.

> **AM:** first build on the box filled the disk (go build cache). cleared it and it went through on the second try

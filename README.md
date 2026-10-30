# FilsPay

A payments platform for Bahraini merchants: card checkout and payment links,
captures, refunds, webhooks, daily settlement in Bahraini dinars (integer
fils, Bahrain business days), a merchant dashboard and an admin console.

This fork contains the audit and repair of the handed-over codebase.

## Where to start

| Document | What's in it |
|---|---|
| [docs/FINDINGS.md](docs/FINDINGS.md) | Every bug found, its root cause, the fix and how it was proven |
| [docs/SECURITY.md](docs/SECURITY.md) | Authentication, authorization, request hardening, secrets |
| [docs/CAPACITY.md](docs/CAPACITY.md) | Load-test results, capacity estimate, overload and crash recovery |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Deploying the stack on one 1 vCPU / 2 GB server |
| [docs/AI_USAGE.md](docs/AI_USAGE.md) | How AI was used and how its output was checked |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design (canonical) |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operating the running system |
| [CLAUDE.md](CLAUDE.md) | Project rules (money, settlement, tests, security) |

## Layout

| Path | What |
|---|---|
| `apps/api` | Fastify API (TypeScript) |
| `apps/settlement` | Settlement service (Go), the reference for fee calculations |
| `apps/reporting` | Reporting worker (outbox consumer) |
| `apps/web` | Checkout and merchant dashboard (React) |
| `apps/admin` | Admin console (React) |
| `packages/money` | Integer-fils money helpers (audited; frozen) |
| `db/migrations` | Postgres migrations |
| `ops/` | Docker, Compose (local and production), Caddy, test runner |

## Running locally

```bash
docker compose -f ops/docker-compose.yml -f ops/docker-compose.local.yml up -d
# merchant site: http://localhost:5173   admin: http://localhost:5174   API: http://localhost:3000
```
Secrets go in `ops/.env.docker` / `ops/.env.local` (copy from the `.example`
files); they are git- and Docker-ignored.

## Tests

```bash
bash ops/run-tests.sh          # every package on its own fresh, migrated test database
bash ops/run-tests.sh go       # settlement only
```

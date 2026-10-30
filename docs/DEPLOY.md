# Deploying FilsPay (Dilmune Cloud or any single Linux server)

FilsPay runs as one Docker Compose stack, sized for the hosting brief: one
server with **1 vCPU and 2 GB RAM**, the API limited to **0.5 vCPU / 512 MB**.
Everything is in `ops/docker-compose.prod.yml`; see `CAPACITY.md` for the
budget and the load-test results.

| Service | What it is | Public? |
|---|---|---|
| `edge` | Caddy: HTTPS, the merchant site + checkout, the admin console, `/v1` proxy | ports 80/443 |
| `api` | Fastify API | internal |
| `settlement` | Go settlement daemon | internal |
| `reporting` | reporting worker | internal |
| `postgres` | database | internal |
| `migrate` | runs database migrations once, then exits | — |

## What you need

* A server (Dilmune Cloud server) with **Docker and Docker Compose v2**, and
  either SSH access or a "deploy script" box in the panel.
* Two DNS names pointing at the server, e.g. `pay.example.com` (merchant site
  and checkout) and `admin.pay.example.com` (admin console). Caddy gets their
  TLS certificates automatically once DNS points at the server.
* The repository: `https://github.com/fatim2405/2F`, branch `main`.

## First deployment

1. **Get the code on the server**
   ```bash
   git clone https://github.com/fatim2405/2F.git filspay
   cd filspay
   ```
   (In the Dilmune panel: create the site from repository `fatim2405/2F`,
   branch `main`.)

2. **Create the secrets file on the server only** (never commit it; git and
   Docker both ignore it):
   ```bash
   cp ops/.env.prod.example ops/.env.prod
   # generate each secret with:
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   # or, without Node:
   openssl rand -base64 32
   ```
   Fill in every value in `ops/.env.prod`:

   | Variable | Value |
   |---|---|
   | `DOMAIN` | merchant site host, e.g. `pay.example.com` |
   | `ADMIN_DOMAIN` | admin host, e.g. `admin.pay.example.com` |
   | `POSTGRES_PASSWORD` | new random value |
   | `SETTLEMENT_INTERNAL_TOKEN` | new random value |
   | `WEBHOOK_SECRET_ENCRYPTION_KEY` | 32 random bytes, **base64** (`openssl rand -base64 32`) |
   | `ACQUIRER_CALLBACK_SIGNING_SECRET` | the value configured in the acquirer's portal |

3. **Start the stack**
   ```bash
   docker compose -f ops/docker-compose.prod.yml --env-file ops/.env.prod up -d --build
   ```
   This builds the images, runs migrations, then starts the services. The
   API only starts after migrations succeed; the edge only after the API is
   healthy.

4. **Check it**
   ```bash
   docker compose -f ops/docker-compose.prod.yml --env-file ops/.env.prod ps      # all "running"/"healthy"
   docker compose -f ops/docker-compose.prod.yml --env-file ops/.env.prod exec api \
     node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>r.text()).then(console.log)"   # {"status":"ready"}
   ```
   Then open `https://<DOMAIN>/dashboard/login` and `https://<ADMIN_DOMAIN>/login`.

5. **(Optional) Demo data.** Only on a demo server, never with real merchants:
   ```bash
   docker compose -f ops/docker-compose.prod.yml --env-file ops/.env.prod run --rm migrate npm run seed
   ```
   The seed accounts and their passwords are in `db/seed/`; change them, or
   don't seed, on any server reachable from the internet.

## Updating (every new commit)

As the panel's deploy script, or over SSH:
```bash
cd filspay
git pull origin main
docker compose -f ops/docker-compose.prod.yml --env-file ops/.env.prod up -d --build
```
Migrations run automatically before the API restarts. Data (Postgres, KYC
uploads, TLS certificates) lives on named volumes and survives rebuilds.

## If the panel already runs its own web server on 80/443

Some hosting panels put their own nginx in front of every site. Then Caddy
can't bind 80/443. Two options:

* **Let the panel handle HTTPS** and point the site at our edge on another
  port: in `ops/docker-compose.prod.yml` change the edge `ports` to
  `"8080:80"`, add `SITE_ADDRESS=http://pay.example.com` and
  `ADMIN_SITE_ADDRESS=http://admin.pay.example.com` to `ops/.env.prod`
  (the `http://` tells Caddy not to fetch its own certificates), and set
  the panel's proxy target to `http://127.0.0.1:8080`. Leave `DOMAIN` and
  `ADMIN_DOMAIN` as plain hostnames: the API builds its public `https://`
  links from them.
* **Or** disable the panel's web server for this site and keep Caddy on
  80/443 (simplest, and Caddy then manages the certificates).

## Recovery and limits (what the brief tests)

* Overload: past 40 requests in flight the API answers `503 Retry-After`
  instead of slowing down (`MAX_INFLIGHT_REQUESTS`).
* Crash: every service has `restart: unless-stopped`; the API was killed
  under load in testing and was back in ~8 s with no data lost.
* Load test against the live server: `scripts/loadtest/checkout.k6.js`
  (see `CAPACITY.md`). Use a separate database for the payment links it
  creates.

## Security checklist before going live

* `ops/.env.prod` exists only on the server; nothing secret is in git.
* The acquirer signing secret in `ops/.env.prod` matches the acquirer portal.
* Postgres is not published (only the edge has `ports`).
* `NODE_ENV=production` (set in the compose file): secure `__Host-` cookies,
  required callback signatures, no dev OTP codes, load shedding on.

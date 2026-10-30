#!/usr/bin/env bash
# Runs FilsPay tests against a FRESH, separate test database (filspay_test),
# never the dev stack's own `filspay` database. Everything runs inside the
# compose network, so it also works when another Postgres owns port 5432 on
# the host.
#
# Usage (from the repo root, with the stack's postgres running):
#   ops/run-tests.sh                      # every TS test + every Go test
#   ops/run-tests.sh ts                   # every TS test
#   ops/run-tests.sh go                   # every Go test
#   ops/run-tests.sh apps/api/src/routes/merchantRefunds.new.test.ts [more files...]
#
# Needs the images built once: docker compose -f ops/docker-compose.yml build
set -euo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: don't rewrite /app paths

# `pwd -W` gives a Windows path under Git Bash (what Docker Desktop wants for mounts).
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
COMPOSE="docker compose -f $ROOT/ops/docker-compose.yml"
NET="$(docker inspect "$($COMPOSE ps -q postgres)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
TEST_DB="postgres://filspay:filspay_dev_password@postgres:5432/filspay_test?sslmode=disable"
NODE_IMAGE="${NODE_IMAGE:-ops-api}"

# Source is mounted over the image's copy so the tests see your current code;
# node_modules come from the image (built for Linux).
MOUNTS=()
for d in apps/api/src apps/reporting/src apps/web/src packages/money/src packages/events/src scripts db; do
  MOUNTS+=(-v "$ROOT/$d:/app/$d:ro")
done
node_run() { docker run --rm --network "$NET" -e DATABASE_URL="$TEST_DB" "${MOUNTS[@]}" -w /app "$NODE_IMAGE" sh -c "$1"; }

# Drop, recreate and migrate filspay_test. Called before each package so one
# package's leftovers (some tests deliberately leave malformed outbox events)
# can't break the next package's tests.
fresh_db() {
  $COMPOSE exec -T postgres psql -U filspay -d postgres -q -c "DROP DATABASE IF EXISTS filspay_test" -c "CREATE DATABASE filspay_test"
  node_run "npm run migrate >/dev/null" && echo "   (fresh filspay_test, migrated)"
}

run_ts_files() { fresh_db; node_run "for f in $*; do d=\$(echo \$f | sed -E 's#^((apps|packages)/[^/]+)/.*#\\1#'); [ \"\$d\" = \"\$f\" ] && d=.; echo \"### \$f\"; (cd \$d && npx tsx --test --test-concurrency=1 \${f#\$d/} 2>&1 | grep -E '^not ok|^# (pass|fail)'); done"; }

run_ts_all() {
  for d in packages/events packages/money apps/api apps/reporting apps/web; do
    echo "### $d"; fresh_db
    node_run "cd $d && files=\$(find src -name '*.test.ts' | sort) && npx tsx --test --test-concurrency=1 \$files 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'"
  done
  echo "### scripts"; fresh_db
  node_run "npx tsx --test scripts/*.test.ts 2>&1 | grep -E '^not ok|^# (tests|pass|fail)'"
}

run_go() {
  echo "### go (apps/settlement)"; fresh_db
  docker run --rm --network "$NET" -e DATABASE_URL="$TEST_DB" -v "$ROOT/apps/settlement:/src" -v filspay_gocache:/root/go -w /src golang:1.22 \
    sh -c 'go test -count=1 ./... 2>&1 | grep -v "^go: downloading"'
}

case "${1:-all}" in
  all) run_ts_all; run_go ;;
  ts) run_ts_all ;;
  go) run_go ;;
  *) run_ts_files "$@" ;;
esac

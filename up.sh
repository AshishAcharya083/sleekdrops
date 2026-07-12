#!/usr/bin/env bash
# SleekDrops — bring the whole platform up locally.
#
#   ./up.sh              Postgres + agent platform (API + worker + admin panel)
#   ./up.sh --web        ... plus the website dev server (needs D1 creds in apps/web/.env)
#   ./up.sh --no-install skip pnpm install (faster when deps haven't changed)
#
# Logs + PIDs land in .run/. Stop everything with ./down.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR"
cd "$ROOT"

PNPM="npx -y pnpm@10"
WITH_WEB=0
DO_INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --web) WITH_WEB=1 ;;
    --no-install) DO_INSTALL=0 ;;
    *) echo "unknown flag: $arg (known: --web, --no-install)"; exit 1 ;;
  esac
done

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$1"; exit 1; }

command -v docker >/dev/null || die "docker is required (Postgres runs in a container)"
command -v node >/dev/null || die "node >= 22.12 is required"

step "Starting Postgres (docker compose, port 5544)"
docker compose up -d
for i in $(seq 1 30); do
  docker exec sleekdrops-postgres pg_isready -U sleekdrops -d sleekdrops_agent >/dev/null 2>&1 && break
  [ "$i" = 30 ] && die "Postgres did not become healthy"
  sleep 1
done
ok "Postgres ready"

if [ ! -f apps/agent/.env ]; then
  step "Creating apps/agent/.env from example"
  cp apps/agent/.env.example apps/agent/.env
  echo "  → fill in GEMINI_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / TAVILY_API_KEY (or paste them in admin Settings)"
fi

if [ "$DO_INSTALL" = 1 ]; then
  step "Installing workspace dependencies"
  $PNPM install
fi

step "Building admin panel (served by the agent server)"
$PNPM --filter @sleekdrops/admin build

step "Starting agent platform (API + worker + scheduler + admin panel)"
if lsof -ti :8787 -sTCP:LISTEN >/dev/null 2>&1; then
  ok "something already listens on :8787 — leaving it (./down.sh first to restart)"
else
  nohup $PNPM --filter @sleekdrops/agent start > "$RUN_DIR/agent.log" 2>&1 &
  echo $! > "$RUN_DIR/agent.pid"
  for i in $(seq 1 30); do
    curl -sf http://localhost:8787/api/health >/dev/null 2>&1 && break
    [ "$i" = 30 ] && die "agent platform failed to start — see .run/agent.log"
    sleep 1
  done
  ok "agent platform ready"
fi

if [ "$WITH_WEB" = 1 ]; then
  step "Starting website dev server"
  if lsof -ti :4321 -sTCP:LISTEN >/dev/null 2>&1; then
    ok "something already listens on :4321 — leaving it"
  else
    nohup $PNPM --filter @sleekdrops/web dev > "$RUN_DIR/web.log" 2>&1 &
    echo $! > "$RUN_DIR/web.pid"
    ok "website dev server starting (fetches content from D1 — see .run/web.log)"
  fi
fi

printf '\n\033[1mSleekDrops is up:\033[0m\n'
echo "  Admin panel + API : http://localhost:8787"
[ "$WITH_WEB" = 1 ] && echo "  Website (dev)     : http://localhost:4321"
echo "  Postgres          : postgres://sleekdrops:sleekdrops@localhost:5544/sleekdrops_agent"
echo "  Logs              : .run/agent.log$([ "$WITH_WEB" = 1 ] && echo ', .run/web.log')"
echo
echo "Stop everything with ./down.sh (add --wipe to also delete the database)."

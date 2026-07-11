#!/usr/bin/env bash
# SleekDrops — stop everything started by up.sh.
#
#   ./down.sh          stop agent platform, website dev server, Postgres
#   ./down.sh --wipe   ... and delete the Postgres data volume (fresh start)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.run"
cd "$ROOT"

WIPE=0
[ "${1:-}" = "--wipe" ] && WIPE=1

stop_port() { # name port pidfile
  local name="$1" port="$2" pidfile="$3"
  # Kill the recorded launcher PID and its children, then anything on the port.
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile")
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  fi
  local remaining
  remaining=$(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$remaining" ]; then
    echo "$remaining" | xargs kill -TERM 2>/dev/null || true
    sleep 1
    remaining=$(lsof -ti ":$port" -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$remaining" ] && echo "$remaining" | xargs kill -KILL 2>/dev/null || true
  fi
  if lsof -ti ":$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "✗ could not free port $port ($name)"
  else
    echo "✓ $name stopped"
  fi
}

stop_port "agent platform" 8787 "$RUN_DIR/agent.pid"
stop_port "website dev server" 4321 "$RUN_DIR/web.pid"

if [ "$WIPE" = 1 ]; then
  docker compose down -v
  echo "✓ Postgres stopped and data volume deleted"
else
  docker compose down
  echo "✓ Postgres stopped (data kept — use --wipe to delete)"
fi

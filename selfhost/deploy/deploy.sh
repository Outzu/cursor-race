#!/usr/bin/env bash
# Ship the current working tree to the droplet and restart.
#
#   bash selfhost/deploy/deploy.sh root@play.example.com
#
# Needs only ssh and tar locally, so it works from Git Bash on Windows.
# The droplet's data directory is never touched.

set -euo pipefail

HOST="${1:-${CR_HOST:-}}"
if [ -z "$HOST" ]; then
  echo "usage: deploy.sh user@droplet" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
SELFHOST="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$SELFHOST/.." && pwd)"

# The tarball goes over ssh's stdin, so the remote half has to travel as the
# command string — a heredoc would fight the pipe for stdin and win, silently.
REMOTE=$(cat <<'EOF'
set -euo pipefail
APP_DIR=/opt/cursor-race
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

tar -xzf - -C "$STAGE"

sudo mkdir -p "$APP_DIR"
sudo rsync -a --delete   --exclude 'selfhost/data'   --exclude 'selfhost/node_modules'   "$STAGE"/ "$APP_DIR"/
sudo chown -R cursorrace:cursorrace "$APP_DIR"

# The server needs a Postgres driver only when a shared store is configured,
# but installing it is cheap and keeps the two cases identical. node_modules is
# left out of the rsync above so a failed install leaves the running service on
# the last one that worked.
if ! sudo -u cursorrace npm ci --omit=dev --prefix "$APP_DIR/selfhost" --no-audit --no-fund; then
  echo "dependency install failed; service left on the previous build" >&2
  exit 1
fi
sudo chown -R cursorrace:cursorrace "$APP_DIR"

sudo systemctl restart cursor-race
sleep 1

if ! systemctl is-active --quiet cursor-race; then
  echo "service failed to start:" >&2
  sudo journalctl -u cursor-race -n 30 --no-pager >&2
  exit 1
fi

port="$(sudo grep -E '^PORT=' /etc/cursor-race.env | cut -d= -f2 || true)"
port="${port:-8080}"
if curl -fsS --max-time 5 "http://127.0.0.1:$port/api/session" >/dev/null; then
  echo "ok: cursor-race is up and answering on port $port"
else
  echo "service is running but did not answer on port $port" >&2
  sudo journalctl -u cursor-race -n 30 --no-pager >&2
  exit 1
fi
EOF
)

echo "==> building public/index.html"
node "$SELFHOST/build.js"

echo "==> shipping to $HOST"
tar -czf - -C "$ROOT" \
    --exclude='selfhost/data' \
    --exclude='selfhost/server.log' \
    --exclude='.git' \
    --exclude='node_modules' \
    selfhost cursor-race.html \
  | ssh "$HOST" "$REMOTE"

echo "==> done"

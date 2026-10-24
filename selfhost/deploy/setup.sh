#!/usr/bin/env bash
# One-time provisioning for a fresh Ubuntu droplet. Run as root ON the droplet:
#
#   DOMAIN=play.example.com bash setup.sh
#
# Safe to run again: it will not overwrite /etc/cursor-race.env once it exists.

set -euo pipefail

DOMAIN="${DOMAIN:-}"
APP_DIR=/opt/cursor-race
DATA_DIR=/var/lib/cursor-race
ENV_FILE=/etc/cursor-race.env
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" = "0" ] || { echo "run as root: sudo bash setup.sh"; exit 1; }
[ -n "$DOMAIN" ] || { echo "set DOMAIN, e.g. DOMAIN=play.example.com bash setup.sh"; exit 1; }

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg rsync ufw debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "==> node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v)"

if ! command -v caddy >/dev/null; then
  echo "==> caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi
echo "    $(caddy version | head -1)"

echo "==> user and directories"
id -u cursorrace >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin cursorrace
mkdir -p "$APP_DIR" "$DATA_DIR" /var/log/caddy
chown -R cursorrace:cursorrace "$APP_DIR" "$DATA_DIR"
chown -R caddy:caddy /var/log/caddy

echo "==> environment"
if [ ! -f "$ENV_FILE" ]; then
  install -m 600 "$HERE/env.example" "$ENV_FILE"
  secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$secret|" "$ENV_FILE"
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" "$ENV_FILE"
  echo "    wrote $ENV_FILE (add your Google credentials there)"
else
  echo "    $ENV_FILE already exists, left alone"
fi

echo "==> services"
install -m 644 "$HERE/cursor-race.service" /etc/systemd/system/cursor-race.service
sed "s/example\.com/$DOMAIN/g" "$HERE/Caddyfile" > /etc/caddy/Caddyfile

# An apex domain is the one people type without thinking, and the one they then
# type with a www in front of. Without a block for it Caddy has no certificate
# for that name and the browser shows a security warning rather than the game,
# which reads as broken. Only for an apex: adding www to a name that already has
# a subdomain would be a host nobody has pointed anywhere, and Caddy would keep
# failing to get a certificate for it.
if [ "$(echo "$DOMAIN" | tr -cd . | wc -c)" -eq 1 ]; then
  cat >> /etc/caddy/Caddyfile <<CADDY

www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
CADDY
  echo "    www.$DOMAIN redirects to $DOMAIN (point it at this droplet too)"
fi
systemctl daemon-reload
systemctl enable cursor-race >/dev/null
systemctl reload-or-restart caddy

echo "==> firewall"
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  echo "    ssh, 80 and 443 open"
fi

cat <<EOF

Droplet ready.

  1. Point $DOMAIN at this droplet's IP (an A record).
  2. Add your Google credentials to $ENV_FILE if you want sign-in.
  3. From your machine:  bash selfhost/deploy/deploy.sh root@$DOMAIN

Caddy gets the certificate on the first request once DNS resolves.
EOF

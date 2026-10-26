#!/usr/bin/env bash
# Refuse web traffic that did not come through Cloudflare. Run as root ON the
# droplet, once the proxy is switched on and the site is confirmed working:
#
#   sudo bash lock-to-cloudflare.sh           lock 80/443 to Cloudflare
#   sudo bash lock-to-cloudflare.sh --undo    open 80/443 to the world again
#   sudo bash lock-to-cloudflare.sh --dry     print what it would do
#
# Proxying on its own protects nothing. The origin IP sat in public DNS, so it
# is in historical lookup databases for good and an attacker can simply skip
# the proxy and hit the droplet. The proxy only becomes protection once the
# origin refuses everyone else.
#
# SSH is never touched, so a bad run cannot lock you out of the machine.
set -euo pipefail

V4_URL=https://www.cloudflare.com/ips-v4
V6_URL=https://www.cloudflare.com/ips-v6
MODE=apply
case "${1:-}" in
  --undo) MODE=undo ;;
  --dry)  MODE=dry ;;
  "")     ;;
  *) echo "usage: lock-to-cloudflare.sh [--undo|--dry]" >&2; exit 2 ;;
esac

[ "$(id -u)" = "0" ] || { echo "run as root" >&2; exit 1; }
command -v ufw >/dev/null || { echo "ufw is not installed" >&2; exit 1; }

# --- strip every existing rule for the web ports, whatever it allows ----------
# Done by number, highest first, because deleting renumbers everything below.
clear_web_rules() {
  local nums
  # grep finds nothing on a box with no web rules yet, and under pipefail that
  # would end the script here, silently, with nothing opened - hence the || true
  nums="$( { ufw status numbered 2>/dev/null \
          | grep -E '\[[ 0-9]+\].*(^|[^0-9])(80|443)/tcp' \
          | sed -E 's/^\[[ ]*([0-9]+)\].*/\1/' | sort -rn; } || true)"
  for n in $nums; do
    [ "$MODE" = dry ] && { echo "  would delete rule $n"; continue; }
    yes | ufw delete "$n" >/dev/null 2>&1 || true
  done
}

if [ "$MODE" = undo ]; then
  echo "==> opening 80 and 443 to everyone"
  clear_web_rules
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw status | sed 's/^/    /'
  exit 0
fi

echo "==> fetching Cloudflare's ranges"
v4="$(curl -fsS --max-time 20 "$V4_URL" || true)"
v6="$(curl -fsS --max-time 20 "$V6_URL" || true)"

# A failed or mangled fetch must change nothing at all. Locking the web ports
# to an empty list takes the site off the internet, and the only way back is
# the console.
valid() {
  local list="$1" want="$2" n
  n="$(printf '%s\n' "$list" | grep -cE "^[0-9a-fA-F:.]+/[0-9]{1,3}$" || true)"
  [ "$n" -ge "$want" ] || return 1
  [ "$n" -eq "$(printf '%s\n' "$list" | grep -c . || true)" ] || return 1
}

if ! valid "$v4" 5; then
  echo "    refused: the IPv4 list did not look like a list of ranges. Nothing changed." >&2
  exit 1
fi
use_v6=yes
if ! valid "$v6" 3; then
  echo "    note: no usable IPv6 list; leaving IPv6 alone"
  use_v6=no
fi
echo "    $(printf '%s\n' "$v4" | grep -c .) IPv4 ranges$([ $use_v6 = yes ] && echo ", $(printf '%s\n' "$v6" | grep -c .) IPv6")"

echo "==> replacing the rules for 80 and 443"
clear_web_rules

add() {
  [ "$MODE" = dry ] && { echo "  would allow $1 -> $2"; return; }
  ufw allow from "$1" to any port "$2" proto tcp >/dev/null
}
for cidr in $v4; do add "$cidr" 80; add "$cidr" 443; done
if [ "$use_v6" = yes ]; then
  for cidr in $v6; do add "$cidr" 80; add "$cidr" 443; done
fi

if [ "$MODE" = dry ]; then
  echo "==> dry run, nothing applied"
  exit 0
fi

ufw --force enable >/dev/null
echo "==> done. 80 and 443 now answer Cloudflare only; SSH is untouched."
echo
echo "    Check the site from somewhere else BEFORE closing this session."
echo "    If it is unreachable, run:  sudo bash $0 --undo"

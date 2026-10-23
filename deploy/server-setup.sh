#!/usr/bin/env bash
# One-time setup of an app server (Ubuntu or Debian, e.g. a Hetzner Cloud VM) for Anth-Agent's ship job.
# Run as root; safe to run again (it updates the app's settings and keeps its data, env files and deployments).
#
#   just server setup <root@host> <app> "<domain>, www.<domain>" <preview domain> <base port> <deploy public key file>
#
# What it does:
#   1. installs Docker, Caddy (automatic HTTPS) and curl
#   2. creates the user "anth" (in the docker group) and /srv/anth/<app>
#   3. installs anth-deploy (copied to /tmp/anth-deploy by the just recipe) as /usr/local/bin/anth-deploy
#   4. lets the deploy key log in as anth ONLY to run anth-deploy (forced command, no shell, no forwarding)
#   5. points Caddy at /srv/anth/*/Caddyfile and serves "coming soon" until the first promote
#   6. opens ports 22, 80 and 443 when ufw is present
set -euo pipefail

usage() { echo "usage: server-setup.sh --app NAME --domains 'a.com, www.a.com' --preview-domain preview.a.com --base-port 18000 --pubkey 'ssh-ed25519 …' [--app-port 3000] [--health-path /] [--data-dir /app/data]" >&2; exit 1; }
APP_PORT=3000 HEALTH_PATH=/ DATA_DIR=/app/data APP= DOMAINS= PREVIEW_DOMAIN= BASE_PORT= PUBKEY=
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --domains) DOMAINS="$2"; shift 2 ;;
    --preview-domain) PREVIEW_DOMAIN="$2"; shift 2 ;;
    --base-port) BASE_PORT="$2"; shift 2 ;;
    --app-port) APP_PORT="$2"; shift 2 ;;
    --health-path) HEALTH_PATH="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --pubkey) PUBKEY="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$APP" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || usage
[ -n "$DOMAINS" ] && [ -n "$PREVIEW_DOMAIN" ] && [[ "$BASE_PORT" =~ ^[0-9]+$ ]] && [[ "$PUBKEY" == ssh-* ]] || usage
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -f /tmp/anth-deploy ] || { echo "/tmp/anth-deploy is missing: run this through 'just server setup'" >&2; exit 1; }

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io caddy curl util-linux >/dev/null
systemctl enable --now docker caddy >/dev/null

echo "== user anth and /srv/anth/$APP"
id anth >/dev/null 2>&1 || useradd -m -s /bin/bash anth
usermod -aG docker anth
install -m 0755 /tmp/anth-deploy /usr/local/bin/anth-deploy
dir="/srv/anth/$APP"
# Caddy (user caddy) reads /srv/anth/*/Caddyfile, so these two folders are world-readable; secrets, source and data
# below them are not.
install -d -o anth -g anth -m 0755 /srv/anth "$dir"
install -d -o anth -g anth -m 0750 "$dir/releases" "$dir/data" "$dir/preview-data"
cat >"$dir/app.env" <<EOF
DOMAINS="$DOMAINS"
PREVIEW_DOMAIN="$PREVIEW_DOMAIN"
BASE_PORT=$BASE_PORT
APP_PORT=$APP_PORT
HEALTH_PATH="$HEALTH_PATH"
DATA_DIR="$DATA_DIR"
EOF
for f in env preview.env; do [ -f "$dir/$f" ] || install -o anth -g anth -m 0600 /dev/null "$dir/$f"; done
chown anth:anth "$dir/app.env"
chmod 0640 "$dir/app.env"

echo "== deploy key (forced command)"
install -d -o anth -g anth -m 0700 /home/anth/.ssh
keys=/home/anth/.ssh/authorized_keys
touch "$keys"
key_body="$(echo "$PUBKEY" | awk '{print $2}')"
grep -v -F "$key_body" "$keys" >"$keys.new" || true
echo "command=\"/usr/local/bin/anth-deploy\",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding $PUBKEY" >>"$keys.new"
mv "$keys.new" "$keys"
chown anth:anth "$keys"
chmod 0600 "$keys"

echo "== caddy"
if ! grep -q "import /srv/anth/\*/Caddyfile" /etc/caddy/Caddyfile 2>/dev/null; then
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-anth 2>/dev/null || true
  printf '# Managed by Anth-Agent: one Caddyfile per app in /srv/anth/<app>/.\nimport /srv/anth/*/Caddyfile\n' >/etc/caddy/Caddyfile
fi
if [ ! -f "$dir/Caddyfile" ]; then
  cat >"$dir/Caddyfile" <<EOF
$DOMAINS {
	respond "Coming soon" 200
}

$PREVIEW_DOMAIN {
	respond "No preview yet" 200
}
EOF
  chown anth:anth "$dir/Caddyfile"
fi
chmod 0644 "$dir/Caddyfile"
caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile

if command -v ufw >/dev/null; then
  echo "== firewall"
  ufw allow 22/tcp >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
fi

echo "== done: $APP on $DOMAINS (preview $PREVIEW_DOMAIN), production ports $BASE_PORT/$((BASE_PORT + 1)), preview $((BASE_PORT + 2))"
echo "Put the app's production secrets in $dir/env and preview secrets in $dir/preview.env (KEY=value lines)."

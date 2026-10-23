#!/usr/bin/env bash
# Put an app behind a password, or take it off. Run as root through `just server lock` / `just server unlock`, which
# send "PW=<password>" as the first line of this script on stdin, so the password is never a command-line argument
# on your machine. Only a bcrypt hash is stored: BASIC_AUTH_USER and BASIC_AUTH_HASH in /srv/anth/<app>/app.env.
#
#   bash -s -- <app> <user>     (PW empty: remove the password)
set -euo pipefail

app="${1:-}"
user="${2:-anthward}"
root="${ANTH_DEPLOY_ROOT:-/srv/anth}"
deploy="${ANTH_DEPLOY_BIN:-/usr/local/bin/anth-deploy}"
[[ "$app" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || { echo "invalid app name: $app" >&2; exit 1; }
[[ "$user" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || { echo "invalid user name: $user" >&2; exit 1; }
env_file="$root/$app/app.env"
[ -f "$env_file" ] || { echo "$app is not set up on this server (run just server setup)" >&2; exit 1; }

# The Caddyfile writer that knows about passwords, copied here by the just recipe.
[ -f /tmp/anth-deploy ] && install -m 0755 /tmp/anth-deploy "$deploy"

sed -i '/^BASIC_AUTH_/d' "$env_file"
if [ -n "${PW:-}" ]; then
  hash="$(caddy hash-password --plaintext "$PW")"
  printf 'BASIC_AUTH_USER=%s\nBASIC_AUTH_HASH=%q\n' "$user" "$hash" >>"$env_file"
fi

# Production already runs: rewrite its Caddyfile now. Before the first promote, the password applies from that promote.
if [ -f "$root/$app/current" ]; then
  if id anth >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then su -s /bin/bash anth -c "$deploy refresh $app"; else "$deploy" refresh "$app"; fi
fi
if [ -n "${PW:-}" ]; then echo "Locked: $app asks for user $user and the password."; else echo "Unlocked: $app is open to everyone."; fi

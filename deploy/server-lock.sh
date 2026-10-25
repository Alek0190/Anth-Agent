#!/usr/bin/env bash
# Put an app behind a password, or take it off. Scope "all" (default) locks production and preview; "preview" locks
# only the preview, for a public product whose previews run on a copy of real users' data.
# Run as root through `just server lock` / `just server unlock`, which send "PW=<password>" as the first line of this
# script on stdin, so the password is never a command-line argument on your machine. Only a bcrypt hash is stored:
# BASIC_AUTH_USER, BASIC_AUTH_HASH and BASIC_AUTH_SCOPE in /srv/anth/<app>/app.env.
#
#   bash -s -- <app> <user> [all|preview]     (PW empty: remove the password)
set -euo pipefail

app="${1:-}"
user="${2:-anthward}"
scope="${3:-all}"
[[ "$scope" =~ ^(all|preview)$ ]] || { echo "scope must be all or preview, not $scope" >&2; exit 1; }
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
  printf 'BASIC_AUTH_USER=%s\nBASIC_AUTH_HASH=%q\nBASIC_AUTH_SCOPE=%s\n' "$user" "$hash" "$scope" >>"$env_file"
fi

# Production already runs: rewrite its Caddyfile now. Before the first promote, the password applies from that promote.
if [ -f "$root/$app/current" ]; then
  if id anth >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then su -s /bin/bash anth -c "$deploy refresh $app"; else "$deploy" refresh "$app"; fi
fi
if [ -z "${PW:-}" ]; then echo "Unlocked: $app and its preview are open to everyone. Previews no longer get a copy of production's data; a copy the preview had is removed before it opens."
elif [ "$scope" = preview ]; then echo "Locked the preview: it asks for user $user and the password; production is public. Previews now run on a copy of production's data."
else echo "Locked: $app and its preview ask for user $user and the password."; fi

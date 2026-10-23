#!/usr/bin/env bash
# anth-deploy: the only thing Anth-Agent's ship job can run on an app server.
#
# Installed as /usr/local/bin/anth-deploy by deploy/server-setup.sh, and bound to the deploy SSH key as a forced
# command, so a leaked key can do nothing but these four things:
#
#   preview  <app> <sha>   read a tar of the source on stdin, docker build it, run it on the preview slot, health check,
#                          print the preview URL
#   promote  <app> <sha>   run that same image on the idle production slot, health check, point Caddy at it, stop the
#                          old slot. Zero downtime; the old slot's image stays for rollback
#   rollback <app>         promote the previous production image again
#   status   <app>         print the current and previous production images
#
# Per app, /srv/anth/<app>/app.env (written by server-setup.sh) holds DOMAINS, PREVIEW_DOMAIN, BASE_PORT (production
# slots BASE_PORT and BASE_PORT+1, preview BASE_PORT+2), APP_PORT (the port inside the container), HEALTH_PATH and
# DATA_DIR (the container path for persistent data). Secrets for the app live in /srv/anth/<app>/env (production) and
# /srv/anth/<app>/preview.env (preview); production data in /srv/anth/<app>/data, preview data in preview-data.
set -euo pipefail

ROOT="${ANTH_DEPLOY_ROOT:-/srv/anth}"
RELOAD="${ANTH_CADDY_RELOAD:-caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile}"
HEALTH_TRIES="${ANTH_HEALTH_TRIES:-60}"
SCHEME="${ANTH_URL_SCHEME:-https}"

die() { echo "anth-deploy: $*" >&2; exit 1; }
log() { echo "anth-deploy: $*" >&2; }

# As a forced command, the requested command arrives in SSH_ORIGINAL_COMMAND; never eval it, only split it.
if [ $# -eq 0 ] && [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  read -r -a args <<<"$SSH_ORIGINAL_COMMAND"
  set -- "${args[@]}"
fi
# Tolerate the client naming the program: "anth-deploy preview app sha".
[ "${1:-}" = "anth-deploy" ] && shift

cmd="${1:-}"
app="${2:-}"
sha="${3:-}"
[[ "$cmd" =~ ^(preview|promote|rollback|status)$ ]] || die "usage: preview <app> <sha> | promote <app> <sha> | rollback <app> | status <app>"
[[ "$app" =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "invalid app name: $app"
if [[ "$cmd" =~ ^(preview|promote)$ ]]; then [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || die "invalid commit: $sha"; fi

dir="$ROOT/$app"
[ -f "$dir/app.env" ] || die "$app is not set up on this server (run deploy/server-setup.sh)"
# shellcheck disable=SC1091
source "$dir/app.env"
: "${DOMAINS:?}" "${PREVIEW_DOMAIN:?}" "${BASE_PORT:?}"
APP_PORT="${APP_PORT:-3000}"
HEALTH_PATH="${HEALTH_PATH:-/}"
DATA_DIR="${DATA_DIR:-/app/data}"
image() { echo "anth-$app:$1"; }

# One deploy at a time per app.
exec 9>"$dir/.lock"
flock -w 600 9 || die "another deploy of $app is still running"

health() {
  local port="$1" i
  for ((i = 0; i < HEALTH_TRIES; i++)); do
    if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$port$HEALTH_PATH"; then return 0; fi
    sleep 1
  done
  return 1
}

# Run an image on a host port, with its env file and data folder. Replaces any container of that name.
start() {
  local name="$1" tag="$2" port="$3" envfile="$4" data="$5"
  docker rm -f "$name" >/dev/null 2>&1 || true
  mkdir -p "$data"
  local envarg=()
  [ -f "$envfile" ] && envarg=(--env-file "$envfile")
  docker run -d --name "$name" --restart unless-stopped \
    -p "127.0.0.1:$port:$APP_PORT" -e "PORT=$APP_PORT" "${envarg[@]}" \
    -v "$data:$DATA_DIR" "$tag" >/dev/null
}

caddyfile() {
  local prod_port="$1"
  cat >"$dir/Caddyfile.new" <<EOF
# Written by anth-deploy. Production on 127.0.0.1:$prod_port, preview on 127.0.0.1:$((BASE_PORT + 2)).
$DOMAINS {
	encode gzip
	reverse_proxy 127.0.0.1:$prod_port
}

$PREVIEW_DOMAIN {
	header X-Robots-Tag "noindex, nofollow"
	reverse_proxy 127.0.0.1:$((BASE_PORT + 2))
}
EOF
  mv "$dir/Caddyfile.new" "$dir/Caddyfile"
  $RELOAD >&2 || die "caddy reload failed"
}

# The production slot that is live now (0 or 1) and the image it runs; empty before the first promote.
current_slot() { [ -f "$dir/current" ] && cut -d' ' -f1 "$dir/current" || echo ""; }
current_sha() { [ -f "$dir/current" ] && cut -d' ' -f2 "$dir/current" || echo ""; }

promote() {
  local target="$1"
  docker image inspect "$(image "$target")" >/dev/null 2>&1 || die "no image for $target: deploy a preview of it first"
  local old_slot old_sha new_slot port
  old_slot="$(current_slot)"
  old_sha="$(current_sha)"
  if [ "$old_sha" = "$target" ]; then
    log "$target is already production"
    echo "$SCHEME://${DOMAINS%%,*}"
    return 0
  fi
  new_slot=$([ "$old_slot" = "0" ] && echo 1 || echo 0)
  port=$((BASE_PORT + new_slot))
  log "starting $target on production slot $new_slot (port $port)"
  start "anth-$app-$new_slot" "$(image "$target")" "$port" "$dir/env" "$dir/data"
  if ! health "$port"; then
    docker logs --tail 50 "anth-$app-$new_slot" >&2 || true
    docker rm -f "anth-$app-$new_slot" >/dev/null 2>&1 || true
    die "$target did not answer on $HEALTH_PATH; production is unchanged"
  fi
  caddyfile "$port"
  echo "$new_slot $target" >"$dir/current"
  [ -n "$old_sha" ] && echo "$old_slot $old_sha" >"$dir/previous"
  [ -n "$old_slot" ] && docker stop "anth-$app-$old_slot" >/dev/null 2>&1 || true
  log "production is $target"
  echo "$SCHEME://${DOMAINS%%,*}"
}

case "$cmd" in
  preview)
    release="$dir/releases/$sha"
    rm -rf "$release"
    mkdir -p "$release"
    tar -x -C "$release"
    [ -f "$release/Dockerfile" ] || die "the project has no Dockerfile: add one so the server can build it"
    log "building $(image "$sha")"
    docker build -q -t "$(image "$sha")" "$release" >&2
    port=$((BASE_PORT + 2))
    start "anth-$app-preview" "$(image "$sha")" "$port" "$dir/preview.env" "$dir/preview-data"
    health "$port" || { docker logs --tail 50 "anth-$app-preview" >&2 || true; die "the preview did not answer on $HEALTH_PATH"; }
    # Keep the last five releases on disk; images stay until pruned.
    ls -1t "$dir/releases" | tail -n +6 | while read -r old; do rm -rf "${dir:?}/releases/$old"; done
    echo "$SCHEME://$PREVIEW_DOMAIN"
    ;;
  promote) promote "$sha" ;;
  rollback)
    [ -f "$dir/previous" ] || die "no previous production deployment to roll back to"
    promote "$(cut -d' ' -f2 "$dir/previous")"
    ;;
  status)
    echo "current: $(current_sha) (slot $(current_slot))"
    echo "previous: $([ -f "$dir/previous" ] && cut -d' ' -f2 "$dir/previous" || echo none)"
    ;;
esac

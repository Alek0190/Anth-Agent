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
#   refresh  <app>         rewrite the app's Caddyfile for the live slot (after its password changed)
#
# A password (BASIC_AUTH_USER and BASIC_AUTH_HASH in app.env, set by `just server lock`) protects production and
# preview, or only the preview (BASIC_AUTH_SCOPE=preview: the public product with a private preview). /anth-health stays
# open for Anth-Agent's checks: it answers with the app's HEALTH_PATH, nothing else.
#
# Every preview starts from a fresh copy of production's data (PREVIEW_DATA=copy, the default; "empty" keeps the
# preview's own data), so a release is tried on the data it will meet. The copy is made only when the preview has a
# password: production data holds real users' accounts and messages, and when the password goes (`just server unlock`),
# the copy leaves the preview before the preview opens. Production's data is mounted read-only for the copy; SQLite
# databases are copied with SQLite's own backup, consistent even while production writes. The copy replaces the
# preview's data only once complete, so a failed copy leaves the preview as it was. The preview runs with
# ANTH_PREVIEW=1, so the app can keep outbound email and the like switched off there.
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

# Print an error to stderr and stop.
die() { echo "anth-deploy: $*" >&2; exit 1; }
# Print progress to stderr (stdout is reserved for the URL the ship job reads).
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
[[ "$cmd" =~ ^(preview|promote|rollback|status|refresh)$ ]] || die "usage: preview <app> <sha> | promote <app> <sha> | rollback <app> | status <app> | refresh <app>"
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
# The Docker image tag for a commit of this app.
image() { echo "anth-$app:$1"; }

# One deploy at a time per app.
exec 9>"$dir/.lock"
flock -w 600 9 || die "another deploy of $app is still running"

# Wait until the app answers HEALTH_PATH on a local port; fail after HEALTH_TRIES seconds.
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
  local name="$1" tag="$2" port="$3" envfile="$4" data="$5" extra="${6:-}"
  docker rm -f "$name" >/dev/null 2>&1 || true
  mkdir -p "$data"
  local envarg=()
  [ -f "$envfile" ] && envarg=(--env-file "$envfile")
  [ -n "$extra" ] && envarg+=(-e "$extra")
  docker run -d --name "$name" --restart unless-stopped \
    -p "127.0.0.1:$port:$APP_PORT" -e "PORT=$APP_PORT" "${envarg[@]}" \
    -v "$data:$DATA_DIR" "$tag" >/dev/null
}

# Copy FROM's contents into the empty folder TO, then replace every SQLite database in the copy with a consistent
# snapshot made by SQLite's backup (node:sqlite), since a plain file copy of a database being written can be torn. Each
# snapshot is written next to the copy and swapped in only once it is complete, so a snapshot that fails (three tries)
# leaves the plain copy whole; without node:sqlite every plain copy stays. Runs as root in a throwaway container of the
# new image, with production's data mounted read-only (cp -a keeps every file's owner, and a snapshot gets its source's
# owner and mode), or directly with ANTH_DATA_COPY=local (tests).
COPY_JS='const fs=require("fs"),path=require("path");
const from=process.env.FROM,to=process.env.TO,root=process.getuid&&process.getuid()===0;
const walk=(d)=>fs.readdirSync(d,{withFileTypes:true}).flatMap((e)=>e.isDirectory()?walk(path.join(d,e.name)):e.isFile()?[path.join(d,e.name)]:[]);
const isDb=(f)=>{const fd=fs.openSync(f,"r");try{const h=Buffer.alloc(16);fs.readSync(fd,h,0,16,0);return h.toString("latin1")==="SQLite format 3\0";}finally{fs.closeSync(fd);}};
(async()=>{const {DatabaseSync,backup}=require("node:sqlite");
for(const f of walk(from)){if(!isDb(f))continue;const rel=path.relative(from,f),dest=path.join(to,rel),tmp=dest+".anth-snapshot";
let err;for(let i=0;i<3;i++){fs.rmSync(tmp,{force:true});
try{const db=new DatabaseSync(f,{readOnly:true});try{await backup(db,tmp);}finally{db.close();}err=undefined;break;}
catch(e){err=e;await new Promise((r)=>setTimeout(r,250));}}
if(err){fs.rmSync(tmp,{force:true});console.error("anth-deploy: no consistent snapshot of "+rel+" ("+err.message+"); the preview keeps the plain copy");continue;}
const st=fs.statSync(f);fs.chmodSync(tmp,st.mode&0o7777);if(root)fs.chownSync(tmp,st.uid,st.gid);
for(const x of ["-wal","-shm","-journal"])fs.rmSync(dest+x,{force:true});
fs.renameSync(tmp,dest);console.error("anth-deploy: consistent snapshot of "+rel);}})()
.catch((e)=>{console.error("anth-deploy: SQLite snapshots skipped ("+e.message+"); the preview keeps the plain copy");process.exit(0);});'
COPY_SH='set -e
cp -a "$FROM"/. "$TO"/
if command -v node >/dev/null 2>&1; then node -e "$COPY_JS"; fi'

# Production's data, copied into the empty folder $1 (see COPY_JS).
copy_data() {
  local tag="$1" to="$2"
  if [ "${ANTH_DATA_COPY:-docker}" = "local" ]; then
    FROM="$dir/data" TO="$to" COPY_JS="$COPY_JS" sh -c "$COPY_SH" >&2
  else
    docker run --rm --user 0:0 --network none --entrypoint sh -e FROM=/from -e TO=/to -e COPY_JS="$COPY_JS" \
      -v "$dir/data:/from:ro" -v "$to:/to" "$tag" -c "$COPY_SH" >&2
  fi
}

# Delete a folder that containers may have filled with root's files. It is renamed out of the way first (instant, so
# nothing serves it from then on), then deleted, as root in a throwaway container of image $2 when plain rm cannot.
# Fails only when the rename fails.
discard() {
  local folder="$1" tag="${2:-}" trash
  [ -e "$folder" ] || return 0
  trash="$dir/.discard-$(date +%s)-$$-$RANDOM"
  mv "$folder" "$trash" || return 1
  rm -rf "$trash" 2>/dev/null && return 0
  if [ -n "$tag" ] && [ "${ANTH_DATA_COPY:-docker}" != "local" ]; then
    docker run --rm --user 0:0 --network none --entrypoint sh -v "$trash:/d" "$tag" \
      -c 'rm -rf /d/* /d/.[!.]* /d/..?*' >/dev/null 2>&1 || true
    rm -rf "$trash" 2>/dev/null && return 0
  fi
  log "could not delete $trash (files of another user); nothing uses it. Delete it with: sudo rm -rf $trash"
}

# Set while the preview's data folder is a copy of production's, so the copy is never left on an open preview.
COPIED="$dir/preview-data.production"

# True when a password protects the preview (both scopes do).
preview_locked() { [ -n "${BASIC_AUTH_USER:-}" ] && [ -n "${BASIC_AUTH_HASH:-}" ]; }

# The preview is open to everyone (no password): if its data is a copy of production's, take the copy away first. The
# preview stops; with restart=yes it starts again, on empty data, with the image it ran. $2: an image to clean up with
# when no preview is running.
forget_production_copy() {
  local restart="${1:-no}" tag
  [ -f "$COPIED" ] || return 0
  log "the preview has no password: removing its copy of production's data"
  tag="$(docker inspect -f '{{.Config.Image}}' "anth-$app-preview" 2>/dev/null || true)"
  [ -n "$tag" ] || tag="${2:-}"
  docker rm -f "anth-$app-preview" >/dev/null 2>&1 || true
  discard "$dir/preview-data" "$tag" || { log "could not remove the preview's copy of production's data"; return 1; }
  install -d -m 0750 "$dir/preview-data"
  rm -f "$COPIED"
  if [ "$restart" = yes ] && [ -n "$tag" ]; then
    start "anth-$app-preview" "$tag" "$((BASE_PORT + 2))" "$dir/preview.env" "$dir/preview-data" "ANTH_PREVIEW=1" ||
      log "the preview did not start again; the next ship starts it"
  fi
}

# Give the preview a fresh copy of production's data, when that is allowed and safe. The copy goes into a new folder
# that replaces the preview's only once it is complete, so a failed copy leaves the preview with the data it had.
refresh_preview_data() {
  local tag="$1" next="$dir/preview-data.next"
  if ! preview_locked; then
    forget_production_copy no "$tag" || die "the preview has no password and still holds production's data; not starting it"
    log "the preview has no password, so it does not get a copy of production's data (real users' data); it keeps its own. To test previews on production data: just server lock <host> $app <user> preview"
    return 0
  fi
  if [ "${PREVIEW_DATA:-copy}" != "copy" ]; then
    log "preview keeps its own data (PREVIEW_DATA=${PREVIEW_DATA})"
    return 0
  fi
  [ -d "$dir/data" ] || return 0
  discard "$next" "$tag" || { log "could not clear $next; the preview keeps the data it had"; return 0; }
  install -d -m 0750 "$next"
  log "copying production's data into the preview"
  if ! copy_data "$tag" "$next"; then
    log "copying production's data failed; the preview keeps the data it had"
    discard "$next" "$tag" || true
    return 0
  fi
  # Marked before the swap: a crash in between marks the preview's own data, which is harmless; never the reverse.
  touch "$COPIED"
  if ! discard "$dir/preview-data" "$tag"; then
    log "could not replace the preview's data; it keeps the data it had"
    discard "$next" "$tag" || true
    return 0
  fi
  mv "$next" "$dir/preview-data"
}

# One site block: /anth-health always open (it serves HEALTH_PATH), everything else behind the password when one is set.
site() {
  local domains="$1" port="$2" extra="$3" protect="${4:-yes}"
  echo "$domains {"
  echo "	encode gzip"
  [ -n "$extra" ] && echo "	$extra"
  echo "	handle /anth-health {"
  echo "		rewrite * $HEALTH_PATH"
  echo "		reverse_proxy 127.0.0.1:$port"
  echo "	}"
  echo "	handle {"
  if [ "$protect" = yes ] && [ -n "${BASIC_AUTH_USER:-}" ] && [ -n "${BASIC_AUTH_HASH:-}" ]; then
    echo "		basicauth {"
    echo "			$BASIC_AUTH_USER $BASIC_AUTH_HASH"
    echo "		}"
  fi
  echo "		reverse_proxy 127.0.0.1:$port"
  echo "	}"
  echo "}"
}

# Write the app's Caddyfile for a production port and reload Caddy; on failure restore the old file.
caddyfile() {
  local prod_port="$1"
  # An open preview must not serve a copy of production's data: take it away before the password goes.
  preview_locked || forget_production_copy yes || return 1
  {
    echo "# Written by anth-deploy. Production on 127.0.0.1:$prod_port, preview on 127.0.0.1:$((BASE_PORT + 2))."
    # BASIC_AUTH_SCOPE=preview: production is public, only the preview asks for the password.
    site "$DOMAINS" "$prod_port" "" "$([ "${BASIC_AUTH_SCOPE:-all}" = preview ] && echo no || echo yes)"
    echo
    site "$PREVIEW_DOMAIN" "$((BASE_PORT + 2))" 'header X-Robots-Tag "noindex, nofollow"'
  } >"$dir/Caddyfile.new"
  chmod 0644 "$dir/Caddyfile.new"
  # Keep the live file: if Caddy rejects the new one, put it back so the file always matches what is served.
  [ -f "$dir/Caddyfile" ] && cp -p "$dir/Caddyfile" "$dir/Caddyfile.bak"
  mv "$dir/Caddyfile.new" "$dir/Caddyfile"
  if ! $RELOAD >&2; then
    [ -f "$dir/Caddyfile.bak" ] && mv "$dir/Caddyfile.bak" "$dir/Caddyfile" && $RELOAD >&2 || true
    return 1
  fi
  rm -f "$dir/Caddyfile.bak"
}

# The production slot that is live now (0 or 1) and the image it runs; empty before the first promote.
current_slot() { [ -f "$dir/current" ] && cut -d' ' -f1 "$dir/current" || echo ""; }
# The commit running in the live production slot, empty before the first promote.
current_sha() { [ -f "$dir/current" ] && cut -d' ' -f2 "$dir/current" || echo ""; }

# Start a commit's image on the idle slot, health-check it, switch Caddy, stop the old slot.
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
  if ! caddyfile "$port"; then
    docker rm -f "anth-$app-$new_slot" >/dev/null 2>&1 || true
    die "caddy reload failed; production is unchanged"
  fi
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
    # Stop the old preview before its data is replaced, then start the new one on a fresh copy of production's.
    docker rm -f "anth-$app-preview" >/dev/null 2>&1 || true
    refresh_preview_data "$(image "$sha")"
    start "anth-$app-preview" "$(image "$sha")" "$port" "$dir/preview.env" "$dir/preview-data" "ANTH_PREVIEW=1"
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
  refresh)
    [ -n "$(current_slot)" ] || die "$app has no production deployment yet; the password applies from the first promote"
    caddyfile $((BASE_PORT + $(current_slot))) || die "caddy reload failed; the Caddyfile is unchanged"
    log "Caddyfile refreshed${BASIC_AUTH_USER:+ (password on for $BASIC_AUTH_USER)}"
    ;;
  status)
    echo "current: $(current_sha) (slot $(current_slot))"
    echo "previous: $([ -f "$dir/previous" ] && cut -d' ' -f2 "$dir/previous" || echo none)"
    ;;
esac

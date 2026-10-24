# App servers (e.g. Hetzner) that the ship job deploys to over SSH. See docs/HETZNER.md.

set shell := ["zsh", "-cu"]
set positional-arguments

# List server commands
[default]
[no-cd]
default:
    @just --list server

# One-time setup of an app server as root: Docker, Caddy, user anth, the deploy key (forced command)
[no-cd]
setup HOST APP DOMAINS PREVIEW_DOMAIN BASE_PORT PUBKEY_FILE *EXTRA:
    scp -q deploy/anth-deploy.sh "$1:/tmp/anth-deploy"
    ssh "$1" bash -s -- --app "$2" --domains "'$3'" --preview-domain "$4" --base-port "$5" --pubkey "'$(cat "$6")'" "${@:7}" < deploy/server-setup.sh

# Make a new deploy key pair in ~/.anth (ed25519, no passphrase) and add the private key to .env
[no-cd]
keygen NAME="anth_deploy":
    mkdir -p ~/.anth && ssh-keygen -q -t ed25519 -N "" -C "anth-agent deploy" -f ~/.anth/"$1"
    @echo "Public key: ~/.anth/$1.pub (pass it to just server setup)"
    @printf '\nANTH_DEPLOY_SSH_KEY=%s\n' "$(base64 < ~/.anth/$1 | tr -d '\n')" >> .env
    @echo "Added ANTH_DEPLOY_SSH_KEY to .env (the private key, base64). Add ANTH_DEPLOY_SSH_KEY to env_keys in anth-network.yaml, then just net up <device>."

# What production and the previous release are on a server, using the deploy key
[no-cd]
status HOST APP:
    ssh -i ~/.anth/anth_deploy "anth@$1" status "$2"

# Password-protect an app: SCOPE all (production + preview) or preview (public product, private preview on prod data)
[no-cd]
lock HOST APP USER="anthward" SCOPE="all":
    #!/usr/bin/env zsh
    set -eu
    read -rs "pw?Password for $3 on $2: "; echo
    [ ${#pw} -ge 10 ] || { echo "Use at least 10 characters."; exit 1; }
    scp -q deploy/anth-deploy.sh "$1:/tmp/anth-deploy"
    { printf 'PW=%q\n' "$pw"; cat deploy/server-lock.sh; } | ssh "$1" bash -s -- "$2" "$3" "$4"

# Remove an app's password
[no-cd]
unlock HOST APP:
    scp -q deploy/anth-deploy.sh "$1:/tmp/anth-deploy"
    ssh "$1" bash -s -- "$2" < deploy/server-lock.sh

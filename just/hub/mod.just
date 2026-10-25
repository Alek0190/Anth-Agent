# The playground hub and web client: http://localhost:4781.

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/anth-hub"

port := env("ANTH_HUB_PORT", "4781")
free-port := source_directory() / ".." / "free-port.sh"
# True when the built page exists and nothing it is built from (web source, SDK, config, package.json with its build
# script, lockfile) is newer.
ui-fresh := "[ -f apps/anth-hub-web/dist/index.html ] && [ -z \"$(find apps/anth-hub-web/src apps/anth-hub-web/index.html apps/anth-hub-web/vite.config.ts apps/anth-hub-web/tsconfig.json package.json package-lock.json ../anth-sdk/src -newer apps/anth-hub-web/dist/index.html -print -quit 2>/dev/null)\" ]"

# List hub commands
[default]
default:
    @just --list hub

# Serve the web UI. Builds it first when the code changed since the last build, so a git pull never leaves an old
# page; the build runs before the port is freed, so a failed build leaves a running hub as it was.
start *ARGS:
    @{{ ui-fresh }} || { echo "Building the web UI: its code changed since the last build…"; npm run build; }
    @{{ free-port }} {{ port }}
    ANTH_HUB_PORT={{ port }} npm start -- "$@"

# Serve with Vite hot reload (frees the port)
dev *ARGS:
    @{{ free-port }} {{ port }}
    ANTH_HUB_PORT={{ port }} npm run dev -- "$@"

# Type check and build the web UI
build:
    npm run build

# Open the web UI in the browser
open:
    open http://localhost:{{ port }}

# Build, lint and run the hub test
check:
    npm run build
    npm run lint
    npm test

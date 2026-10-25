# The playground hub and web client: http://localhost:4781.

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/anth-hub"

port := env("ANTH_HUB_PORT", "4781")
free-port := source_directory() / ".." / "free-port.sh"
# True when the built page exists and nothing it is built from (web source, SDK, config, lockfile) is newer.
ui-fresh := "[ -f apps/anth-hub-web/dist/index.html ] && [ -z \"$(find apps/anth-hub-web/src apps/anth-hub-web/index.html apps/anth-hub-web/vite.config.ts apps/anth-hub-web/tsconfig.json package-lock.json ../anth-sdk/src -newer apps/anth-hub-web/dist/index.html -print -quit 2>/dev/null)\" ]"

# List hub commands
[default]
default:
    @just --list hub

# Serve the web UI (frees the port first). Builds it first when the code changed since the last build, so a git
# pull never leaves an old page.
start *ARGS:
    @{{ free-port }} {{ port }}
    @{{ ui-fresh }} || { echo "Building the web UI: its code changed since the last build…"; npm run build; }
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

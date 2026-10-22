# anth-backend on this machine. Remote devices run it as a service (see `just net`).

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/anth-backend"

free-port := source_directory() / ".." / "free-port.sh"
# The port the backend will bind: $ANTH_PORT, else ANTH_PORT in ~/.anth/backend.env, else 4780.
port := 'p=${ANTH_PORT:-$(sed -n "s/^ANTH_PORT=//p" "${ANTH_HOME:-$HOME/.anth}/backend.env" 2>/dev/null | head -1)}; echo ${p:-4780}'

# List backend commands
[default]
default:
    @just --list backend

# Run this machine's backend (frees the port first)
run *ARGS:
    @{{ free-port }} "$({{ port }})"
    npm start -- "$@"

# Run with restart on file changes (frees the port)
dev *ARGS:
    @{{ free-port }} "$({{ port }})"
    npm run dev -- "$@"

# Create ~/.anth/backend.env with a token
token:
    npm run token

# Type check and run backend tests
check:
    npm run check
    npm test

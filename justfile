# Anth-Agent. Recipes are grouped by work area under just/<group>/mod.just.
# Device recipes take an id from anth-network.yaml; nothing here names a machine.
set dotenv-load := true
set shell := ["zsh", "-cu"]

# Devices: up, deploy, status, logs, restart
mod net 'just/net'

# This machine's anth-backend
mod backend 'just/backend'

# Web UI hub on port 4781
mod hub 'just/hub'

# Terminal client for one device
mod tui 'just/tui'

# Unit, UI, device and e2e suites
mod test 'just/test'

# App servers the ship job deploys to: setup, keygen, status
mod server 'just/server'

# Proactive demo: just proactive <command>
mod proactive 'just/proactive'

# List command groups
default:
    @just --list

# Install dependencies for every network app
install:
    cd apps/anth-sdk && npm install --no-audit --no-fund
    cd apps/anth-backend && npm install --no-audit --no-fund
    cd apps/anth-hub && npm install --no-audit --no-fund
    cd apps/anth-tui && npm install --no-audit --no-fund

# Type checks and unit tests, every app
check: test::unit

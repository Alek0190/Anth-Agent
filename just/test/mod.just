# Test suites. Device suites use a real model and cost money; `unit` and `ui` do not.

set shell := ["zsh", "-cu"]
set positional-arguments

# List test commands
[default]
[no-cd]
default:
    @just --list test

# Type checks and unit tests, every app
[no-cd]
unit:
    cd apps/anth-sdk && npm run check && npm test
    cd apps/anth-backend && npm run check && npm test
    cd apps/anth-hub && npm run build && npm run lint && npm test
    cd apps/anth-tui && npm run check && npm test

# Web UI suite against two faux devices (builds the UI first)
[no-cd]
ui:
    cd apps/anth-hub && npm run build && node tests/network-ui.mjs

# UI and agent suites on one device
[no-cd]
device DEVICE:
    cd apps/anth-hub && for t in device-ui agent-features browser-close; do ANTH_DEVICE="$1" node tests/$t.mjs || exit 1; done

# Device suites on every YAML device
[no-cd]
devices:
    for d in $(just net ids); do just test device "$d" || exit 1; done

# TUI smoke: faux, or a device id
[no-cd]
smoke TARGET="faux":
    apps/anth-tui/tests/smoke.sh "$1"

# TUI + web + restart + fork scenario
[no-cd]
e2e DEVICE:
    cd apps/anth-hub && ANTH_DEVICE="$1" node tests/e2e-network.mjs

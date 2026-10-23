# Telegram alerts and calls. See docs/TELEGRAM.md.

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps/anth-backend"

# List Telegram commands
[default]
default:
    @just --list telegram

# Log in as the "Anth Alerts" account once; saves TELEGRAM_CALLER_SESSION to .env
login:
    npx tsx scripts/telegram-login.ts login ../../.env

# Ring TELEGRAM_CALL_TO once from the alerts account, to test the call
call TEXT="Test call from Anth-Agent":
    npx tsx scripts/telegram-login.ts call "$1"

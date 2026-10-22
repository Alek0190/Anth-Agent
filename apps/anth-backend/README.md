# anth-backend

The Anth-Agent **device server**. Run one on every machine that should host durable agents: your laptop, a Mac mini, a Linux box, an exe.dev VM. It owns the harnesses, the SQLite databases, the tools and the filesystem. Clients connect with the device's **URL and bearer token** through the [v1 API](API.md).

```
client (hub / anth-tui / curl) ──HTTP + SSE, Bearer──► anth-backend ──► sessions/<id>/agent.sqlite (pi-durable)
```

## Run it on this machine

Needs Node 22.19 or newer (`.nvmrc` pins 24).

```bash
cd apps/anth-backend && npm install
npm run token                  # creates ~/.anth/backend.env with ANTH_TOKEN and prints it (npm run token -- --rotate replaces it)
echo "OPENROUTER_API_KEY=sk-or-..." >> ~/.anth/backend.env
npm start                      # 127.0.0.1:4780; data in ~/.anth/backend
```

With the repo's network config, `just net up local && just backend run` does the same thing. `just backend run` first stops whatever already listens on the backend's port.

## Configuration: `~/.anth/backend.env`

| Key | Default | Meaning |
|---|---|---|
| `ANTH_TOKEN` | required, ≥32 chars | bearer token for every `/v1` call |
| `ANTH_DEVICE_NAME` | hostname | name shown to clients |
| `ANTH_PORT` / `ANTH_HOST` | `4780` / `127.0.0.1` | listen address. `just net up` writes the YAML `host`, which defaults to `0.0.0.0` for `ssh` and `exe-dev` devices so other machines can reach them |
| `ANTH_START_DIRS` | `~/anth-work` | colon-separated folders where new sessions start, created at startup if missing: the directory browser opens there and relative cwds resolve against the first. Any existing directory is allowed as cwd |
| `ANTH_DATA_DIR` | `$ANTH_HOME/backend` | catalog, app state, `sessions/`, `archive/` |
| `ANTH_HOME` | `~/.anth` | where `backend.env` is read (set by the service unit) |
| `ANTH_ENV_FILE` | `$ANTH_HOME/backend.env` | the env file to read |
| `ANTH_PROVIDER` | `openrouter` | `faux` gives a free deterministic model for tests |
| `OPENROUTER_API_KEY` | | model access, required unless `ANTH_PROVIDER=faux`. Without it the device lists no models. Never sent to clients |
| `TYPESAFE_API_KEY` | | optional: `jev-damage-control` asks Jev with it, else through OpenRouter |

Flags `--port`, `--host`, `--name`, `--start-dirs`, `--data-dir` and `--env-file` override the env.

## Deploy to other devices

Devices are declared in the repo root's `anth-network.yaml` (gitignored; start from [`anth-network.example.yaml`](../../anth-network.example.yaml)). Nothing else names a machine:

```bash
just net up <id>   # (exe.dev: create →) provision → deploy → env → service → (exe.dev: expose →) register → wait online
just net status    # probe every device
just net logs <id>  |  just net restart <id>  |  just net deploy <id>  |  just net down <id>  |  just net destroy <id>
just net rotate <id>   # new token, restart, re-register
just net probe <id>    # /healthz 200 and /v1/device 401 without a token
```

| Kind | Service | Notes |
|---|---|---|
| `local` | none (`just backend run`) or launchd/systemd | binds 127.0.0.1 |
| `ssh` | `launchd` → `~/Library/LaunchAgents/dev.anth.backend.plist`; `systemd` → `/etc/systemd/system/anth-backend.service` | binds 0.0.0.0 by default; needs passwordless ssh; systemd needs `sudo -n` |
| `exe-dev` | systemd | VM created on demand; the HTTPS proxy is set public, so the token is the gate |
| `url` | none | connect only: `just net register <id> --token <t>` |

Templates live in [`deploy/`](deploy/). The operator skill [`.claude/skills/agent-sandboxes-exe-dev/cookbook/anth-network.md`](../../.claude/skills/agent-sandboxes-exe-dev/cookbook/anth-network.md) covers debugging per kind.

## Layout on a device

```
~/anth/apps/anth-backend, ~/anth/apps/anth-sdk     code (rsynced; safe to replace)
~/.anth/backend.env                              token + config (0600)
~/.anth/backend/catalog.sqlite                   sessions, agent names, device uid, idempotency keys, compaction thresholds
~/.anth/backend/app-state.sqlite                 the device's shared App State (demo extension)
~/.anth/backend/sessions/<uuid>/agent.sqlite     one pi-durable harness per session
~/.anth/backend/archive/                          archived sessions (DELETE never removes files)
~/.anth/backend.log                              service log
```

## Guarantees and boundaries

- Closing a client never stops work. A backend restart resumes unfinished tasks from their checkpoints. Replay-safe tools may rerun, and unsafe ones return an interrupted result.
- A token holder has the agent's shell and filesystem access on that device. Start dirs are where sessions begin, not a sandbox.
- macOS `ssh` devices run as a LaunchAgent in the logged-in session, so enable auto-login for unattended reboots. Agents working under `~/Documents` need Full Disk Access for the node binary.
- LAN `ssh` devices speak plain HTTP, so the token crosses the LAN in cleartext. exe.dev devices use HTTPS.
- `jev-damage-control` is off by default. When on, it sends each bash command to the Jev API, and the command runs if Jev fails. It is a guardrail, not a sandbox.

## Demo runbook: hop into an already running agent

Any device id from `anth-network.yaml` whose backend runs as a service works. `DEVICE=mac-mini` below.

```bash
just net status                                      # 1. every device online
just hub start                                       # 2. web UI: http://localhost:4781
just tui new $DEVICE e2e-network --cwd '~/anth/e2e'   # 3. a session in the repo's e2e/ folder on the device, attached
```

| Step | Do | Expect |
|---|---|---|
| 4 | In the TUI, prompt a multi-tool task (write a script, run it, improve it three times) | The TUI header shows `● live`, the status line `working…`, and tool rows with spinners |
| 5 | Open the web UI | The tree shows `$DEVICE › e2e-network › Main` with a pulsing dot. The transcript streams in both clients |
| 6 | In the web composer pick **Steer** and send "use bash only for verification runs" | The TUI shows `↪ steer: …`, then the message lands after the current tool round |
| 7 | Ctrl+C the TUI (it prints `just tui attach $DEVICE:<session>:<agent>`), close the browser, run `just net restart $DEVICE` while a tool runs | Nothing is watching. The service restarts in about a second |
| 8 | Reopen the web UI | The device dims, then returns online. The run resumes from its checkpoint, and an interrupted bash call shows its interrupted result |
| 9 | Fork from the web at an earlier reply, name it `e2e-fork`, then run `just tui attach $DEVICE:e2e-network:e2e-fork` | The TUI header shows `⑂ e2e-fork` with the history up to that entry |

`just test e2e $DEVICE` runs steps 3 to 9 unattended and checks the committed state. Its session works in `<code_dir>/e2e` on the device, one `fib-<time>/` folder per run.

The one-request client needs nothing but curl. The answer comes back in the same request:

```bash
read U T < <(sqlite3 -separator ' ' ~/.anth/network.sqlite "select url, token from devices where id='vm-1'")
H=(-H "Authorization: Bearer $T" -H 'content-type: application/json')
# cwd "." is the device's first start dir
curl -s "$U/v1/sessions" "${H[@]}" -d '{"name":"oneshot","cwd":".","model":{"provider":"openrouter","modelId":"anthropic/claude-sonnet-5.5"}}'
curl -s "$U/v1/sessions/oneshot/agents/main/messages" "${H[@]}" \
  -d '{"content":"How many files are in this directory? Use bash.","requestId":"oneshot-1","waitMs":120000}'
# {"submissionId":…,"status":"done","answer":{"entryId":…,"text":"…"}}  (on timeout: 202 "pending" or "queued"; poll /submissions/<id>?waitMs=)
```

## Development

```bash
npm run dev     # restart on file changes (just backend dev)
npm run check   # strict types, including the pi-durable ↔ SDK wire contract check
npm test        # api, streams, store (jobs, start_session, extensions, read only), search_history, shared state and SIGKILL recovery (faux provider, no network)
```

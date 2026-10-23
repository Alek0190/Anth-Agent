# Anth-Agent — Architecture & Build Plan

As of 2026-10-22. Living version (with diagrams and comments): the Claude doc "Anth-Agent — Architecture & Build Plan".

## Vision

Anth-Agent is Anthward's durable agent team: it builds client products, ships them, watches them live and fixes them, on your laptop, your cloud and throwaway sandboxes, and stops for your approval before anything risky.

- **Who it's for first:** Anthward, delivering AI-native software for small and local business clients.
- **Who it's for later:** other agencies and freelancers, once the internal version proves itself.
- **The promise:** "Describe the product. Agents build it, ship it and keep it healthy. You only approve."
- **The KPI:** how many agents are doing useful work for your clients right now, without you.

## Decision: fork durable-pi, port mydev

Anth-Agent starts as a fork of [disler/durable-pi](https://github.com/disler/durable-pi) (MIT). mydev's agent team, rules and workflows move into it as pi-durable extensions and jobs.

| Option | What you get | Why not / why |
| --- | --- | --- |
| Refactor mydev (Strands) | Your agent team as it is | No durability: checkpoints, interrupted tools and restart-proof approvals would be rebuilt by hand |
| Use durable-pi as-is | Durability, network, UI | A demo: no clients, projects, lifecycle or agent team |
| **Fork durable-pi + port mydev** | **Durability, network and UI on day one, plus the agent brain** | **Chosen** |

- **From durable-pi:** pi-durable 1.0.3 harness, device server, `/v1` API with `requestId` idempotency, SSE streams, hub + Vue UI, TUI, the device network (`local`, `ssh`, `exe-dev`, `url`), durable jobs, Jev guard, the proactive incident pattern.
- **From mydev:** agent roles, model per agent via OpenRouter, Jev routing, the strict PR merge rule, "merge never deploys, only release goes live", Neon access, MCP integrations, urgency-based voice/Telegram alerts.

## Core concepts

Three business levels on top of durable-pi's three technical ones:

```
Client        an Anthward customer (e.g. Dental Co); own secrets scope        NEW
└ Project     one product, one GitHub repo, one agent team, one approval log  NEW
  └ Environment  dev | staging | prod; decides approval rules and device      NEW
    └ Device     laptop (WSL2), cloud VM or sandbox running anth-backend
      └ Session  one pi-durable harness + agent.sqlite in the project folder
        └ Agent  Lead, its subagents and forks
```

You work in the top three; the bottom three are picked for you. Address: `dental-co/booking-site/prod`.

## Architecture

The agent lives on a device, not in a client: close every window and the work keeps going.

```
 Web UI   anth CLI + TUI   Telegram + voice   curl/scripts
    \          |                 |               /
     Hub on your laptop (127.0.0.1): registry, tokens, approval inbox, SSE mux
                      |  /v1 API + bearer token
     Laptop (WSL2, dev)   Cloud VM (staging, ops, 24/7)   Sandbox (per task, destroyed after)
                      |
     GitHub · Vercel · Neon · Sentry · Linear · Slack · OpenRouter · Jev
```

| App | From | Changes in Anth-Agent |
| --- | --- | --- |
| `anth-backend` | `dpi-backend` | Client/project/environment tables, agent-team extensions, ship and watch jobs, sandbox driver |
| `anth-hub` + UI | `dpi-playground` | Client-first tree, approval inbox, health strip, Telegram bridge |
| `anth` CLI / TUI | `dpi-tui` + `net.ts` | `new`, `ship`, `watch`, `inbox` on top of attach |
| `anth-sdk` | `dpi-sdk` | Wire types for clients, projects, approvals |

## Agent team

Each role is one pi-durable extension: a prompt, a tool set, a default model and its hooks. A Lead agent runs the project conversation and hands work to the others as subagents.

| Role | Does | Tools | Writes need approval? |
| --- | --- | --- | --- |
| Lead | Brief → plan, assigns tasks, reports status | read, state, subagent, run_durable_job | No (plans only) |
| API expert | Designs and documents the API contract | read, write, edit, bash | No on dev |
| Backend dev | Server code, DB schema, migrations | read, write, edit, bash, Neon/Supabase | Migrations: yes |
| Frontend dev | UI and client code | read, write, edit, bash, browser | No on dev |
| Tester | Tests after every task; Jev picks what to test next | read, bash, browser | No |
| Reviewer | Opens and reviews PRs, report, merges safe changes | read, git, GitHub | Outside strict rule: yes |
| Security | Auth, secrets, dependencies after review | read, bash | No |
| Ops / on-call | Deploys, watches logs and errors, opens incidents | deploy, Vercel, Sentry/logs | Every prod deploy: yes |

Shared: model per agent (switchable live), Jev for bounded decisions, project memory in App State plus a reviewed lessons store, MCP integrations (reads free, writes approved), skills per role.

## Product lifecycle

```
Brief (you) → Plan (Lead) → Build (team, sandbox) → Test + review
   → APPROVE DEPLOY (you, durable wait) → Deploy + verify (ops)
   → Watch live (Jev per event) → incident → Fix on a branch → back to APPROVE
```

- Plan → Build → Test + review = a durable job, one checkpoint per phase (like `release-check`).
- Approve deploy = the proactive demo's `ops.deploy` task: approval → rollout → verify; survives restarts, never deploys twice.
- Watch live = the demo's watcher pointed at Sentry/Vercel logs.
- Fix = the incident agent; the new test must fail on `main` and pass on its branch.

## Approvals and safety rules

Every approval is a durable task. Rules live in code (hooks, tool checks), not prompts.

| Action | Dev / sandbox | Staging | Production |
| --- | --- | --- | --- |
| Read files, logs, issues | Free | Free | Free |
| Write code, run bash | Free | Free | Never on the prod machine |
| Merge a PR | Strict rule | Strict rule | Strict rule, else you approve |
| DB migration | Free | You approve | You approve |
| Deploy | Free | Free | You approve, always |
| Message as you | You approve | You approve | You approve |
| Spend money | You approve | You approve | You approve |

1. Strict merge rule: auto-merge only safe changes; migrations, env, dependencies, deploy or auth files wait for you.
2. Merge never deploys; only a `release` job goes live.
3. Git guard hook blocks force push, `reset --hard`, branch deletion, worktree changes.
4. Jev damage control on every `bash` call, on by default.
5. Rollback is one approval; every prod deploy records the previous revision.
6. Effects carry their own idempotency key (durable = checkpointed, not exactly-once).
7. Client secrets scoped per project and environment; never sent to the browser.

## Ease of use

| Command | What happens |
| --- | --- |
| `anth setup` | Checks Node, keys, WSL; registers this machine; opens the UI |
| `anth client add "Dental Co"` | Creates a client |
| `anth new "booking site" --client dental-co` | Project, repo, dev sandbox, agent team; Lead starts planning |
| `anth ship` | build → test → review → release; waits for deploy approval |
| `anth watch` | Live monitoring of production |
| `anth inbox` | Every pending approval across clients |
| `anth attach dental-co/booking-site` | Lead agent in the terminal |

UI: Clients → Projects → Environments tree; approval inbox on top; project health strip; mobile approvals plus Telegram/voice for urgent ones (Jev decides urgency, quiet hours at night).

## Build roadmap

1. **Fork and run.** Fork as Anth-Agent, rename, run in WSL2 plus one cloud VM. *Done when:* `just check` passes and the UI shows both devices. **(rename done in this commit)**
2. **Client → Project → Environment.** Catalog tables, API routes, left tree. *Done when:* a client and project exist and sessions show under them. **(done: `PUT /v1/projects/:client/:project`, sessions carry `project` + `env`, the hub tree merges Clients → Projects → Environments across devices)**
3. **Agent team.** Port mydev's roles as extensions. *Done when:* the Lead plans a small app and the team builds it in a sandbox. **(done: `src/team.ts` roles, the Lead's durable `delegate` tool, model per role via `PATCH /v1/sessions/:s/team` and the Team tab; on by default in project sessions. Sandboxes arrive in phase 6, so members work in the session folder.)**
4. **Ship job.** plan → build → test → review → approve → deploy (Vercel) → verify. *Done when:* the Anthward website ships through one approval. **(built: durable `ship` job (branch, build and test, reviewer and security, Vercel preview, HTTP check, GitHub PR, your approval, promote the same preview, verify) and `rollback`; deploy tokens never reach agents. Still to do: ship the Anthward website with real tokens.)**
5. **Watch and fix.** Sentry/Vercel logs → Jev → thresholds → incident agent → fix → approval. *Done when:* an injected bug is fixed and waiting in under 5 minutes. **(built: Vercel logs, uptime checks and a webhook per project; Jev triage; incident rule in code; an incident agent per incident in its own worktree; `submit_fix` proves the test fails on the base branch and passes with the fix, then starts ship; the Watch tab and an incident badge in the tree. Still to do: time it on a real injected bug.)**
6. **Own servers (Hetzner).** A second deploy target next to Vercel: Docker + Caddy on an app server over SSH, with the same preview → approval → promote flow, zero-downtime slots and one-approval rollback; the deploy key can only run `anth-deploy`. Plus an always-on Anth-Agent box (Tailscale) so watching and webhooks never sleep. *Done when:* anthwebbuilder ships to anthwebbuilder.com through one approval. **(built: `deploy/anth-deploy.sh`, `deploy/server-setup.sh`, `just server setup|keygen|status`, ship and rollback with `anth.json` `deploy.target: "server"`, [HETZNER.md](HETZNER.md). Sandboxes per task move to a later phase.)**
7. **Inbox, alerts, polish.** Approval inbox, Telegram/voice, `anth` CLI, one-command setup. *Done when:* a full client project runs from your phone. **(7a built: Telegram bot with approvals, failures and incidents, Approve / Reject buttons only your chat can press, and a ring from a second Telegram account for incidents and approvals that wait too long: [TELEGRAM.md](TELEGRAM.md). 7b built: the Lead works on its own: how a ship or rollback ended comes back to it as an automatic notice, it fixes and ships again up to 3 rounds, re-delegates members that were cut off, and asks the owner only for approval, credentials, deleting data or a change of direction; messages to a member go to the Lead. Next: spoken alerts in the call, the `anth` CLI, one-command setup.)**

## Risks and open questions

| Risk | Fallback |
| --- | --- |
| pi-durable is experimental (pinned 1.0.3) | Keep the pin; wrap harness calls in one module |
| Windows: ops assume zsh, launchd/systemd | Local device runs in WSL2 with systemd |
| A device token is a shell | Prod machines run deploy-only agents; client work in sandboxes |
| LAN ssh devices use plain HTTP | Tailscale or HTTPS |
| Upstream keeps changing | Track `upstream` remote; pull fixes, don't block on it |
| Model costs on long runs | Mission first, then Jev routing and cheaper models per role |

- [ ] Sandbox provider: Modal, E2B or Daytona?
- [ ] Hosting default: Vercel only, or also a VM option?
- [ ] Does mydev keep running during the port, or retire after phase 3?
- [ ] Client secrets: per-device env, or a vault (Doppler, 1Password)?

Path to product (later): hosted hub with login, teams and roles, billing, one-click installer, template gallery.

# anth-backend API v1

The contract every Durable Agent Network client uses: the web hub, `anth-tui`, scripts, other agents. Types live in [`../anth-sdk/src/api.ts`](../anth-sdk/src/api.ts). [`../anth-sdk/src/client.ts`](../anth-sdk/src/client.ts) is a typed client for browsers and Node.

## Conventions

- **Auth.** Every `/v1/*` route requires `Authorization: Bearer <ANTH_TOKEN>`. `X-Anth-Token: <ANTH_TOKEN>` also works, for proxies that strip `Authorization`. Only `GET /healthz` is open.
- **Vocabulary.** A **session** is one harness and one agent database on the device. An **agent** is a pi-durable conversation in that session: the root (`Main`), a fork, or a subagent. The agent id is the conversation id.
- **Addressing.** `:s` is a session UUID or its unique name (case-insensitive). `:a` is a numeric agent id, `main`, or a unique agent name. Ambiguous names return `409 ambiguous`.
- **Idempotency.** `POST .../messages` takes a required `requestId`, and pi-durable admits each one exactly once. `POST /sessions`, `POST .../agents` and `POST .../fork` accept an `Idempotency-Key` header of up to 128 characters. A repeat gets the stored response with `Idempotent-Replay: true`. Keys are kept for at least 24h, and reusing a key on another route returns `400 invalid`.
- **Errors.** Every error has the shape `{ "error": { "code", "message" } }`. Codes: `unauthorized` 401, `not_found` 404, `invalid` 400, `busy` 409 (reject-if-busy), `conflict` 409 (stale App State revision), `ambiguous` 409, `unavailable` 503 (session failed to open), `internal` 500. Clients can also see `offline`: the SDK raises it when a device cannot be reached, and the hub's proxy returns it with 502.
- **Versioning.** `/v1` and `apiVersion: 1` in `GET /v1/device` and in every `hello` frame. Changes inside v1 are additive.

## Routes

| Route | Body / query | Returns |
|---|---|---|
| `GET /healthz` | (no auth) | `{ok:true}` |
| `GET /v1/device` | | `DeviceInfo`: uid, name, hostname, platform, `apiVersion`, `durableVersion`, `startedAt`, models, `defaultModel`, `startDirs`, storage, `codeDir` (the checkout it runs from), capabilities, `jobs` (durable job definitions) |
| `GET /v1/tree` | | `DeviceTree`: sessions with agents and busy/background, plus `clients` and `projects` |
| `GET /v1/clients` | | `ClientSummary[]` `{slug, name, createdAt}`, sorted by name |
| `PUT /v1/clients/:client` | `{name}` | `ClientSummary`. Creates the client or renames it; repeating the call changes nothing. Ids are lowercase letters, digits and dashes (max 48) |
| `GET /v1/projects` | | `ProjectSummary[]` `{client, slug, name, createdAt}` |
| `PUT /v1/projects/:client/:project` | `{name, clientName?}` | `ProjectSummary`. Creates the project (and its client, named `clientName`, when missing) or renames it. The ref `<client>/<project>` is the project's id on every device: register it on each device that runs one of its environments |
| `GET /v1/projects/:client/:project` | | the project plus `sessions` (ids on this device) |
| `GET /v1/events` | `?docs=app.shared-state` | device stream |
| `GET /v1/fs/dirs` | `?path=` (empty = start dirs) | `{path, parent, dirs[]}`, one level, directories only |
| `GET /v1/docs/app.shared-state` | | `{kind, value, revision}` |
| `GET /v1/sessions` | | `SessionSummary[]` |
| `POST /v1/sessions` | `{name, cwd, model:{provider,modelId}, thinkingLevel?, project?, env?, team?}` | `201 SessionSummary`. `team` gives the root agent a team to lead (default: on for sessions in a project). `project` is `<client>/<project>` and must exist on this device (`404` otherwise); `env` is `dev`, `staging` or `prod` and defaults to `dev`; `env` without `project` is `400` |
| `GET / PATCH / DELETE /v1/sessions/:s` | PATCH `{name?, project?, env?}` (`project: null` moves it out of its project) | summary (with its `compaction` thresholds); DELETE aborts all work, moves the files to `archive/` and returns `{archived}` |
| `GET / PATCH /v1/sessions/:s/team` | PATCH `{enabled?, models?: {<role>: modelId \| null}}` | `TeamInfo` `{enabled, roles[]}`: the Lead (the root agent, with the `delegate` tool) and its members `api`, `backend`, `frontend`, `tester`, `reviewer`, `security`, `ops`, each with its tools, default model and current model. A member's model applies from its next delegation; `null` restores the default; `lead` changes the root agent's model |
| `GET / PATCH /v1/sessions/:s/compaction` | PATCH `{enabled?, reserveTokens?, backgroundTokens?, keepRecentTokens?}` | the session's automatic compaction thresholds, read by pi-durable at its next request. Values are margins: the blocking summary starts at the model's context window minus `reserveTokens`, and the background one `backgroundTokens` earlier (0 turns it off). Default: a background summary at 200k tokens and a blocking one at 250k, or pi-durable's margins on smaller windows. Switching an agent to a window the thresholds do not fit refits them |
| `GET /v1/sessions/:s/events` | | session stream |
| `GET /v1/sessions/:s/tasks` | `?status=live\|terminal&limit=` | task nodes / recent outcomes |
| `POST /v1/sessions/:s/tasks/:taskId/abort` | | `{status}` |
| `GET /v1/sessions/:s/inspect` | | recovery inspection |
| `GET /v1/sessions/:s/submissions/:id` | `?waitMs=` (≤300000) | `SendResult`, optionally long-polled |
| `GET / POST /v1/sessions/:s/agents` | POST `{from?, name?}` | `AgentSummary[]` / `201 AgentSummary` |
| `GET / PATCH .../agents/:a` | PATCH `{name}` | `AgentDetail` (config with `readOnly`, every tool with `replay`, `writes` and `offered`, extensions) / summary |
| `GET .../agents/:a/events` | `?docs=demo.job-runs` | agent stream |
| `GET .../agents/:a/entries` | `?scope=all\|active&cursor=&limit=` | `{items, next}` stored history; `limit` defaults to 500 (max 2000). `scope=active` returns `{items}`, the active context, unpaged |
| `GET .../agents/:a/transcript` | `?format=json\|markdown` | normalized transcript |
| `POST .../agents/:a/messages` | `{content, whenBusy?: followUp\|steer\|reject, requestId, waitMs?}` (`whenBusy` defaults to `followUp`; `waitMs` ≤300000) | `202 {submissionId, status:"queued"\|"pending"}`, `200 {status:"done", answer:{entryId,text}}` or `200 {status:"unanswered", reason}` |
| `DELETE .../agents/:a/inbox/:submissionId` | | withdraw a queued input |
| `POST .../agents/:a/abort` | `{background?}` | stops foreground work (and background with `true`) |
| `POST .../agents/:a/fork` | `{entryId, name?}` | `201 AgentSummary` |
| `GET / PATCH .../agents/:a/config` | `{model?, thinkingLevel?, instructions?, cwd?, readOnly?}` | config; applies from the next request. `readOnly` filters the agent's tools to the ones that only read |
| `GET / PATCH .../agents/:a/extensions` | PATCH `{name, enabled}` or `{prompt, enabled}` | `{extensions, builtIn}`: the custom extensions `system-prompts` (a checklist of the prompts in `prompts/`) and `jev-damage-control` (Jev judges each bash command and blocks destructive ones; the command goes to the Jev API, and a Jev error lets it run). Both are off by default. A change applies from the agent's next request |
| `POST .../agents/:a/compact` | `{instructions?}` | `{taskId}` |
| `POST .../agents/:a/reset` | `{note?}` | `{ok}` |
| `GET .../agents/:a/docs/:kind` | `demo.job-runs` | `{kind, value}` |
| `POST .../agents/:a/demo/state` | `{operation, path, value?, expectedRevision?}` | `{ok, value, revision}`: the new App State. A stale `expectedRevision` returns `409 conflict` |
| `POST .../agents/:a/demo/jobs` | `{job, input?}` | `201 {taskId}`: a durable job run the conversation owns in the background, anchored by a `demo.job` entry |
| `POST .../agents/:a/demo/jobs/:taskId/approval` | `{approved}` | `{ok}`; `409 conflict` when the run is not waiting |

## Watch and fix

One device watches a project's production. Every minute (`ANTH_WATCH_INTERVAL_MS`, `0` turns the timer off) it collects events, Jev judges each one (`normal`, `suspicious` or `incident` plus an impact score; rules take over when Jev is unreachable), and code applies the rule: three `incident` verdicts with one fingerprint within ten minutes, or two failed uptime checks, open one incident. An incident gets an incident agent in the watch session: a team Lead named `Incident #<n>`, working in a git worktree `<repo parent>/.anth-incidents/<repo>-inc-<n>` on branch `incident/inc-<n>` from the default branch. Its `submit_fix {test_command, summary}` tool proves the fix (the changed tests fail on the base branch and pass on the incident branch) and only then starts the `ship` job, which waits for your approval before production. A completed ship resolves the incident; a declined or failed one marks it `needs-you`.

| Route | Body / query | Returns |
|---|---|---|
| `GET / PUT / DELETE /v1/projects/:client/:project/watch` | PUT `{sessionId, url, path?, paths?, vercel?, enabled?}` | `WatchInfo`: the session that holds the repository (`path` is the repository folder relative to it), the production `url`, the `paths` checked every tick, whether `vercel logs` is read (needs `VERCEL_TOKEN`), and `webhookPath` |
| `POST /v1/projects/:client/:project/watch/tick` | | `{events, errors}`: collect, judge and apply the rule now |
| `GET /v1/projects/:client/:project/watch/events` | `?limit=` | newest `WatchEvent`s with verdict, impact and incident |
| `GET /v1/projects/:client/:project/incidents`, `GET /v1/incidents` | | `Incident[]`: status `fixing`, `shipping`, `resolved` or `needs-you`, worktree, branch, agent, ship run |
| `POST /hooks/:client/:project/:secret` | any JSON object or array (Sentry webhooks, `{message, level, path, status}`) | `202 {accepted, new}`; no bearer token, the secret in `webhookPath` is the key; a wrong secret is `404` |

Sources: `vercel-log` and `vercel-request` (`vercel logs runtime --query 'level:error OR level:fatal'` and `vercel logs requests --query 'httpStatus >= 500'` for production, since the last tick), `uptime` (each path: down, 5xx or slower than 8 s), and `webhook`. The project tree's `projects[].watch` reports `{enabled, openIncidents}` for badges.

## Agent tools

Every agent gets the coding tools `read`, `write`, `edit` and `bash`, plus the playground tools `read_state`, `update_state`, `list_durable_jobs`, `run_durable_job`, `check_durable_job`, `search_history`, `ping_on_call_engineer`, `subagent`, `start_session` and `handoff`. A team Lead also gets `delegate`. `readOnly` removes the nine that write: `bash`, `write`, `edit`, `update_state`, `run_durable_job`, `ping_on_call_engineer`, `subagent`, `start_session` and `delegate`. `GET .../agents/:a` lists each tool with its replay policy and whether it is offered.

`delegate({role, task})` runs one team member as a child conversation owned by the tool call: the role's model (`PATCH .../team`), only the role's tools (reviewer and security get `read` and `bash`; the others also `write` and `edit`), and the role's prompt from `src/team.ts`. It returns the member's final report. Members appear in the tree as subagents named after their role. A restart finds the same member and resumes it; a member's cut-off `bash` call comes back as interrupted.

## Durable jobs

A durable job is a repeatable workflow with named phases. Each run is one pi-durable task (`demo.job.<id>`) whose checkpoint phases are the job's phases, so a restart resumes the current phase. The run's record, with every phase and step (commands, a subagent's tool calls, App State writes, checkpoints, the approval), is the conversation document `demo.job-runs`; types are in [`../anth-sdk/src/jobs.ts`](../anth-sdk/src/jobs.ts). Every run saves its result to App State under `/jobs/<id>`.

| Job | Phases | Inputs |
|---|---|---|
| `workspace-snapshot` | scan → measure → save → verify | `path` |
| `release-check` | plan → gather (subagent with read and bash) → approve (waits for a person) → publish → verify | `commits` |
| `change-watch` | baseline → watch (one checkpoint per check) → report | `path`, `checks`, `interval_seconds` |
| `ship` | prepare (commit to `anth/ship-<n>-<task>`) → build and test (install, then the `lint`, `typecheck`, `build`, `test` scripts that exist) → review (the team's reviewer and security on `git diff <base>...HEAD`; "VERDICT: changes requested" stops the run) → preview (`vercel deploy`) → check preview (HTTP) → pull request (push, then open or reuse the PR) → **approve** → promote (`vercel promote <preview>`) → verify production (HTTP) | `path`, `base`, `title`, `production_url`, `health_path`, `github_repo` (each `auto` by default: the current branch or `main`, `anth.json`'s `productionUrl` and `healthPath`, the `origin` remote) |
| `rollback` | **approve** → roll back (`vercel rollback`) → verify production | `path`, `production_url`, `health_path` |

**App servers.** When the project's `anth.json` has `"deploy": {"target": "server", "host": "<ip>", "app": "<name>"}`, preview sends the committed tree (`git archive`) over SSH to `anth-deploy preview <app> <commit>` on the server (Docker build, run on the preview slot, health check), promote runs `anth-deploy promote <app> <commit>` (the same image on the idle production slot, health check, Caddy switch, old slot stopped) and rollback runs `anth-deploy rollback <app>`. The key comes from `ANTH_DEPLOY_SSH_KEY` (base64 of the private key), lives in a 0600 temp file only for that command, and on the server is a forced command that can run nothing but `anth-deploy`. See [`../../docs/HETZNER.md`](../../docs/HETZNER.md).

`ship` and `rollback` read `VERCEL_TOKEN`, `GITHUB_TOKEN`, and optionally `VERCEL_SCOPE` and `VERCEL_AUTOMATION_BYPASS_SECRET` from the device's environment (`env_keys` in `anth-network.yaml`). Their deploy and GitHub steps run in the backend process, so agents never see these values, and they are masked in step output. Agents' own commands never inherit the backend's environment: they get only `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM` and `TZ`. A project can keep its production URL and health path in `anth.json` at its root: `{"productionUrl": "https://…", "healthPath": "/api/health"}`.

Agents use the playground tools: `list_durable_jobs` (ids, phases, inputs, approval, result path and recent runs with their task ids), `run_durable_job {job, input?, wait?}` and `check_durable_job {task_id? | job?}` (one run's phases, steps and result, a job's latest run, or recent runs). A run starts in the background, owned by the conversation; with `wait: true` the call owns it and waits, so an interrupt stops it. The same extension adds `search_history {query?, tool?, entry?, kind?, from_entry?, to_entry?, order?, limit?, offset?}`, which pages through the agent's whole stored history including entries before a reset or compaction, and `ping_on_call_engineer {summary, severity?}`, a simulated pager (no external call) that is not replay-safe and works once per agent.

## Streams

Server-Sent Events. Each connection sends `hello`, then a snapshot, then deltas, plus a `: ping` comment every 15s. Treat 45s of silence as a dead socket. Reconnects get a fresh snapshot and nothing is replayed (pi-durable's watch semantics). A viewer that falls 2 MB behind is disconnected. Closing a stream never stops work.

```
id: 7
event: batch
data: {"type":"batch","events":[{"type":"message_update", ...}]}
```

| Scope | Frames |
|---|---|
| device `/v1/events` | `tree {tree}` (deduped, coalesced 250ms), `activity {items:[{type:"agent.started"\|"agent.finished", sessionId, agentId, at, preview?}]}`, `doc {kind, value, revision}` |
| session `/v1/sessions/:s/events` | `session {agents, tasks, usage}`, then `agents`, `tasks`, `usage` |
| agent `.../agents/:a/events` | `snapshot {snapshot, inbox}`, `batch {events}` (pi-durable `watchEvents()` verbatim), `inbox {items}` (queued content), `doc {kind, value}` |
| all | `hello {apiVersion, scope, serverTime}` |

The hub's multiplexed stream (`/api/stream`) carries these frames per subscription and adds `stream {streamId}`, `network {devices}`, `fault {error}` and `disconnected {reason}`.

To render a transcript from the agent stream in JS, feed frames to `AgentModel` from the SDK. It handles text/thinking/tool-call deltas, tool output windows, results, resets and overflow snapshots.

## Recipes

```bash
T=<token>; U=https://my-anth-vm-1.exe.xyz   # any device URL from anth-network.yaml
# Send work and wait for the answer, all in one request:
curl -s -X POST $U/v1/sessions/my-session/agents/main/messages -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"content":"Summarize the failing tests","requestId":"ci-4812","waitMs":120000}'
# Read the whole conversation as markdown:
curl -s "$U/v1/sessions/my-session/agents/main/transcript?format=markdown" -H "Authorization: Bearer $T" | jq -r .text
# Watch everything on a device:
curl -sN $U/v1/events -H "Authorization: Bearer $T"
# A client project with a prod session on this device (PUT is safe to repeat):
curl -s -X PUT $U/v1/projects/dental-co/booking-site -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"name":"Booking site","clientName":"Dental Co"}'
curl -s -X POST $U/v1/sessions -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"name":"On call","cwd":"~/anth-work","model":{"provider":"openrouter","modelId":"anthropic/claude-sonnet-5.5"},"project":"dental-co/booking-site","env":"prod"}'
```

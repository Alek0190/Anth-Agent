# Running on Hetzner: an app server and an always-on agent box

Two small Hetzner Cloud servers:

| Server | Runs | Why separate |
|---|---|---|
| `anth-app` | your products (e.g. anthwebbuilder) in Docker, behind Caddy with automatic HTTPS | a device token is a shell: agents never share a machine with your users' data |
| `anth-agents` | Anth-Agent's backend: sessions, the team, the watcher, webhooks | always on, so watching and fixing work while your laptop sleeps |

The ship job deploys to `anth-app` over SSH with a key that can only run `anth-deploy` (preview, promote, rollback, status). Production still waits for your approval.

## 1. Create the servers

1. In the [Hetzner Cloud console](https://console.hetzner.cloud), create a project and add your laptop's SSH public key.
2. Create two servers with **Ubuntu 24.04**, the smallest shared-vCPU type is enough to start, same location:
   - `anth-app`
   - `anth-agents`
3. Note both IP addresses.

## 2. Point your domain at the app server

At your domain registrar, for `anthwebbuilder.com`, add three **A** records to the `anth-app` IP:

| Name | Type | Value |
|---|---|---|
| `@` | A | app server IP |
| `www` | A | app server IP |
| `preview` | A | app server IP |

## 3. Set up the app server (once)

From the Anth-Agent folder on your laptop (WSL):

```bash
just server keygen
```

This makes `~/.anth/anth_deploy` (the deploy key) and adds `ANTH_DEPLOY_SSH_KEY=…` to `.env`.

```bash
just server setup root@APP_IP anthwebbuilder "anthwebbuilder.com, www.anthwebbuilder.com" preview.anthwebbuilder.com 18000 ~/.anth/anth_deploy.pub
```

It installs Docker and Caddy, creates the user `anth`, installs `anth-deploy`, and lets the deploy key run only that. Open `https://anthwebbuilder.com`: it should say **Coming soon** with a valid certificate. Options: `--app-port 3000` (the port your app listens on inside the container), `--health-path /`, `--data-dir /app/data` (where the app keeps files that must survive releases).

App secrets (database URL, API keys) go on the server, never in the repo:

```bash
ssh root@APP_IP nano /srv/anth/anthwebbuilder/env          # production, KEY=value lines
ssh root@APP_IP nano /srv/anth/anthwebbuilder/preview.env  # preview
```

## 4. Prepare the project

1. Push the project to GitHub (for example `Alek0190/anthwebbuilder`).
2. Add `anth.json` at its root:

   ```json
   {
     "productionUrl": "https://anthwebbuilder.com",
     "healthPath": "/",
     "deploy": { "target": "server", "host": "APP_IP", "app": "anthwebbuilder" }
   }
   ```

3. Add a `Dockerfile` (or ask the Lead: "add a Dockerfile for the app server"). For a Node app like anthwebbuilder:

   ```dockerfile
   FROM node:24-alpine
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci
   COPY . .
   RUN npm run build && npm prune --omit=dev
   ENV PORT=3000
   EXPOSE 3000
   CMD ["node", "server/server.js"]
   ```

   Files the app writes must live under `/app/data` (the `--data-dir`), which survives every release.

## 5. Move Anth-Agent onto the agent box

1. Install [Tailscale](https://tailscale.com) on your laptop and on `anth-agents` (`curl -fsSL https://tailscale.com/install.sh | sh && tailscale up`). The device API then travels inside your private network, never as plain HTTP over the internet.
2. In `anth-network.yaml` add:

   ```yaml
   devices:
     hetzner:
       name: Hetzner agents
       kind: ssh
       ssh: root@AGENT_IP
       service: systemd
       url: http://TAILSCALE_IP:4780
       start_dirs: ["~/anth-work"]
   ```

3. Send it every key it needs:

   ```yaml
   defaults:
     env_keys: [OPENROUTER_API_KEY, TYPESAFE_API_KEY, GITHUB_TOKEN, VERCEL_TOKEN, ANTH_DEPLOY_SSH_KEY]
   ```

4. `just net up hetzner`. In the hub, `hetzner` appears online.
5. On the agent box, set the git author to your Vercel/GitHub email (`ssh root@AGENT_IP git config --global user.email you@example.com`) and clone the project into `~/anth-work`.
6. In the hub, create a session on `hetzner` in the project, then **Watch** → production URL → **Start watching**.
7. Block the backend port from the internet: `ssh root@AGENT_IP 'ufw allow 22/tcp && ufw allow in on tailscale0 && ufw enable'`.

### Webhooks (optional)

Webhooks need one public HTTPS path into the agent box. Install Caddy there and expose only `/hooks/*`:

```caddyfile
hooks.anthwebbuilder.com {
	handle /hooks/* {
		reverse_proxy 127.0.0.1:4780
	}
	respond 404
}
```

Add an **A** record `hooks` → agent box IP, and use `https://hooks.anthwebbuilder.com<webhookPath>` from the Watch tab.

## Day to day

- **Ship:** ask the Lead, or Tasks → Ship. Preview at `https://preview.anthwebbuilder.com`, a pull request on GitHub, then **Approve production**.
- **Rollback:** Tasks → Roll back production → approve. Takes seconds: the previous image is still on the server.
- **Status:** `just server status APP_IP anthwebbuilder`.
- **Logs:** `ssh root@APP_IP docker logs --tail 100 anth-anthwebbuilder-0` (or `-1`, whichever slot is current).

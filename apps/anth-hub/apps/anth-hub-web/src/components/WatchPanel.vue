<script setup lang="ts">
// Watch and fix for the selected session's project: set up watching production, see Jev's verdict on every event,
// and follow incidents to their incident agent and ship run.
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { Eye, RefreshCw, Siren } from "lucide-vue-next";
import type { Incident, WatchEvent, WatchInfo } from "@sdk/api";
import { isAnthError } from "@sdk/errors";
import { deviceClient } from "../client/hub";
import {
  ago,
  attempt,
  device,
  deviceId,
  notify,
  online,
  select,
  sessionSummary,
} from "../client/store";

const project = computed(() => sessionSummary.value?.project);
const parts = computed(() => project.value?.split("/") as [string, string] | undefined);
const info = shallowRef<WatchInfo | null>();
const events = shallowRef<WatchEvent[]>([]);
const incidents = shallowRef<Incident[]>([]);
const busy = ref(false);
const blank = () => ({ url: "", paths: "/", path: ".", vercel: true, serverLogs: false });
const form = ref(blank());

/** Forget everything shown for another project, so its incidents or URL never appear under this one. */
let shown: string | undefined;
let filled: string | undefined;
function resetFor(key: string | undefined) {
  if (key === shown) return;
  shown = key;
  filled = undefined;
  info.value = undefined;
  events.value = [];
  incidents.value = [];
  form.value = blank();
}

/** Load the watch, its events and incidents for the selected project. */
async function load() {
  const id = deviceId.value;
  const key = id && project.value ? `${id}:${project.value}` : undefined;
  resetFor(key);
  if (!id || !parts.value || !online.value) return void (info.value = undefined);
  const client = deviceClient(id);
  const [c, p] = parts.value;
  let next: WatchInfo | null;
  try {
    next = await client.watch(c, p);
  } catch (e) {
    if (!(isAnthError(e) && e.code === "not_found")) return;
    next = null;
  }
  // The selection may have moved on while this request was in flight.
  if (key !== shown) return;
  info.value = next;
  if (!next) {
    events.value = [];
    incidents.value = [];
    return;
  }
  if (info.value) {
    // Fill the form once per project: the 15-second refresh must not overwrite what you are typing.
    if (filled !== key)
      form.value = {
        url: info.value.url,
        paths: info.value.paths.join(", "),
        path: info.value.path,
        vercel: info.value.vercel,
        serverLogs: info.value.serverLogs,
      };
    filled = key;
    const [e, i] = await Promise.allSettled([client.watchEvents(c, p, 40), client.incidents(c, p)]);
    if (key !== shown) return;
    if (e.status === "fulfilled") events.value = e.value;
    if (i.status === "fulfilled") incidents.value = i.value;
  }
}
watch(
  [deviceId, project, online, () => JSON.stringify(sessionSummary.value?.agents.length)],
  load,
  { immediate: true },
);
const timer = setInterval(() => void load(), 15_000);
onBeforeUnmount(() => clearInterval(timer));

async function save(enabled = true) {
  const id = deviceId.value;
  const session = sessionSummary.value;
  if (!id || !parts.value || !session || busy.value) return;
  busy.value = true;
  try {
    const paths = form.value.paths
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => (p.startsWith("/") ? p : `/${p}`));
    const next = await attempt(() =>
      deviceClient(id).putWatch(parts.value![0], parts.value![1], {
        sessionId: session.id,
        url: form.value.url.trim(),
        paths: paths.length ? paths : ["/"],
        path: form.value.path.trim() || ".",
        // A new watch reads the logs of wherever anth.json says the project ships; after that, the switches decide.
        ...(info.value ? { vercel: form.value.vercel, serverLogs: form.value.serverLogs } : {}),
        enabled,
      }),
    );
    if (next) {
      info.value = next;
      notify(
        enabled
          ? `Watching ${next.url}. Incidents open agents in this session.`
          : "Watching paused.",
      );
    }
  } finally {
    busy.value = false;
  }
}

async function tick() {
  const id = deviceId.value;
  if (!id || !parts.value || busy.value) return;
  busy.value = true;
  try {
    const r = await attempt(() => deviceClient(id).watchTick(parts.value![0], parts.value![1]));
    if (r)
      notify(
        r.errors.length
          ? `Checked with errors: ${r.errors[0]}`
          : `Checked: ${r.events} new event${r.events === 1 ? "" : "s"}.`,
      );
    await load();
  } finally {
    busy.value = false;
  }
}

const webhook = computed(() =>
  info.value && device.value
    ? `${device.value.url.replace(/\/+$/, "")}${info.value.webhookPath}`
    : "",
);
async function copyWebhook() {
  await navigator.clipboard?.writeText(webhook.value).catch(() => {});
  notify("Webhook URL copied. Keep it secret: anyone with it can send events.");
}

function openAgent(i: Incident) {
  if (deviceId.value && i.conversationId !== undefined)
    select({ deviceId: deviceId.value, sessionId: i.sessionId, agentId: i.conversationId });
}

const statusLabel: Record<Incident["status"], string> = {
  fixing: "Agent fixing",
  shipping: "Shipping, waits for you",
  resolved: "Resolved",
  "needs-you": "Needs you",
};
const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
</script>

<template>
  <div class="extensions-panel watch-panel">
    <div class="panel-heading">
      <h2>Watch and fix</h2>
      <Eye :size="18" />
    </div>
    <p v-if="!project" class="hint">
      Move this session into a project to watch its production. Incidents open an agent here that
      fixes them on a branch and ships after your approval.
    </p>
    <p v-else-if="info === undefined" class="task-empty">Loading…</p>
    <template v-else>
      <p class="hint">
        Every minute: Vercel production errors and 5xx requests, and uptime checks on your pages.
        Jev judges each event; three incidents with one cause (two failed checks) open an incident
        agent in this session.
      </p>
      <form class="ext-card watch-form" :class="{ on: info?.enabled }" @submit.prevent="save(true)">
        <label
          >Production URL<input
            v-model="form.url"
            placeholder="https://www.example.com"
            aria-label="Production URL"
        /></label>
        <label
          >Pages to check<input
            v-model="form.paths"
            placeholder="/, /contact"
            aria-label="Pages to check"
        /></label>
        <label
          >Repository folder<input
            v-model="form.path"
            placeholder="."
            aria-label="Repository folder"
        /></label>
        <template v-if="info">
          <label class="check"
            ><input v-model="form.serverLogs" type="checkbox" aria-label="Read server logs" />Read
            server logs (an app server in anth.json; emails, IPs and tokens removed)</label
          >
          <label class="check"
            ><input v-model="form.vercel" type="checkbox" aria-label="Read Vercel logs" />Read
            Vercel logs (needs VERCEL_TOKEN)</label
          >
        </template>
        <p v-else class="hint">
          Logs are read from where the project ships: its app server or Vercel, as its anth.json
          says.
        </p>
        <div class="watch-actions">
          <button class="primary" :disabled="busy || !form.url.trim()">
            {{ info ? "Save" : "Start watching" }}
          </button>
          <button
            v-if="info?.enabled"
            type="button"
            class="secondary"
            :disabled="busy"
            @click="save(false)"
          >
            Pause
          </button>
          <button
            v-if="info"
            type="button"
            class="secondary"
            :disabled="busy"
            aria-label="Check now"
            @click="tick"
          >
            <RefreshCw :size="16" />Check now
          </button>
        </div>
        <p v-if="info" class="meta">
          {{ info.enabled ? "Watching" : "Paused" }} · last check
          {{ info.lastTickAt ? ago(info.lastTickAt) : "never" }}
          <span v-if="info.lastError" class="err"> · {{ info.lastError }}</span>
        </p>
      </form>
      <div v-if="info" class="ext-card">
        <strong>Webhook</strong>
        <p class="meta">
          Other services can POST JSON events here (the device must be reachable from the internet).
        </p>
        <code class="webhook" @click="copyWebhook">{{ webhook }}</code>
      </div>

      <h3 v-if="info" class="watch-h"><Siren :size="16" />Incidents</h3>
      <p v-if="info && !incidents.length" class="task-empty">No incidents.</p>
      <article
        v-for="i in incidents"
        :key="i.id"
        class="ext-card incident"
        :class="i.status"
        :data-incident="i.id"
      >
        <div class="ext-head">
          <div>
            <strong>#{{ i.id }} {{ i.title }}</strong>
            <span class="incident-status">{{ statusLabel[i.status] }}</span>
          </div>
        </div>
        <p class="meta">{{ i.events }} events · opened {{ ago(i.openedAt) }} · {{ i.branch }}</p>
        <p v-if="i.note" class="meta">{{ i.note }}</p>
        <button v-if="i.conversationId !== undefined" class="secondary" @click="openAgent(i)">
          Open incident agent
        </button>
      </article>

      <h3 v-if="info" class="watch-h">Events</h3>
      <p v-if="info && !events.length" class="task-empty">
        No events yet. Healthy checks leave no trace.
      </p>
      <ul v-if="events.length" class="watch-events">
        <li v-for="e in events" :key="e.id" :class="e.verdict ?? 'pending'">
          <span class="when">{{ time(e.at) }}</span>
          <span class="verdict">{{ e.verdict ?? "judging" }}</span>
          <span class="src">{{ e.source }}</span>
          <span class="msg" :title="e.fingerprint">{{ e.message }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

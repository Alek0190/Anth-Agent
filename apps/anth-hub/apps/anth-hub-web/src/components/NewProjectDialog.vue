<script setup lang="ts">
import { computed, ref } from "vue";
import { FolderPlus, X } from "lucide-vue-next";
import { slugify } from "@sdk/api";
import { clientKey, projectKey } from "@sdk/models";
import { deviceClient, message } from "../client/hub";
import { knownClients, knownProjects, network, notify, toggle, ui } from "../client/store";

const props = defineProps<{ client?: string }>();
const emit = defineEmits<{ close: [] }>();

const NEW = "__new";
const devices = computed(() => network.devices.value.filter((d) => d.status === "online"));
const clientSlug = ref(
  knownClients.value.find((c) => c.slug === props.client)?.slug ??
    knownClients.value[0]?.slug ??
    NEW,
);
const clientName = ref("");
const projectName = ref("");
const deviceId = ref(devices.value[0]?.id ?? "");
const pending = ref(false);
const error = ref("");

const client = computed(() =>
  clientSlug.value === NEW ? slugify(clientName.value) : clientSlug.value,
);
const slug = computed(() => slugify(projectName.value));
const fullRef = computed(() => (client.value && slug.value ? `${client.value}/${slug.value}` : ""));
const exists = computed(() => knownProjects.value.some((p) => p.ref === fullRef.value));

async function create() {
  if (pending.value || !fullRef.value || exists.value || !deviceId.value) return;
  pending.value = true;
  error.value = "";
  try {
    const created = await deviceClient(deviceId.value).putProject(client.value, slug.value, {
      name: projectName.value.trim(),
      clientName: clientSlug.value === NEW ? clientName.value.trim() : undefined,
    });
    toggle(clientKey(created.client), true);
    toggle(projectKey(fullRef.value), true);
    notify(`Project ${created.name} created. Now start its first session.`);
    ui.dialog = {
      kind: "new-session",
      deviceId: deviceId.value,
      project: fullRef.value,
      env: "dev",
    };
  } catch (e) {
    error.value = message(e);
    pending.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <form class="modal session-modal" @submit.prevent="create">
      <header>
        <div>
          <span class="eyebrow">ONE PRODUCT FOR ONE CLIENT</span>
          <h2>New project</h2>
        </div>
        <button
          type="button"
          class="icon-button"
          aria-label="Close new project"
          @click="emit('close')"
        >
          <X :size="18" />
        </button>
      </header>
      <p v-if="!devices.length" class="message-error">
        No device is online. Start one with just backend run or just net up &lt;id&gt;, then try
        again.
      </p>
      <template v-else>
        <label
          >Client<select v-model="clientSlug" aria-label="Client">
            <option v-for="c in knownClients" :key="c.slug" :value="c.slug">{{ c.name }}</option>
            <option :value="NEW">+ New client…</option>
          </select></label
        >
        <label v-if="clientSlug === NEW"
          >Client name<input v-model="clientName" placeholder="Dental Co" maxlength="100" autofocus
        /></label>
        <label
          >Project name<input
            v-model="projectName"
            placeholder="Booking site"
            maxlength="100"
            :autofocus="clientSlug !== NEW"
        /></label>
        <label
          >Register on device<select v-model="deviceId" aria-label="Register on device">
            <option v-for="d in devices" :key="d.id" :value="d.id">
              {{ d.id }} · {{ d.info?.hostname ?? d.url }}
            </option>
          </select></label
        >
        <p class="hint">
          <template v-if="fullRef"
            >Id <code>{{ fullRef }}</code
            >. </template
          >Other devices join the project when you start a session there.
        </p>
        <p v-if="exists" class="message-error" role="alert">{{ fullRef }} already exists.</p>
      </template>
      <p v-if="error" class="message-error" role="alert">{{ error }}</p>
      <footer>
        <button type="button" class="secondary" @click="emit('close')">Cancel</button
        ><button class="primary" :disabled="pending || !fullRef || exists || !deviceId">
          <FolderPlus :size="18" />{{ pending ? "Creating…" : "Create project" }}
        </button>
      </footer>
    </form>
  </div>
</template>

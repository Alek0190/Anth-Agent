<script setup lang="ts">
import { computed, ref } from "vue";
import { ArrowRightLeft, X } from "lucide-vue-next";
import { ENVIRONMENTS, type EnvironmentName } from "@sdk/api";
import { deviceClient, message } from "../client/hub";
import { placementKeys, sessionKey } from "@sdk/models";
import { ensureProject, knownProjects, network, notify, toggle } from "../client/store";

const props = defineProps<{ deviceId: string; sessionId: string }>();
const emit = defineEmits<{ close: [] }>();

const session = computed(() =>
  network.devices.value
    .find((d) => d.id === props.deviceId)
    ?.tree?.sessions.find((s) => s.id === props.sessionId),
);
const project = ref(session.value?.project ?? knownProjects.value[0]?.ref ?? "");
const env = ref<EnvironmentName>(session.value?.env ?? "dev");
const pending = ref(false);
const error = ref("");

async function save() {
  if (pending.value) return;
  pending.value = true;
  error.value = "";
  try {
    const handle = deviceClient(props.deviceId).session(props.sessionId);
    if (project.value) await ensureProject(props.deviceId, project.value);
    const moved = await handle.update(
      project.value ? { project: project.value, env: env.value } : { project: null },
    );
    // Open the session's new place in the tree.
    const keys = moved.project
      ? placementKeys(moved.project, moved.env ?? "dev")
      : [props.deviceId];
    for (const key of [...keys, sessionKey(props.deviceId, props.sessionId)]) toggle(key, true);
    notify(
      project.value ? `Moved to ${project.value} · ${env.value}.` : "Moved out of its project.",
    );
    emit("close");
  } catch (e) {
    error.value = message(e);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <form class="modal session-modal" @submit.prevent="save">
      <header>
        <div>
          <span class="eyebrow">{{ session?.name ?? "SESSION" }} ON {{ deviceId }}</span>
          <h2>Move to a project</h2>
        </div>
        <button
          type="button"
          class="icon-button"
          aria-label="Close move session"
          @click="emit('close')"
        >
          <X :size="18" />
        </button>
      </header>
      <label
        >Project<select v-model="project" aria-label="Project">
          <option value="">No project</option>
          <option v-for="p in knownProjects" :key="p.ref" :value="p.ref">
            {{ p.client.name }} / {{ p.project.name }}
          </option>
        </select></label
      >
      <label v-if="project"
        >Environment<select v-model="env" aria-label="Environment">
          <option v-for="e in ENVIRONMENTS" :key="e" :value="e">{{ e }}</option>
        </select></label
      >
      <p class="hint">The session keeps running; only where it shows changes.</p>
      <p v-if="error" class="message-error" role="alert">{{ error }}</p>
      <footer>
        <button type="button" class="secondary" @click="emit('close')">Cancel</button
        ><button class="primary" :disabled="pending">
          <ArrowRightLeft :size="18" />{{ pending ? "Moving…" : "Move session" }}
        </button>
      </footer>
    </form>
  </div>
</template>

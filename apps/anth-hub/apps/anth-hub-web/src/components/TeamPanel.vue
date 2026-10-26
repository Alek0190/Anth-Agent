<script setup lang="ts">
// The session's agent team: a switch for the Lead's delegate tool and a model per role. Members appear in the tree as
// subagents of the Lead while they work; a model change applies from the next delegation.
import { computed, ref, shallowRef, watch } from "vue";
import { Users } from "lucide-vue-next";
import type { TeamInfo, TeamRoleId } from "@sdk/api";
import {
  attempt,
  device,
  online,
  refreshDetail,
  sessionHandle,
  sessionSummary,
} from "../client/store";

const data = shallowRef<TeamInfo>();
const busy = ref(false);
const models = computed(() => device.value?.info?.models ?? []);
const label = (id: string) => models.value.find((m) => m.id === id)?.name ?? id;

/** Fetch the team for the selected session. */
async function load() {
  const handle = sessionHandle.value;
  if (!handle || !online.value) return void (data.value = undefined);
  data.value = (await handle.team().catch(() => undefined)) ?? data.value;
}
watch([sessionHandle, online, () => sessionSummary.value?.team ?? false], load, {
  immediate: true,
});

/** Apply one change and show the device's answer. */
async function set(patch: {
  enabled?: boolean;
  models?: Partial<Record<TeamRoleId, string | null>>;
}) {
  const handle = sessionHandle.value;
  if (!handle || busy.value) return;
  busy.value = true;
  try {
    const next = await attempt(() => handle.setTeam(patch));
    if (next) data.value = next;
    void refreshDetail();
  } finally {
    busy.value = false;
  }
}

/** A member's select value: "" for its default model, else the override. */
const selected = (role: TeamInfo["roles"][number]) =>
  role.id === "lead" || role.custom ? role.model : "";

function choose(role: TeamInfo["roles"][number], value: string) {
  void set({ models: { [role.id]: role.id === "lead" ? value : value || null } });
}
</script>

<template>
  <div class="extensions-panel team-panel">
    <div class="panel-heading">
      <h2>Agent team</h2>
      <Users :size="18" />
    </div>
    <p class="hint">
      The main agent leads: it plans, then delegates each task to a member with its own model and
      tools. Each role is one row in the tree under the Lead, with every task it was given in one
      log, and every delegation survives restarts.
    </p>
    <p v-if="!data" class="task-empty">Loading the team…</p>
    <template v-else>
      <article class="ext-card" :class="{ on: data.enabled }" data-extension="team">
        <div class="ext-head">
          <div>
            <strong>Lead a team</strong>
            <code>delegate</code>
          </div>
          <button
            class="switch"
            role="switch"
            :class="{ on: data.enabled }"
            :aria-checked="data.enabled"
            aria-label="Lead a team"
            :disabled="busy"
            @click="set({ enabled: !data.enabled })"
          >
            <span />
          </button>
        </div>
        <p>Sessions in a project start with this on.</p>
      </article>
      <article
        v-for="role in data.roles"
        :key="role.id"
        class="ext-card team-role"
        :class="{ on: data.enabled, off: !data.enabled }"
        :data-role="role.id"
      >
        <div class="ext-head">
          <div>
            <strong>{{ role.title }}</strong>
            <code v-for="t in role.tools" :key="t">{{ t }}</code>
          </div>
        </div>
        <p>{{ role.summary }}</p>
        <label class="team-model"
          >Model<select
            :aria-label="`${role.title} model`"
            :value="selected(role)"
            :disabled="busy"
            @change="choose(role, ($event.target as HTMLSelectElement).value)"
          >
            <option v-if="role.id !== 'lead'" value="">
              Default · {{ label(role.defaultModel) }}
            </option>
            <option v-for="m in models" :key="m.id" :value="m.id">
              {{ m.tier }} / {{ m.name }}
            </option>
          </select></label
        >
      </article>
    </template>
  </div>
</template>

<script setup lang="ts">
// The earlier tasks of a team role, above the open member's own transcript: every task the Lead gave a role starts a
// fresh member conversation, and this shows them as one log. The newest few load on open; older ones on request.
import { computed, nextTick, reactive, ref, watch } from "vue";
import { History } from "lucide-vue-next";
import type { AgentSummary } from "@sdk/api";
import type { TranscriptItem as Item } from "@sdk/transcript";
import TranscriptItem from "./TranscriptItem.vue";
import { deviceClient } from "../client/hub";

const props = defineProps<{ deviceId: string; sessionId: string; members: AgentSummary[] }>();
const emit = defineEmits<{ open: [agentId: number]; fork: [agentId: number, entryId: number] }>();

const STEP = 3;
const shown = ref(STEP);
const logs = reactive(new Map<number, { items?: Item[]; error?: string }>());
const root = ref<HTMLElement>();
const visible = computed(() => props.members.slice(-shown.value));
const hidden = computed(() => props.members.length - visible.value.length);

watch(
  () => [props.deviceId, props.sessionId],
  () => {
    logs.clear();
    shown.value = STEP;
  },
);

/** Load what is missing; keep the reader's place (or the bottom, when they were there) as the log grows above it. */
async function load(members: AgentSummary[]) {
  const missing = members.filter((m) => !logs.has(m.id));
  if (!missing.length) return;
  const scroller = root.value?.closest<HTMLElement>(".chat-scroll");
  const before = scroller && {
    height: scroller.scrollHeight,
    top: scroller.scrollTop,
    bottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120,
  };
  for (const m of missing) if (!logs.has(m.id)) logs.set(m.id, {});
  await Promise.all(
    missing.map(async (m) => {
      try {
        const res = await deviceClient(props.deviceId)
          .agent(props.sessionId, m.id)
          .transcript("json");
        logs.set(m.id, { items: (res.items ?? []) as Item[] });
      } catch (e) {
        logs.set(m.id, { error: e instanceof Error ? e.message : String(e) });
      }
    }),
  );
  await nextTick();
  if (!scroller || !before) return;
  scroller.scrollTo({
    top: before.bottom ? scroller.scrollHeight : before.top + scroller.scrollHeight - before.height,
    behavior: "instant",
  });
}
watch(visible, (members) => void load(members), { immediate: true });

const number = (i: number) => hidden.value + i + 1;
</script>

<template>
  <section ref="root" class="role-history" :aria-label="`Earlier ${members[0]?.name} tasks`">
    <button v-if="hidden" type="button" class="role-more" @click="shown += STEP">
      <History :size="16" aria-hidden="true" />Show earlier tasks ({{ hidden }} more)
    </button>
    <template v-for="(m, i) in visible" :key="m.id">
      <div class="role-divider">
        <span
          >Task {{ number(i) }} · {{ m.name }} <span class="role-id">#{{ m.id }}</span></span
        >
        <button
          type="button"
          class="role-open"
          :title="`Open ${m.name} #${m.id} on its own`"
          @click="emit('open', m.id)"
        >
          Open
        </button>
      </div>
      <p v-if="logs.get(m.id)?.error" class="message-error">{{ logs.get(m.id)!.error }}</p>
      <p v-else-if="!logs.get(m.id)?.items" class="hint role-loading">
        Loading task {{ number(i) }}…
      </p>
      <p v-else-if="!logs.get(m.id)!.items!.length" class="hint role-loading">
        Nothing was said in this task.
      </p>
      <TranscriptItem
        v-for="item in logs.get(m.id)?.items ?? []"
        :key="`${m.id}:${item.id}`"
        :item="item"
        @fork="(entryId) => emit('fork', m.id, entryId)"
      />
    </template>
    <div class="role-divider current">
      <span>Task {{ members.length + 1 }} · this task</span>
    </div>
  </section>
</template>

<script setup lang="ts">
// The earlier tasks of a team role, above the open member's own transcript: every task the Lead gave a role starts a
// fresh member conversation, and this shows them as one log. The newest few load on open; older ones on request.
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { History } from "lucide-vue-next";
import type { AgentSummary } from "@sdk/api";
import type { TranscriptItem as Item } from "@sdk/transcript";
import TranscriptItem from "./TranscriptItem.vue";
import { deviceClient } from "../client/hub";

const props = defineProps<{ deviceId: string; sessionId: string; members: AgentSummary[] }>();
const emit = defineEmits<{ open: [agentId: number]; fork: [agentId: number, entryId: number] }>();

const STEP = 3;
/** How often the log of an earlier member that is still working is fetched again. */
const REFRESH_MS = 3000;
const shown = ref(STEP);
/** Each member's transcript, and whether the member was still working when it was fetched. */
const logs = reactive(new Map<number, { items?: Item[]; error?: string; busy?: boolean }>());
const root = ref<HTMLElement>();
const visible = computed(() => props.members.slice(-shown.value));
const hidden = computed(() => props.members.length - visible.value.length);
/** The session the logs belong to; a reply for another one is dropped. */
const scope = () => `${props.deviceId}/${props.sessionId}`;
const inflight = new Set<string>();

watch(scope, () => {
  logs.clear();
  shown.value = STEP;
});

/**
 * Whether a member's log should be fetched: never loaded, loaded while it worked and it has finished since (the final
 * entries), or, on a refresh, still working.
 */
function due(m: AgentSummary, refresh: boolean) {
  const log = logs.get(m.id);
  return !log || (!!log.busy && !m.busy) || (refresh && m.busy);
}

/** Load what is due; keep the reader's place (or the bottom, when they were there) as the log grows above it. */
async function load(members: AgentSummary[], refresh = false) {
  const at = scope();
  const wanted = members.filter((m) => !inflight.has(`${at}:${m.id}`) && due(m, refresh));
  if (!wanted.length) return;
  const scroller = root.value?.closest<HTMLElement>(".chat-scroll");
  const before = scroller && {
    height: scroller.scrollHeight,
    top: scroller.scrollTop,
    bottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120,
  };
  for (const m of wanted) {
    inflight.add(`${at}:${m.id}`);
    if (!logs.has(m.id)) logs.set(m.id, {});
  }
  await Promise.all(
    wanted.map(async (m) => {
      try {
        const res = await deviceClient(props.deviceId)
          .agent(props.sessionId, m.id)
          .transcript("json");
        if (scope() === at) logs.set(m.id, { items: (res.items ?? []) as Item[], busy: m.busy });
      } catch (e) {
        if (scope() === at)
          logs.set(m.id, { error: e instanceof Error ? e.message : String(e), busy: m.busy });
      } finally {
        inflight.delete(`${at}:${m.id}`);
      }
    }),
  );
  await nextTick();
  if (!scroller || !before || scope() !== at) return;
  scroller.scrollTo({
    top: before.bottom ? scroller.scrollHeight : before.top + scroller.scrollHeight - before.height,
    behavior: "instant",
  });
}
watch(visible, (members) => void load(members), { immediate: true });
// Earlier members can still be working (the Lead may hand one role several tasks at once): follow them.
const timer = setInterval(() => {
  if (visible.value.some((m) => m.busy)) void load(visible.value, true);
}, REFRESH_MS);
onBeforeUnmount(() => clearInterval(timer));

/** The task number of the i-th shown member, counting the hidden ones before it. */
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

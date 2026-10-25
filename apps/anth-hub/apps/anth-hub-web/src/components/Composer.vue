<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ArrowUp, ChevronDown, Clock3, Octagon, Paperclip, X } from "lucide-vue-next";
import type { WhenBusy } from "@sdk/api";
import { newId } from "../client/ids";
import { commands, parseCommand, type SlashCommand } from "../client/commands";
import {
  ACCEPT,
  MAX_FILES,
  discard,
  imageFiles,
  prepare,
  signature,
  sizeLabel,
  toWire,
  type DraftAttachment,
} from "../client/attachments";
import {
  agentHandle,
  agentState,
  attempt,
  busy,
  interrupt,
  interrupting,
  notify,
  online,
  select,
  selected,
  sessionAgents,
  ui,
} from "../client/store";

/**
 * A team member takes tasks from the agent that owns it and can't delegate or ship, so a message typed while one is
 * selected goes to its owner (up the chain to the Lead), and the view follows.
 */
async function routeToOwner() {
  const start = sessionAgents.value.find((a) => a.id === selected.value?.agentId);
  let target = start;
  while (target?.kind === "subagent" && target.ownerAgentId !== undefined)
    target = sessionAgents.value.find((a) => a.id === target!.ownerAgentId) ?? undefined;
  if (!start || !target || target.id === start.id || !selected.value) return;
  select({ ...selected.value, agentId: target.id });
  await nextTick();
  notify(`Sent to ${target.name || "the Lead"}: ${start.name || "team members"} take tasks from it`);
}

const mode = ref<WhenBusy>("followUp");
const pending = ref(false);

// Images for the next message: picked with the paperclip, pasted, or dropped on the composer.
const attachments = ref<DraftAttachment[]>([]);
const adding = ref(false);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement>();
async function addFiles(files: File[]) {
  if (!files.length) return;
  adding.value = true;
  ui.error = "";
  try {
    for (const file of files) {
      try {
        attachments.value = [...attachments.value, await prepare(file, attachments.value)];
      } catch (e) {
        ui.error = e instanceof Error ? e.message : String(e);
      }
    }
  } finally {
    adding.value = false;
  }
}
function removeAttachment(id: string) {
  const a = attachments.value.find((x) => x.id === id);
  if (a) discard(a);
  attachments.value = attachments.value.filter((x) => x.id !== id);
}
function picked(e: Event) {
  const input = e.target as HTMLInputElement;
  void addFiles([...(input.files ?? [])]);
  input.value = "";
}
function paste(e: ClipboardEvent) {
  const files = imageFiles(e.clipboardData);
  if (!files.length) return;
  e.preventDefault();
  void addFiles(files);
}
function drop(e: DragEvent) {
  dragging.value = false;
  void addFiles(imageFiles(e.dataTransfer));
}

// Typing "/" lists the slash commands; arrows pick, Tab or Enter completes.
const menuIndex = ref(0);
const menuClosed = ref(false);
const matches = computed(() => {
  const m = ui.composer.match(/^\/(\S*)$/);
  return m && !menuClosed.value
    ? commands.filter((c) => c.name.startsWith(m[1].toLowerCase()))
    : [];
});
watch(
  () => ui.composer,
  () => {
    menuIndex.value = 0;
    if (!ui.composer.startsWith("/")) menuClosed.value = false;
  },
);
// Enter on a fully typed name runs it unless it needs an argument; otherwise the name completes.
async function pick(command: SlashCommand, enter = false) {
  const runNow =
    !command.args || (enter && command.args.startsWith("[") && ui.composer === `/${command.name}`);
  if (!runNow) ui.composer = `/${command.name} `;
  else {
    ui.composer = `/${command.name}`;
    await send();
  }
}
function keydown(e: KeyboardEvent) {
  if (!matches.value.length) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const n = matches.value.length;
    menuIndex.value = (menuIndex.value + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
  } else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))
    void pick(matches.value[menuIndex.value], e.key === "Enter");
  else if (e.key === "Escape") menuClosed.value = true;
  else return;
  e.preventDefault();
  e.stopPropagation();
}

async function runCommand(text: string) {
  const parsed = parseCommand(text);
  if (!parsed) return false;
  pending.value = true;
  await attempt(async () => {
    await parsed.command.run(parsed.arg);
    ui.composer = "";
  });
  pending.value = false;
  return true;
}

// A retried send (same agent, text and mode) reuses its requestId, so the device admits it once.
async function send() {
  const content = ui.composer.trim();
  const handle = agentHandle.value;
  const files = attachments.value;
  if ((!content && !files.length) || pending.value || adding.value || !handle) return;
  if (!files.length && content.startsWith("/") && (await runCommand(content))) return;
  pending.value = true;
  await routeToOwner();
  const target = agentHandle.value ?? handle;
  const t = selected.value!;
  const key = `${t.deviceId}/${t.sessionId}/${t.agentId}`;
  const fileKey = signature(files);
  let saved:
    | { key: string; content: string; mode: string; requestId: string; files?: string }
    | undefined;
  try {
    saved = JSON.parse(sessionStorage.getItem("anth.pending-send") ?? "null");
  } catch {}
  const requestId =
    saved?.key === key &&
    saved.content === content &&
    saved.mode === mode.value &&
    (saved.files ?? "") === fileKey
      ? saved.requestId
      : newId();
  sessionStorage.setItem(
    "anth.pending-send",
    JSON.stringify({ key, content, mode: mode.value, requestId, files: fileKey }),
  );
  await attempt(async () => {
    await target.send(content, mode.value, requestId, undefined, toWire(files));
    sessionStorage.removeItem("anth.pending-send");
    ui.composer = "";
    for (const a of files) discard(a);
    attachments.value = attachments.value.filter((a) => !files.includes(a));
  });
  pending.value = false;
}

function withdraw(id: number) {
  void attempt(() => agentHandle.value!.withdraw(id));
}
</script>

<template>
  <div class="composer-region">
    <div v-if="agentState.inbox.length" class="queue">
      <div v-for="item in agentState.inbox" :key="item.id">
        <Clock3 :size="18" /><span
          >{{ item.mode === "steer" ? "Steer" : "Queued" }}:
          {{ item.content ?? "Context update" }}</span
        ><button
          class="icon-button"
          :aria-label="`Withdraw submission ${item.id}`"
          title="Withdraw queued input"
          @click="withdraw(item.id)"
        >
          <X :size="18" />
        </button>
      </div>
    </div>
    <div
      class="composer"
      :class="{ dragging }"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="drop"
    >
      <ul v-if="attachments.length || adding" class="attachments" aria-label="Attached images">
        <li v-for="a in attachments" :key="a.id" class="attachment">
          <img :src="a.url" :alt="a.name" /><span class="attachment-text"
            ><span class="attachment-name" :title="a.name">{{ a.name }}</span
            ><span class="attachment-size">{{ sizeLabel(a.size) }}</span></span
          ><button
            class="icon-button"
            :aria-label="`Remove ${a.name}`"
            title="Remove"
            @click="removeAttachment(a.id)"
          >
            <X :size="16" />
          </button>
        </li>
        <li v-if="adding" class="attachment attachment-adding">Reading image…</li>
      </ul>
      <ul v-if="matches.length" class="slash-menu" role="listbox" aria-label="Slash commands">
        <li
          v-for="(c, i) in matches"
          :key="c.name"
          role="option"
          :aria-selected="i === menuIndex"
          :class="{ active: i === menuIndex }"
          @mousedown.prevent="pick(c)"
        >
          <code>/{{ c.name }}</code
          ><span v-if="c.args" class="slash-args">{{ c.args }}</span
          ><span class="slash-desc">{{ c.description }}</span>
        </li>
      </ul>
      <textarea
        v-model="ui.composer"
        rows="2"
        placeholder="Give your agent something to do, or type / for commands…"
        aria-label="Message your agent"
        @keydown="keydown"
        @paste="paste"
      />
      <div class="composer-toolbar">
        <div class="composer-left">
          <button
            class="attach"
            type="button"
            aria-label="Attach images"
            title="Attach images: logos, icons, screenshots (PNG, JPEG, WebP, GIF, SVG). You can also paste or drop them here. They are saved in the project folder for the whole team."
            :disabled="attachments.length >= MAX_FILES || adding"
            @click="fileInput?.click()"
          >
            <Paperclip :size="20" />
          </button>
          <input
            ref="fileInput"
            type="file"
            :accept="ACCEPT.join(',')"
            multiple
            hidden
            data-testid="attach-input"
            @change="picked"
          />
          <div class="queue-mode">
            <select
              v-model="mode"
              aria-label="When busy"
              title="Follow-up waits for this run. Steer joins after a tool round."
            >
              <option value="followUp">Follow-up</option>
              <option value="steer">Steer</option>
              <option value="reject">Reject if busy</option></select
            ><ChevronDown :size="24" aria-hidden="true" />
          </div>
        </div>
        <div class="composer-right">
          <button
            class="interrupt"
            :disabled="!busy || interrupting"
            title="Stop foreground work and owned subagents (Esc twice). Background jobs continue."
            @click="interrupt"
          >
            <Octagon :size="24" class="stop-sign" fill="currentColor" />Interrupt</button
          ><button
            class="send"
            aria-label="Send message"
            :disabled="
              (!ui.composer.trim() && !attachments.length) ||
              pending ||
              adding ||
              !agentState.ready ||
              !online
            "
            @click="send"
          >
            <ArrowUp :size="20" />
          </button>
        </div>
      </div>
    </div>
    <div class="composer-footnote">
      <span><i class="live-dot" />Closing this window never interrupts your agent.</span>
    </div>
  </div>
</template>

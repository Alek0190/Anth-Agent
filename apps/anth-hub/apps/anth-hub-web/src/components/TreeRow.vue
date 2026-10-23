<script setup lang="ts">
import { computed } from "vue";
import {
  ArrowRightLeft,
  Eye,
  Building2,
  Layers,
  Package,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FolderOpen,
  GitFork,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Archive,
} from "lucide-vue-next";
import DeviceIcon from "./DeviceIcon.vue";
import type { TreeNode } from "@sdk/models";
import { ago } from "../client/store";

const props = defineProps<{
  node: TreeNode;
  depth: number;
  open: boolean;
  selected: boolean;
  focused: boolean;
  online: boolean;
}>();
const emit = defineEmits<{ toggle: []; activate: []; action: [name: string] }>();

const hasChildren = computed(() => props.node.children.length > 0);
const device = computed(() => (props.node.type === "device" ? props.node.device : undefined));
const session = computed(() => (props.node.type === "session" ? props.node.session : undefined));
const agent = computed(() => (props.node.type === "agent" ? props.node.agent : undefined));
const clientNode = computed(() => (props.node.type === "client" ? props.node : undefined));
const projectNode = computed(() => (props.node.type === "project" ? props.node : undefined));
const envNode = computed(() => (props.node.type === "env" ? props.node : undefined));
const projectCount = computed(() => clientNode.value?.children.length ?? 0);
const sessionCount = computed(() =>
  (projectNode.value?.children ?? []).reduce((n, env) => n + env.children.length, 0),
);
const background = computed(() =>
  session.value
    ? session.value.agents.reduce((n, a) => n + a.background, 0)
    : (agent.value?.background ?? 0),
);
const busy = computed(() => session.value?.busy || agent.value?.busy);
const statusText = computed(() => {
  const d = device.value;
  if (!d) return "";
  const count = d.tree?.sessions.length ?? 0;
  switch (d.status) {
    case "online":
      return `${count} session${count === 1 ? "" : "s"}`;
    case "checking":
      return "checking…";
    case "unauthorized":
      return d.hasToken ? "token rejected" : "no token";
    case "mismatch":
      return "identity changed";
    case "incompatible":
      return "incompatible";
    default:
      return `offline · ${ago(d.lastSeenAt)}`;
  }
});
const dot = computed(() => {
  const s = device.value?.status;
  return s === "online" ? "on" : s === "checking" ? "chk" : s === "offline" ? "off" : "err";
});
const label = computed(
  () =>
    device.value?.id ??
    session.value?.name ??
    agent.value?.name ??
    clientNode.value?.client.name ??
    projectNode.value?.project.name ??
    envNode.value?.env ??
    "",
);
const title = computed(() => {
  if (clientNode.value)
    return `Client ${clientNode.value.client.name} (${clientNode.value.client.slug})`;
  if (projectNode.value)
    return `${projectNode.value.project.client}/${projectNode.value.project.slug}\non ${projectNode.value.deviceIds.join(", ")}`;
  if (envNode.value) return `${envNode.value.project.name} · ${envNode.value.env}`;
  if (device.value)
    return `${device.value.name} · ${device.value.url}${device.value.error ? `\n${device.value.error}` : ""}`;
  if (session.value)
    return `${session.value.name}\n${props.node.type === "session" ? props.node.deviceId : ""}:${session.value.cwd}`;
  const a = agent.value!;
  return a.kind === "fork"
    ? `Fork of agent #${a.parentId} at entry #${a.forkedAt}`
    : a.kind === "subagent"
      ? `Subagent owned by agent #${a.ownerAgentId}`
      : "Root agent";
});
</script>

<template>
  <div
    class="tree-row"
    :class="[node.type, { sel: selected, focus: focused, stale: node.stale }]"
    :style="{ '--depth': depth }"
    role="treeitem"
    :aria-level="depth + 1"
    :aria-expanded="hasChildren ? open : undefined"
    :aria-selected="selected"
    :data-key="node.key"
    :title="title"
    @click="emit('activate')"
  >
    <button
      v-if="hasChildren"
      class="chev"
      tabindex="-1"
      :aria-label="open ? `Collapse ${label}` : `Expand ${label}`"
      @click.stop="emit('toggle')"
    >
      <ChevronDown v-if="open" :size="16" /><ChevronRight v-else :size="16" />
    </button>
    <span v-else class="chev" />
    <template v-if="clientNode">
      <Building2 class="ico" :size="16" />
      <b class="name">{{ label }}</b>
      <span class="meta">{{ projectCount }} project{{ projectCount === 1 ? "" : "s" }}</span>
      <span class="acts" @click.stop>
        <button
          class="icon-button"
          :disabled="!online"
          :aria-label="`New project for ${label}`"
          title="New project for this client"
          @click="emit('action', 'new-project')"
        >
          <Plus :size="16" />
        </button>
      </span>
    </template>
    <template v-else-if="projectNode">
      <Package class="ico" :size="16" />
      <b class="name">{{ label }}</b>
      <span
        v-if="projectNode.project.watch?.openIncidents"
        class="incident-badge"
        :title="`${projectNode.project.watch.openIncidents} open incident(s)`"
        >{{ projectNode.project.watch.openIncidents }} incident{{
          projectNode.project.watch.openIncidents === 1 ? "" : "s"
        }}</span
      >
      <Eye
        v-else-if="projectNode.project.watch?.enabled"
        class="ico watching"
        :size="14"
        aria-label="Watched"
      />
      <span class="meta">{{ sessionCount }} session{{ sessionCount === 1 ? "" : "s" }}</span>
      <span class="acts" @click.stop>
        <button
          class="icon-button"
          :disabled="!online"
          :aria-label="`New session in ${label}`"
          title="New session in this project"
          @click="emit('action', 'new-session')"
        >
          <Plus :size="16" />
        </button>
      </span>
    </template>
    <template v-else-if="envNode">
      <Layers class="ico" :size="16" />
      <span class="env-badge" :class="envNode.env">{{ envNode.env }}</span>
      <span class="meta">{{ envNode.children.length }}</span>
      <span class="acts" @click.stop>
        <button
          class="icon-button"
          :disabled="!online"
          :aria-label="`New ${envNode.env} session in ${envNode.project.name}`"
          :title="`New ${envNode.env} session`"
          @click="emit('action', 'new-session')"
        >
          <Plus :size="16" />
        </button>
      </span>
    </template>
    <template v-else-if="device">
      <i class="dot" :class="dot" />
      <DeviceIcon :device="device" :size="16" />
      <b class="name">{{ label }}</b>
      <span class="badge">{{ device.kind }}</span>
      <span class="meta" :class="{ err: dot === 'err' }">{{ statusText }}</span>
      <span class="acts" @click.stop>
        <button
          class="icon-button"
          :disabled="!online"
          :aria-label="`New session on ${label}`"
          title="New session on this device"
          @click="emit('action', 'new-session')"
        >
          <Plus :size="16" /></button
        ><button
          class="icon-button"
          :aria-label="`Check ${label}`"
          title="Check connection now"
          @click="emit('action', 'check')"
        >
          <RefreshCw :size="16" />
        </button>
      </span>
    </template>
    <template v-else-if="session">
      <FolderOpen class="ico" :size="16" />
      <b class="name">{{ label }}</b>
      <span
        v-if="session.project && node.type === 'session'"
        class="badge"
        :title="`Runs on ${node.deviceId}`"
        >{{ node.deviceId }}</span
      >
      <span v-else class="path">…/{{ session.cwd.split("/").filter(Boolean).at(-1) }}</span>
      <i v-if="busy" class="dot work" title="Working" />
      <span v-if="background" class="bg-count" :title="`${background} background task(s)`"
        ><i class="dot bg" />{{ background }} bg</span
      >
      <span class="acts" @click.stop>
        <button
          class="icon-button"
          :disabled="!online"
          :aria-label="`New agent in ${label}`"
          title="New agent in this session"
          @click="emit('action', 'new-agent')"
        >
          <Plus :size="16" /></button
        ><button
          class="icon-button"
          :disabled="!online"
          :aria-label="`Move session ${label} to a project`"
          title="Move to a project or environment"
          @click="emit('action', 'assign')"
        >
          <ArrowRightLeft :size="16" /></button
        ><button
          class="icon-button"
          :disabled="!online"
          :aria-label="`Rename session ${label}`"
          title="Rename session"
          @click="emit('action', 'rename')"
        >
          <Pencil :size="16" /></button
        ><button
          class="icon-button"
          :disabled="!online"
          :aria-label="`Archive session ${label}`"
          title="Archive session"
          @click="emit('action', 'archive')"
        >
          <Archive :size="16" />
        </button>
      </span>
    </template>
    <template v-else-if="agent">
      <GitFork v-if="agent.kind === 'fork'" class="ico" :size="16" />
      <CornerDownRight v-else-if="agent.kind === 'subagent'" class="ico" :size="16" />
      <MessageSquare v-else class="ico root" :size="16" />
      <span class="name">{{ label }}</span>
      <span v-if="agent.kind === 'fork' && agent.forkedAt !== undefined" class="meta"
        >@ #{{ agent.forkedAt }}</span
      >
      <i v-if="busy" class="dot work" title="Working" />
      <span v-if="background" class="bg-count" :title="`${background} background task(s)`"
        ><i class="dot bg" />{{ background }}</span
      >
      <span class="acts" @click.stop>
        <button
          class="icon-button"
          :disabled="!online"
          :aria-label="`Rename agent ${label}`"
          title="Rename agent"
          @click="emit('action', 'rename')"
        >
          <Pencil :size="16" />
        </button>
      </span>
    </template>
  </div>
</template>

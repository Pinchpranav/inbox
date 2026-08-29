<script setup lang="ts">
import { ref } from "vue";
import {
  isInInbox,
  stateLabel,
  type Project,
  type Session,
  type State,
} from "../data/domain";
import SessionRow from "./SessionRow.vue";

const props = defineProps<{
  projects: Project[];
  sessions: Session[];
  selectedKey: string | null;
  /** Backend connection status shown as a small dot in the header. */
  conn?: "ok" | "loading" | "error";
  connError?: string;
  /** Global ZDR (zero data retention) state, owned by backend.ts (build-gw6.5.1). */
  zdr?: boolean;
}>();

const emit = defineEmits<{
  select: [key: string];
  collapse: [];
  "open-settings": [];
  "new-project": [];
  "new-thread": [agentId: string];
  "set-session-state": [key: string, state: State];
  "toggle-no-inbox": [key: string];
  "move-session": [key: string, destAgentId: string];
  "set-project-state": [agentId: string, state: State];
  "toggle-zdr": [];
}>();

function connTitle(): string {
  switch (props.conn) {
    case "ok":
      return "Connected to backend";
    case "loading":
      return "Connecting…";
    case "error":
      return props.connError || "Connection error";
    default:
      return "Connection unknown";
  }
}

const STATES: State[] = ["active", "deferred", "done"];

const collapsed = ref<Record<string, boolean>>({ inbox: false });
const showMore = ref<Record<string, boolean>>({});
const openMenu = ref<string | null>(null);

function toggleCollapse(key: string) {
  collapsed.value[key] = !collapsed.value[key];
}
function toggleMore(id: string) {
  showMore.value[id] = !showMore.value[id];
}

function inboxList(): Session[] {
  return props.sessions.filter((s) => isInInbox(s)).sort((a, b) => b.updatedAt - a.updatedAt);
}
function projectSessions(id: string): Session[] {
  return props.sessions.filter((s) => s.agentId === id);
}
function activeOf(id: string) {
  return projectSessions(id).filter((s) => s.state === "active");
}
function deferredOf(id: string) {
  return projectSessions(id).filter((s) => s.state === "deferred");
}
function doneOf(id: string) {
  return projectSessions(id).filter((s) => s.state === "done");
}
function projectName(id: string): string {
  return props.projects.find((p) => p.id === id)?.name ?? id;
}
function cycleProjectState(p: Project) {
  const next: State = STATES[(STATES.indexOf(p.state) + 1) % STATES.length];
  emit("set-project-state", p.id, next);
}
function closeMenu() {
  openMenu.value = null;
}
function onMove(s: Session) {
  closeMenu();
  const targets = props.projects.filter((p) => p.id !== s.agentId);
  if (targets.length === 0) return;
  const list = targets.map((p) => p.name).join(", ");
  const name = window.prompt(`Move "${s.name}" to project:\n(enter name)\n\nAvailable: ${list}`);
  if (!name) return;
  const target = targets.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  if (!target) return;
  emit("move-session", s.key, target.id);
}
</script>

<template>
  <aside class="sidebar">
    <div class="head">
      <span class="conn-dot" :data-conn="conn ?? 'loading'" :title="connTitle()"></span>
      <button class="settings-btn" title="Backend settings" @click="$emit('open-settings')">⋯</button>
      <div class="brand-wrap">
        <h1 class="brand">Threads</h1>
        <button
          class="zdr-btn zdr-inline"
          :class="{ on: zdr }"
          :title="zdr ? 'ZDR on — zero data retention' : 'ZDR off'"
          @click="$emit('toggle-zdr')"
        >
          ZDR {{ zdr ? '●' : 'o' }}
        </button>
      </div>
      <button class="collapse-btn" title="Collapse sidebar" @click="$emit('collapse')">«</button>
    </div>

    <div class="scroll">
      <!-- Offline empty state (build-a9c: demo mode removed — no fake data) -->
      <div v-if="conn === 'error' && projects.length === 0" class="offline-card">
        <p class="offline-title">Backend not connected</p>
        <p class="offline-sub">{{ connError || "Start the server, then check again." }}</p>
        <button class="offline-btn" @click="$emit('open-settings')">Open settings</button>
      </div>

      <template v-else>
      <!-- INBOX (not collapsible; same label style as Projects) -->
      <div class="section-label">
        <span>Inbox</span>
        <span class="section-count">{{ inboxList().length }} active · 48h</span>
      </div>
      <div class="group-body">
        <p v-if="inboxList().length === 0" class="empty">No active threads in the last 48h.</p>
        <button
          v-for="s in inboxList()"
          :key="s.key"
          class="row inbox-row"
          :class="{ selected: s.key === selectedKey }"
          @click="$emit('select', s.key)"
        >
          <span class="dot" :data-state="s.state"></span>
          <span class="row-name">{{ s.name }}</span>
          <span class="meta">{{ projectName(s.agentId) }}</span>
        </button>
      </div>

      <div class="segregation-line" aria-hidden="true"></div>
      <!-- PROJECTS section label + add -->
      <div class="section-label">
        <span>Projects</span>
        <button class="add-btn" title="New project" @click="$emit('new-project')">+</button>
      </div>

      <!-- PROJECT GROUPS -->
      <section
        v-for="p in projects"
        :key="p.id"
        class="group"
        :class="{ collapsed: collapsed[p.id] }"
      >
        <div class="group-head">
          <button class="group-toggle" @click="toggleCollapse(p.id)">
            <span class="group-title">{{ p.name }}</span>
          </button>
          <span
            class="state-badge"
            :data-state="p.state"
            :title="`Project state: ${stateLabel(p.state)} (click to cycle)`"
            @click.stop="cycleProjectState(p)"
          ><span class="dot"></span>{{ stateLabel(p.state) }}</span>
          <span class="count">{{ projectSessions(p.id).length }}</span>
          <span class="caret-hover" aria-hidden="true">▾</span>
          <button class="add-btn" title="New thread" @click="$emit('new-thread', p.id)">+</button>
        </div>

        <div v-show="!collapsed[p.id]" class="group-body">
          <p v-if="projectSessions(p.id).length === 0" class="empty">No threads yet.</p>

          <!-- active first -->
          <SessionRow
            v-for="s in activeOf(p.id)"
            :key="s.key"
            :s="s"
            :selected="s.key === selectedKey"
            :menu-open="openMenu === s.key"
            @select="$emit('select', s.key)"
            @set-state="(st) => { emit('set-session-state', s.key, st); closeMenu(); }"
            @toggle-no-inbox="() => { emit('toggle-no-inbox', s.key); closeMenu(); }"
            @move="onMove(s)"
            @toggle-menu="openMenu = openMenu === s.key ? null : s.key"
          />

          <!-- deferred / done summary -->
          <button
            v-if="deferredOf(p.id).length + doneOf(p.id).length > 0"
            class="summary"
            :class="{ open: showMore[p.id] }"
            @click="toggleMore(p.id)"
          >
            <span class="caret">▾</span>
            <span>{{ deferredOf(p.id).length }} deferred · {{ doneOf(p.id).length }} done</span>
          </button>
          <div v-if="showMore[p.id]" class="more">
            <SessionRow
              v-for="s in [...deferredOf(p.id), ...doneOf(p.id)]"
              :key="s.key"
              :s="s"
              :selected="s.key === selectedKey"
              :menu-open="openMenu === s.key"
              @select="$emit('select', s.key)"
              @set-state="(st) => { emit('set-session-state', s.key, st); closeMenu(); }"
              @toggle-no-inbox="() => { emit('toggle-no-inbox', s.key); closeMenu(); }"
              @move="onMove(s)"
              @toggle-menu="openMenu = openMenu === s.key ? null : s.key"
            />
          </div>
        </div>
      </section>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-soft);
  overflow: hidden;
}
.head {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px 16px;
  min-height: 74px;
  border-bottom: 1px solid var(--border);
}
.brand {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.brand-wrap {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.collapse-btn {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text-soft);
  font-size: 16px;
  line-height: 1;
}
.collapse-btn:hover {
  color: var(--text);
  border-color: var(--border-strong);
  background: var(--bg-soft-2);
}
/* build-gw6.5.1: global ZDR toggle (replaces the chat-header button). */
.zdr-btn {
  position: absolute;
  left: 66px;
  top: 50%;
  transform: translateY(-50%);
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text-faint);
  font-size: 13px;
  line-height: 1;
  letter-spacing: 0.02em;
}
.zdr-btn.on {
  color: var(--state-active);
  border-color: var(--state-active);
}
.zdr-btn:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.zdr-btn.zdr-inline {
  position: static;
  left: auto;
  top: auto;
  transform: none;
}
/* build-gw6.5.1: settings moved from the gear (⚙) to a small ⋯ by the conn dot. */
.settings-btn {
  position: absolute;
  left: 40px;
  top: 50%;
  transform: translateY(-50%);
  width: 24px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text-soft);
  font-size: 17px;
  line-height: 1;
}
.settings-btn:hover {
  color: var(--text);
  border-color: var(--border-strong);
  background: var(--bg-soft-2);
}
.conn-dot {
  position: absolute;
  left: 16px;
  top: 50%;
  transform: translateY(-50%);
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
  border: 1px solid var(--text-faint);
}
.conn-dot[data-conn="ok"] {
  background: var(--conn-ok);
  border-color: var(--conn-ok);
}
.conn-dot[data-conn="loading"] {
  background: var(--conn-loading);
  border-color: var(--conn-loading);
  animation: conn-pulse 1s ease-in-out infinite;
}
.conn-dot[data-conn="error"] {
  background: var(--conn-error);
  border-color: var(--conn-error);
}
@keyframes conn-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* Offline empty state (build-a9c) */
.offline-card {
  margin: 16px 8px;
  padding: 16px 14px;
  border: 1px dashed var(--border-strong);
  border-radius: 10px;
  text-align: center;
  color: var(--text-soft);
}
.offline-title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.offline-sub {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-faint);
  word-break: break-word;
}
.offline-btn {
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--text-soft);
  cursor: pointer;
}
.offline-btn:hover {
  color: var(--text);
  background: var(--bg-soft-2);
}

.scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 4px 16px;
}

.group {
  margin-bottom: 4px;
}
.group-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 7px;
  text-align: left;
  color: var(--text-soft);
}
.group-head:hover {
  background: var(--bg-soft-2);
}
.inbox-head {
  width: 100%;
}
.group-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  color: inherit;
}
.caret {
  display: inline-block;
  width: 12px;
  font-size: 11px;
  transition: transform 0.12s;
}
.group.collapsed .caret {
  transform: rotate(-90deg);
}
.caret-hover {
  display: inline-block;
  width: 12px;
  font-size: 11px;
  color: var(--text-faint);
  opacity: 0;
  transition: opacity 0.12s, transform 0.12s;
  flex: none;
}
.group-head:hover .caret-hover {
  opacity: 1;
}
.group.collapsed .caret-hover {
  transform: rotate(-90deg);
}
.group-title {
  font-weight: 400;
  color: var(--text);
  font-size: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.state-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-soft);
  cursor: pointer;
  white-space: nowrap;
}
.state-badge .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1px solid var(--text-faint);
  flex: none;
}
.state-badge[data-state="active"] .dot {
  background: var(--state-active);
  border-color: var(--state-active);
}
.state-badge[data-state="deferred"] .dot {
  background: transparent;
  border-style: dashed;
  border-color: var(--text-soft);
}
.state-badge[data-state="done"] .dot {
  background: var(--state-done);
  border-color: var(--state-done);
}
.count {
  font-size: 12px;
  color: var(--text-faint);
  white-space: nowrap;
}
.add-btn {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  color: var(--text-soft);
  font-size: 16px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.add-btn:hover {
  color: var(--text);
  background: var(--bg-soft-2);
}

.section-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 8px 4px;
  font-size: 14px;
  font-weight: 400;
  color: var(--text-soft);
}
.segregation-line {
  border-top: 1px solid var(--border);
  margin: 10px -4px 0;
}
.section-count {
  font-size: 12px;
  text-transform: none;
  letter-spacing: normal;
  color: var(--text-faint);
  white-space: nowrap;
}

.group-body {
  padding: 2px 0 6px;
}
.empty {
  padding: 4px 8px;
  color: var(--text-faint);
  font-size: 14px;
  margin: 0;
}

/* inbox row uses its own simple styling */
.row {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 7px;
  text-align: left;
  color: var(--text);
  width: 100%;
}
.row:hover {
  background: var(--bg-soft-2);
}
.row.selected {
  background: var(--bg-soft-2);
}
.row-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  font-size: 13px;
  color: var(--text-faint);
  white-space: nowrap;
  padding-right: 4px;
}
.dot {
  width: var(--dot-size);
  height: var(--dot-size);
  border-radius: 50%;
  flex: none;
  border: 1px solid var(--text-faint);
}
.dot[data-state="active"] {
  background: var(--state-active);
  border-color: var(--state-active);
}
.dot[data-state="deferred"] {
  background: transparent;
  border-style: dashed;
  border-color: var(--text-soft);
}
.dot[data-state="done"] {
  background: var(--state-done);
  border-color: var(--state-done);
}

.summary {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border-radius: 7px;
  text-align: left;
  color: var(--text-faint);
  font-size: 13px;
}
.summary:hover {
  background: var(--bg-soft-2);
  color: var(--text-soft);
}
.summary .caret {
  font-size: 10px;
}
.summary:not(.open) .caret {
  transform: rotate(-90deg);
}
.more {
  padding-top: 2px;
}
</style>

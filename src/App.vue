<script setup lang="ts">
// App shell: composes the state modules and the three panes.
// State lives in src/state/ — backend.ts (server relationship), sessions.ts
// (projects/threads/selection + write actions), chat.ts (per-thread live
// streams). This file only wires them to the components.

import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import Sidebar from "./components/Sidebar.vue";
import ChatView from "./components/ChatView.vue";
import ProjectUsersModal from "./components/ProjectUsersModal.vue";
import { ControlSocket } from "./api/chatSocket";
import * as api from "./api/projectsApi";
import {
  conn,
  connError,
  models,
  zdrOn,
  currentUser,
  toggleZdr,
} from "./state/backend";
import {
  projects,
  sessions,
  selectedKey,
  selectedSession,
  selectedProjectName,
  selectedModelId,
  selectedThinking,
  selectSession,
  newProject as sidebarNewProject,
  newThread as sidebarNewThread,
  setSessionState,
  toggleNoInbox,
  moveSession,
  setProjectState,
  setSessionModel,
  setSessionThinking,
  startPolling,
  stopPolling,
  removeProject,
  removeSession,
  refreshAfterChange,
  resetView,
} from "./state/sessions";
import * as chat from "./state/chat";
import type { Message, Project, Session } from "./data/domain";

// ── view-local state ──────────────────────────────────────────────────────
const sidebarCollapsed = ref(false);
const usersProjectId = ref<string | null>(null);
const usersProject = computed(() => projects.value.find((p) => p.id === usersProjectId.value) ?? null);
const actionError = ref("");
let control: ControlSocket | null = null;

// ── selected-thread drawer (the one the UI renders) ───────────────────────
const live = computed(() => (selectedKey.value ? chat.liveFor(selectedKey.value) : null));
const liveMessages = computed<Message[]>(() => live.value?.messages.filter((m) => !m.isStreaming) ?? []);
const liveText = computed(() => live.value?.messages.filter((m) => m.isStreaming).map((m) => m.text).join("\n") ?? "");
const livePhase = computed(() => live.value?.phase ?? null);
const liveStreaming = computed(() => live.value?.streaming ?? false);
const liveLoading = computed(() => live.value?.loading ?? false);
const liveDisabled = computed(() => !live.value?.connected || !!live.value.pending && !live.value.streaming);
const liveDraft = computed({ get: () => live.value?.draft ?? "", set: (value: string) => { if (live.value) live.value.draft = value; } });

watch(selectedKey, (key) => { if (key) chat.loadHistory(key); });
watch(sessions, (rows) => chat.retainSessions(new Set(rows.map((s) => s.key))));

// ── lifecycle ─────────────────────────────────────────────────────────────
function startConnections() {
  control?.close();
  chat.closeAll();
  resetView();
  currentUser.value = null;
  models.value = [];
  startPolling();
  control = new ControlSocket((frame) => {
    if ((frame.type === "access.changed" && !frame.granted && !currentUser.value?.isOwner) || frame.type === "project.deleted") {
      chat.forgetProject(frame.projectId);
      removeProject(frame.projectId);
    } else if (frame.type === "session.deleted") {
      chat.forget(frame.sessionKey);
      removeSession(frame.sessionKey);
    }
    refreshAfterChange();
  }, (forbidden) => {
    if (forbidden) {
      chat.closeAll();
      resetView();
      currentUser.value = null;
      refreshAfterChange();
    }
  });
  control.connect();
}
onMounted(startConnections);
onUnmounted(() => {
  stopPolling();
  chat.closeAll();
  control?.close();
});

// ── sidebar handlers ──────────────────────────────────────────────────────

function onSelectSession(key: string) {
  selectSession(key);
}

async function renameProject(project: Project) {
  const name = window.prompt("Project name:", project.name)?.trim();
  if (name) await change(() => api.renameProject(project.id, name));
}
async function deleteProject(project: Project) {
  if (window.confirm(`Delete "${project.name}" and its conversations from the app? Project files will be kept.`)) {
    await change(async () => { await api.deleteProject(project.id); chat.forgetProject(project.id); removeProject(project.id); });
  }
}
async function renameSession(session: Session) {
  const name = window.prompt("Conversation name:", session.name)?.trim();
  if (name) await change(() => api.renameSession(session.key, name));
}
async function deleteSession(session: Session) {
  if (window.confirm(`Delete "${session.name}" from the app?`)) {
    await change(async () => { await api.deleteSession(session.key); chat.forget(session.key); removeSession(session.key); });
  }
}
async function change(action: () => Promise<unknown>) {
  actionError.value = "";
  try { await action(); refreshAfterChange(); }
  catch (err) { actionError.value = err instanceof Error ? err.message : String(err); }
}

function onNewProject() {
  const name = window.prompt("New project name:");
  if (!name?.trim()) return;
  const trimmed = name.trim();
  const dir = window.prompt("Project working directory (absolute path):");
  if (!dir?.trim()) return;
  sidebarNewProject(trimmed, dir.trim());
}

function onNewThread(agentId: string) {
  const name = window.prompt("New thread name:");
  if (!name?.trim()) return;
  sidebarNewThread(agentId, name.trim());
}

// ── chat handlers ─────────────────────────────────────────────────────────

function onSend(text: string) {
  if (selectedKey.value) chat.send(selectedKey.value, text);
}

function onAbort() {
  if (selectedKey.value) chat.abort(selectedKey.value);
}

function onModel(id: string) {
  if (selectedKey.value) setSessionModel(selectedKey.value, id);
}

function onThinking(level: string) {
  if (selectedKey.value) setSessionThinking(selectedKey.value, level);
}
</script>

<template>
  <div
    class="app"
    :style="{ gridTemplateColumns: sidebarCollapsed ? '0 1fr' : '300px 1fr' }"
  >
    <Sidebar
      v-show="!sidebarCollapsed"
      :projects="projects"
      :sessions="sessions"
      :selected-key="selectedKey"
      :conn="conn"
      :conn-error="connError"
      :zdr="zdrOn"
      :is-owner="currentUser?.isOwner ?? false"
      @select="onSelectSession"
      @collapse="sidebarCollapsed = true"
      @new-project="onNewProject"
      @new-thread="onNewThread"
      @set-session-state="setSessionState"
      @toggle-no-inbox="toggleNoInbox"
      @move-session="moveSession"
      @set-project-state="setProjectState"
      @toggle-zdr="toggleZdr"
      @manage-users="usersProjectId = $event"
      @rename-project="renameProject"
      @delete-project="deleteProject"
      @rename-session="renameSession"
      @delete-session="deleteSession"
    />
    <button
      v-if="sidebarCollapsed"
      class="expand-btn"
      title="Show sidebar"
      @click="sidebarCollapsed = false"
    >»</button>
    <ChatView
      :session="selectedSession"
      :project-name="selectedProjectName"
      :messages="liveMessages"
      :live-text="liveText"
      :phase="livePhase"
      :streaming="liveStreaming"
      :loading="liveLoading"
      :disabled="liveDisabled"
      v-model:draft="liveDraft"
      :error="live?.error || ''"
      :sidebar-collapsed="sidebarCollapsed"
      :models="models"
      :model-id="selectedModelId"
      :thinking-level="selectedThinking"
      @send="onSend"
      @abort="onAbort"
      @model="onModel"
      @thinking="onThinking"
    />
    <ProjectUsersModal :project="usersProject" @close="usersProjectId = null" />
    <div v-if="actionError" class="action-error" role="alert">{{ actionError }} <button @click="actionError = ''" aria-label="Dismiss error">×</button></div>
  </div>
</template>
<style scoped>
.action-error { position: fixed; bottom: 20px; left: 20px; z-index: 30; max-width: min(90vw, 500px); padding: 12px 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-soft); box-shadow: 0 4px 20px #0003; font-size: 13px; }
.action-error button { margin-left: 12px; }
</style>

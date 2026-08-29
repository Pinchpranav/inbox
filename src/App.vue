<script setup lang="ts">
// App shell (build-a9c): composes the state modules and the three panes.
// State lives in src/state/ — backend.ts (server relationship), sessions.ts
// (projects/threads/selection + write actions), chat.ts (per-thread live
// streams). This file only wires them to the components.

import { computed, onMounted, onUnmounted, ref } from "vue";
import Sidebar from "./components/Sidebar.vue";
import ChatView from "./components/ChatView.vue";
import SettingsModal from "./components/SettingsModal.vue";
import {
  config,
  conn,
  connError,
  models,
  zdrOn,
  toggleZdr,
  applySavedConfig,
  applyClearedConfig,
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
} from "./state/sessions";
import * as chat from "./state/chat";
import type { Message, State } from "./data/domain";

// ── view-local state ──────────────────────────────────────────────────────
const sidebarCollapsed = ref(false);
const settingsOpen = ref(false);

// ── selected-thread drawer (the one the UI renders) ───────────────────────
const live = computed(() => (selectedKey.value ? chat.liveFor(selectedKey.value) : null));
const liveMessages = computed<Message[]>(() => live.value?.messages ?? []);
const liveText = computed(() => live.value?.liveText ?? "");
const livePhase = computed(() => live.value?.phase ?? null);
const liveStreaming = computed(() => live.value?.streaming ?? false);

// ── lifecycle ─────────────────────────────────────────────────────────────
onMounted(() => startPolling());
onUnmounted(() => {
  stopPolling();
  chat.closeAll();
});

// ── sidebar handlers ──────────────────────────────────────────────────────

function onSelectSession(key: string) {
  selectSession(key);
  void chat.loadHistory(key);
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

// ── settings handlers ─────────────────────────────────────────────────────

function onSaveSettings(cfg: { url: string }) {
  applySavedConfig(cfg);
  settingsOpen.value = false;
  startPolling();
}

function onClearSettings() {
  applyClearedConfig();
  settingsOpen.value = false;
  startPolling();
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
      @select="onSelectSession"
      @collapse="sidebarCollapsed = true"
      @open-settings="settingsOpen = true"
      @new-project="onNewProject"
      @new-thread="onNewThread"
      @set-session-state="setSessionState"
      @toggle-no-inbox="toggleNoInbox"
      @move-session="moveSession"
      @set-project-state="setProjectState"
      @toggle-zdr="toggleZdr"
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
      :sidebar-collapsed="sidebarCollapsed"
      :models="models"
      :model-id="selectedModelId"
      :thinking-level="selectedThinking"
      @send="onSend"
      @abort="onAbort"
      @model="onModel"
      @thinking="onThinking"
    />
    <SettingsModal
      :open="settingsOpen"
      :config="config"
      :conn="conn"
      :conn-error="connError"
      @save="onSaveSettings"
      @clear="onClearSettings"
      @close="settingsOpen = false"
    />
  </div>
</template>

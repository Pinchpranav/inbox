<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import Sidebar from "./components/Sidebar.vue";
import ChatView from "./components/ChatView.vue";
import SettingsModal from "./components/SettingsModal.vue";
import {
  messagesBySession,
  mockReply,
  projects as seedProjects,
  sessions as seedSessions,
  type Message,
  type Project,
  type Session,
  type State,
} from "./data/mock";
import {
  loadConfig,
  saveConfig,
  clearConfig,
  isConfigured,
  type GatewayConfig,
} from "./config";
import * as api from "./api/projectsApi";
import {
  ChatGatewayClient,
  type EventFrame,
} from "./api/gatewayClient";
import {
  extractMessageText,
  mapHistoryMessages,
  resolveDeltaChatStreamText,
  type ChatEventPayload,
} from "./api/chatStream";

// ── Gateway config + connection state ────────────────────────────────────
const config = ref<GatewayConfig>(loadConfig());
const configured = computed(() => isConfigured(config.value));
const conn = ref<"ok" | "loading" | "error" | "demo">("demo");
const connError = ref("");
const settingsOpen = ref(false);

const client = () => ({ url: config.value.url, token: config.value.token });

// ── Sidebar data ──────────────────────────────────────────────────────────
const projects = ref<Project[]>([]);
const sessions = ref<Session[]>([]);
const selectedKey = ref<string | null>(null);
const sidebarCollapsed = ref(false);

// ── Chat state ─────────────────────────────────────────────────────────────
const messages = ref<Message[]>([]);
const liveText = ref("");
const phase = ref<string | null>(null);
const streaming = ref(false);
const historyLoading = ref(false);
let activeRunId: string | null = null;

// Mock-streaming timers (demo mode only).
let phaseTimer: ReturnType<typeof setInterval> | null = null;
let wordTimer: ReturnType<typeof setInterval> | null = null;

// Real chat gateway client (configured mode only).
let chatClient: ChatGatewayClient | null = null;

const selectedSession = computed(
  () => sessions.value.find((s) => s.key === selectedKey.value) ?? null,
);
const selectedProjectName = computed(() => {
  const s = selectedSession.value;
  if (!s) return "";
  return projects.value.find((p) => p.id === s.agentId)?.name ?? s.agentId;
});

function touch(key: string) {
  const s = sessions.value.find((x) => x.key === key);
  if (s) s.updatedAt = Date.now();
}

// ── Sidebar data loading (REST) ───────────────────────────────────────────
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight = false;

function loadDemoSeed() {
  projects.value = structuredClone(seedProjects);
  sessions.value = structuredClone(seedSessions);
  conn.value = "demo";
  connError.value = "";
}

async function refresh() {
  if (!configured.value || refreshInFlight) return;
  refreshInFlight = true;
  const wasOk = conn.value === "ok";
  if (!wasOk) conn.value = "loading";
  try {
    const view = await api.fetchView(client());
    projects.value = view.projects;
    sessions.value = view.sessions;
    conn.value = "ok";
    connError.value = "";
    pruneSelection();
  } catch (err) {
    conn.value = "error";
    connError.value = err instanceof api.GatewayError ? err.message : String(err);
  } finally {
    refreshInFlight = false;
  }
}

function pruneSelection() {
  if (selectedKey.value && !sessions.value.some((s) => s.key === selectedKey.value)) {
    selectedKey.value = null;
    messages.value = [];
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    void refresh();
  }, 5000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ── Chat gateway client lifecycle ─────────────────────────────────────────
function startChatClient() {
  stopChatClient();
  chatClient = new ChatGatewayClient({
    url: config.value.url,
    token: config.value.token,
    onEvent: (event) => handleGatewayEvent(event),
  });
  chatClient.start();
}

function stopChatClient() {
  if (chatClient) {
    chatClient.stop();
    chatClient = null;
  }
  activeRunId = null;
}

function applyConfig() {
  if (configured.value) {
    void refresh();
    startPolling();
    startChatClient();
  } else {
    stopPolling();
    stopChatClient();
    loadDemoSeed();
  }
}

// ── Gateway event dispatch (chat stream + sessions.changed) ───────────────
function handleGatewayEvent(event: EventFrame) {
  const name = (event as { event?: string }).event;
  const payload = (event as { payload?: ChatEventPayload }).payload;
  if (!name || !payload) return;

  if (name === "sessions.changed") {
    // Sidebar changed on the gateway — refresh the REST view promptly.
    void refresh();
    return;
  }

  if (name !== "chat") return;

  // Only react to the selected session's active run.
  if (selectedKey.value === null || payload.sessionKey !== selectedKey.value) return;
  if (activeRunId !== null && payload.runId !== activeRunId) return;

  switch (payload.state) {
    case "status":
      phase.value = payload.phase || "working…";
      break;
    case "delta": {
      const next = resolveDeltaChatStreamText(liveText.value, payload);
      if (typeof next === "string") liveText.value = next;
      break;
    }
    case "final":
      finalizeReal(payload);
      break;
    case "aborted":
      abortReal();
      break;
    case "error":
      errorReal(payload);
      break;
  }
}

// ── Sidebar actions ───────────────────────────────────────────────────────
function selectSession(key: string) {
  if (streaming.value) abort();
  selectedKey.value = key;
  liveText.value = "";
  phase.value = null;
  activeRunId = null;

  if (!configured.value) {
    // Demo mode: canned mock history.
    messages.value = (messagesBySession[key] ?? []).map((m) => ({ ...m }));
    return;
  }
  // Real mode: load chat.history from the gateway.
  loadHistory(key);
}

async function loadHistory(key: string) {
  if (!chatClient) {
    messages.value = [];
    return;
  }
  historyLoading.value = true;
  try {
    const rows = await chatClient.chatHistory(key);
    // Discard if the user switched away while we were loading.
    if (selectedKey.value !== key) return;
    messages.value = mapHistoryMessages(rows);
  } catch (err) {
    if (selectedKey.value !== key) return;
    messages.value = [];
    connError.value = `chat.history: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (selectedKey.value === key) historyLoading.value = false;
  }
}

function newProject() {
  const name = window.prompt("New project name:");
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  if (!configured.value) {
    const id = trimmed.toLowerCase().replace(/\s+/g, "-");
    if (projects.value.some((p) => p.id === id)) return;
    projects.value.push({ id, name: trimmed, state: "active" });
    return;
  }
  void api
    .createProject(client(), trimmed)
    .then(() => refresh())
    .catch((err) => {
      connError.value = err instanceof api.GatewayError ? err.message : String(err);
      void refresh();
    });
}

function newThread(agentId: string) {
  const name = window.prompt("New thread name:");
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  if (!configured.value) {
    const key = `agent:${agentId}:${Date.now()}`;
    sessions.value.push({
      key,
      name: trimmed,
      agentId,
      state: "active",
      noInbox: false,
      updatedAt: Date.now(),
    });
    selectSession(key);
    return;
  }
  void api
    .createThread(client(), agentId, trimmed)
    .then((res) => {
      void refresh().then(() => {
        const newKey = res.session?.key;
        if (newKey) selectSession(newKey);
      });
    })
    .catch((err) => {
      connError.value = err instanceof api.GatewayError ? err.message : String(err);
      void refresh();
    });
}

function setSessionState(key: string, state: State) {
  const s = sessions.value.find((x) => x.key === key);
  if (s) s.state = state; // optimistic
  if (!configured.value) return;
  void api
    .setSessionState(client(), key, state)
    .catch((err) => {
      connError.value = err instanceof api.GatewayError ? err.message : String(err);
      void refresh();
    });
}

function toggleNoInbox(key: string) {
  const s = sessions.value.find((x) => x.key === key);
  if (s) s.noInbox = !s.noInbox; // optimistic
  if (!configured.value) return;
  const next = s ? s.noInbox : false;
  void api
    .setNoInbox(client(), key, next)
    .catch((err) => {
      connError.value = err instanceof api.GatewayError ? err.message : String(err);
      void refresh();
    });
}

function moveSession(key: string, destAgentId: string) {
  if (!configured.value) {
    const s = sessions.value.find((x) => x.key === key);
    if (s) s.agentId = destAgentId;
    return;
  }
  void api
    .moveThread(client(), key, destAgentId)
    .then((res) => {
      void refresh().then(() => {
        const newKey = res.newKey;
        if (newKey && selectedKey.value === key) selectSession(newKey);
      });
    })
    .catch((err) => {
      connError.value = err instanceof api.GatewayError ? err.message : String(err);
      void refresh();
    });
}

function setProjectState(agentId: string, state: State) {
  const p = projects.value.find((x) => x.id === agentId);
  if (p) p.state = state; // optimistic
  if (!configured.value) return;
  void api
    .setProjectState(client(), agentId, state)
    .catch((err) => {
      connError.value = err instanceof api.GatewayError ? err.message : String(err);
      void refresh();
    });
}

// ── Settings ──────────────────────────────────────────────────────────────
function onSaveSettings(cfg: GatewayConfig) {
  saveConfig(cfg);
  config.value = cfg;
  settingsOpen.value = false;
  applyConfig();
}
function onClearSettings() {
  clearConfig();
  config.value = { url: "", token: "" };
  settingsOpen.value = false;
  applyConfig();
}

// ── Chat: send / stream / stop ─────────────────────────────────────────────

// Demo-mode status phases (real mode uses payload.phase from `status` events).
const PHASES = ["preparing context", "preparing workspace", "starting model", "generating"];

function send(text: string) {
  if (!selectedKey.value || streaming.value) return;
  if (configured.value) sendReal(text);
  else sendMock(text);
}

function sendReal(text: string) {
  const key = selectedKey.value!;
  if (!chatClient || !chatClient.connected) {
    connError.value = "Not connected to gateway — can't send.";
    return;
  }
  messages.value.push({ id: `u${Date.now()}`, role: "user", text });
  touch(key);

  streaming.value = true;
  liveText.value = "";
  phase.value = "preparing…";

  const idempotencyKey = `sid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  void chatClient
    .chatSend(key, text, idempotencyKey)
    .then((runId) => {
      activeRunId = runId;
    })
    .catch((err) => {
      connError.value = `chat.send: ${err instanceof Error ? err.message : String(err)}`;
      streaming.value = false;
      phase.value = null;
      liveText.value = "";
    });
}

function finalizeReal(payload: ChatEventPayload) {
  const text = extractMessageText(payload.message)?.trim() || liveText.value || "";
  if (text) {
    messages.value.push({ id: `a${Date.now()}`, role: "assistant", text });
  }
  const key = selectedKey.value;
  if (key) touch(key);
  liveText.value = "";
  phase.value = null;
  streaming.value = false;
  activeRunId = null;
}

function abortReal() {
  const partial = liveText.value;
  if (partial.trim()) {
    messages.value.push({
      id: `a${Date.now()}`,
      role: "assistant",
      text: `${partial} ⏹ (stopped)`,
    });
  }
  liveText.value = "";
  phase.value = null;
  streaming.value = false;
  activeRunId = null;
}

function errorReal(payload: ChatEventPayload) {
  const text = payload.errorMessage?.trim() || "⚠ chat error";
  messages.value.push({ id: `a${Date.now()}`, role: "assistant", text });
  liveText.value = "";
  phase.value = null;
  streaming.value = false;
  activeRunId = null;
}

function abort() {
  if (!streaming.value) return;
  if (configured.value && chatClient && activeRunId && selectedKey.value) {
    void chatClient.chatAbort(selectedKey.value, activeRunId).catch(() => {
      /* the gateway will send `aborted` regardless; ignore local errors */
    });
    // The `aborted` event finalizes the UI. If it never arrives, clear locally.
    setTimeout(() => {
      if (streaming.value) abortReal();
    }, 1500);
  } else {
    abortMock();
  }
}

// ── Demo-mode mock streaming ───────────────────────────────────────────────
function sendMock(text: string) {
  const key = selectedKey.value!;
  messages.value.push({ id: `u${Date.now()}`, role: "user", text });
  touch(key);

  streaming.value = true;
  liveText.value = "";
  phase.value = PHASES[0];

  let phaseIdx = 0;
  phaseTimer = setInterval(() => {
    phaseIdx = Math.min(phaseIdx + 1, PHASES.length - 1);
    phase.value = PHASES[phaseIdx];
  }, 650);

  const words = mockReply.split(" ");
  let i = 0;
  wordTimer = setInterval(() => {
    if (i >= words.length) {
      finalizeMock();
      return;
    }
    liveText.value = (liveText.value + (i ? " " : "") + words[i]).trim();
    i++;
  }, 90);
}

function finalizeMock() {
  clearTimers();
  const key = selectedKey.value;
  const text = liveText.value || mockReply;
  const msg: Message = { id: `a${Date.now()}`, role: "assistant", text };
  messages.value.push(msg);
  if (key) {
    messagesBySession[key] = [...messages.value];
    touch(key);
  }
  liveText.value = "";
  phase.value = null;
  streaming.value = false;
}

function abortMock() {
  clearTimers();
  const key = selectedKey.value;
  if (liveText.value) {
    messages.value.push({
      id: `a${Date.now()}`,
      role: "assistant",
      text: `${liveText.value} ⏹ (stopped)`,
    });
    if (key) messagesBySession[key] = [...messages.value];
  }
  liveText.value = "";
  phase.value = null;
  streaming.value = false;
}

function clearTimers() {
  if (phaseTimer) clearInterval(phaseTimer);
  if (wordTimer) clearInterval(wordTimer);
  phaseTimer = null;
  wordTimer = null;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
onMounted(() => applyConfig());
onUnmounted(() => {
  stopPolling();
  stopChatClient();
  clearTimers();
});
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
      @select="selectSession"
      @collapse="sidebarCollapsed = true"
      @open-settings="settingsOpen = true"
      @new-project="newProject"
      @new-thread="newThread"
      @set-session-state="setSessionState"
      @toggle-no-inbox="toggleNoInbox"
      @move-session="moveSession"
      @set-project-state="setProjectState"
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
      :messages="messages"
      :live-text="liveText"
      :phase="phase"
      :streaming="streaming"
      :sidebar-collapsed="sidebarCollapsed"
      @send="send"
      @abort="abort"
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
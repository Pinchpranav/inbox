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
  type ModelEntry,
  type State,
} from "./data/domain";
import {
  loadConfig,
  saveConfig,
  clearConfig,
  type BackendConfig,
} from "./config";
import * as api from "./api/projectsApi";
import { ChatSocket } from "./api/chatSocket";

// ── Gateway config + connection state ────────────────────────────────────
const config = ref<BackendConfig>(loadConfig());
const conn = ref<"ok" | "loading" | "error" | "demo">("loading");
const connError = ref("");
const settingsOpen = ref(false);

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

// build-gw6.5.1: model catalog (fetched once) + global ZDR toggle (owned here, sidebar renders it).
const models = ref<ModelEntry[]>([]);
const zdrOn = ref(true);

// Mock-streaming timers (demo mode only).
let phaseTimer: ReturnType<typeof setInterval> | null = null;
let wordTimer: ReturnType<typeof setInterval> | null = null;

// Real chat WS socket (one per active turn).
let chatSocket: ChatSocket | null = null;
let abortFallback: ReturnType<typeof setTimeout> | null = null;

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
  if (refreshInFlight) return;
  refreshInFlight = true;
  const wasOk = conn.value === "ok";
  if (!wasOk) conn.value = "loading";
  try {
    const view = await api.fetchView();
    projects.value = view.projects;
    sessions.value = view.sessions;
    conn.value = "ok";
    connError.value = "";
    pruneSelection();
  } catch (err) {
    conn.value = "error";
    connError.value = err instanceof api.ApiError ? err.message : String(err);
    loadDemoSeed(); // fall back to mock data so the UI isn't empty
  } finally {
    refreshInFlight = false;
  }
  // build-gw6.5.1: fetch the model catalog once (independent of the sidebar view).
  void api.getModels().then((m) => (models.value = m)).catch(() => { /* demo mode: picker stays empty */ });
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

function applyConfig() {
  void refresh();
  startPolling();
}

// ── Sidebar actions ───────────────────────────────────────────────────────
function selectSession(key: string) {
  if (streaming.value) abort();
  selectedKey.value = key;
  liveText.value = "";
  phase.value = null;
  closeChat();

  if (conn.value !== "ok") {
    // Demo mode: canned mock history.
    messages.value = (messagesBySession[key] ?? []).map((m) => ({ ...m }));
    return;
  }
  // Real mode: load the transcript from the backend.
  loadHistory(key);
}

async function loadHistory(key: string) {
  historyLoading.value = true;
  try {
    const rows = await api.fetchMessages(key);
    // Discard if the user switched away while we were loading.
    if (selectedKey.value !== key) return;
    messages.value = rows;
  } catch (err) {
    if (selectedKey.value !== key) return;
    messages.value = [];
    connError.value = `messages: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (selectedKey.value === key) historyLoading.value = false;
  }
}

function newProject() {
  const name = window.prompt("New project name:");
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  if (conn.value !== "ok") {
    const id = trimmed.toLowerCase().replace(/\s+/g, "-");
    if (projects.value.some((p) => p.id === id)) return;
    projects.value.push({ id, name: trimmed, state: "active" });
    return;
  }
  const dir = window.prompt("Project working directory (absolute path):");
  if (!dir) return;
  void api
    .createProject(trimmed, dir.trim())
    .then(() => refresh())
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
      void refresh();
    });
}

function newThread(agentId: string) {
  const name = window.prompt("New thread name:");
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  if (conn.value !== "ok") {
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
    .createThread(agentId, trimmed)
    .then((res) => {
      void refresh().then(() => {
        const newKey = res.key;
        if (newKey) selectSession(newKey);
      });
    })
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
      void refresh();
    });
}

function setSessionState(key: string, state: State) {
  const s = sessions.value.find((x) => x.key === key);
  if (s) s.state = state; // optimistic
  if (conn.value !== "ok") return;
  void api
    .setSessionState(key, state)
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
      void refresh();
    });
}

function toggleNoInbox(key: string) {
  const s = sessions.value.find((x) => x.key === key);
  if (s) s.noInbox = !s.noInbox; // optimistic
  if (conn.value !== "ok") return;
  const next = s ? s.noInbox : false;
  void api
    .setNoInbox(key, next)
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
      void refresh();
    });
}

function moveSession(key: string, destAgentId: string) {
  if (conn.value !== "ok") {
    const s = sessions.value.find((x) => x.key === key);
    if (s) s.agentId = destAgentId;
    return;
  }
  void api
    .moveSession(key, destAgentId)
    .then((res) => {
      void refresh().then(() => {
        const newKey = res.key;
        if (newKey && selectedKey.value === key) selectSession(newKey);
      });
    })
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
      void refresh();
    });
}

function setProjectState(agentId: string, state: State) {
  const p = projects.value.find((x) => x.id === agentId);
  if (p) p.state = state; // optimistic
  if (conn.value !== "ok") return;
  void api
    .setProjectState(agentId, state)
    .catch((err) => {
      connError.value = err instanceof api.ApiError ? err.message : String(err);
      void refresh();
    });
}

// ── build-gw6.5.1: model + thinking (per-session) ─────────────────────────
const selectedModelId = computed(() => selectedSession.value?.modelId ?? null);
const selectedThinking = computed(() => selectedSession.value?.thinkingLevel ?? null);

function onModel(id: string) {
  const key = selectedKey.value;
  if (!key) return;
  const s = sessions.value.find((x) => x.key === key);
  if (s) s.modelId = id; // optimistic
  if (conn.value !== "ok") return;
  void api.setSessionModel(key, id).catch((err) => {
    connError.value = err instanceof api.ApiError ? err.message : String(err);
    void refresh();
  });
}

function onThinking(level: string) {
  const key = selectedKey.value;
  if (!key) return;
  const s = sessions.value.find((x) => x.key === key);
  if (s) s.thinkingLevel = level; // optimistic
  if (conn.value !== "ok") return;
  void api.setSessionThinking(key, level).catch((err) => {
    connError.value = err instanceof api.ApiError ? err.message : String(err);
    void refresh();
  });
}

// ── build-gw6.5.1: global ZDR toggle (sidebar) ────────────────────────────
async function toggleZdr() {
  const next = !zdrOn.value;
  zdrOn.value = next; // optimistic
  if (conn.value !== "ok") return;
  try {
    await fetch("/api/sessions/zdr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ zdr: next }),
    });
  } catch {
    zdrOn.value = !next; // rollback on failure
  }
}

// ── Settings ──────────────────────────────────────────────────────────────
function onSaveSettings(cfg: BackendConfig) {
  saveConfig(cfg);
  config.value = cfg;
  settingsOpen.value = false;
  applyConfig();
}
function onClearSettings() {
  clearConfig();
  config.value = { url: "" };
  settingsOpen.value = false;
  applyConfig();
}

// ── Chat: send / stream / stop ─────────────────────────────────────────────

// Demo-mode status phases (real mode uses payload.phase from `status` events).
const PHASES = ["preparing context", "preparing workspace", "starting model", "generating"];

function send(text: string) {
  if (!selectedKey.value || streaming.value) return;
  if (conn.value === "ok") sendReal(text);
  else sendMock(text);
}

function sendReal(text: string) {
  const key = selectedKey.value!;
  messages.value.push({ id: `u${Date.now()}`, role: "user", text });
  touch(key);

  streaming.value = true;
  liveText.value = "";
  phase.value = "preparing…";

  chatSocket = new ChatSocket(key, {
    onDelta: (t) => {
      liveText.value += t;
    },
    onEnd: (m) => {
      const settled = m.text?.trim() || liveText.value || "";
      if (settled) {
        messages.value.push({ id: m.id || `a${Date.now()}`, role: "assistant", text: settled });
      }
      liveText.value = "";
    },
    onStatus: (p) => {
      if (p === "idle") {
        streaming.value = false;
        phase.value = null;
        closeChat();
      } else if (p === "aborted") {
        abortReal();
        closeChat();
      } else if (p === "error") {
        errorReal("⚠ chat error");
        closeChat();
      } else if (p === "streaming") {
        phase.value = "generating…";
      }
    },
    onError: (msg) => {
      errorReal(msg);
      closeChat();
    },
    onOpen: () => {
      chatSocket?.sendPrompt(text);
    },
  });
  chatSocket.connect();
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
}

function errorReal(msg: string) {
  const text = msg?.trim() || "⚠ chat error";
  messages.value.push({ id: `a${Date.now()}`, role: "assistant", text });
  liveText.value = "";
  phase.value = null;
  streaming.value = false;
}

function closeChat() {
  if (abortFallback) {
    clearTimeout(abortFallback);
    abortFallback = null;
  }
  if (chatSocket) {
    chatSocket.close();
    chatSocket = null;
  }
}

function abort() {
  if (!streaming.value) return;
  if (conn.value === "ok" && chatSocket) {
    chatSocket.sendAbort();
    // The server sends a terminal status (aborted) after abort; if it never
    // arrives, clear locally so the UI can't hang.
    abortFallback = setTimeout(() => {
      if (streaming.value) abortReal();
      closeChat();
    }, 2000);
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
  closeChat();
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
      :zdr="zdrOn"
      @select="selectSession"
      @collapse="sidebarCollapsed = true"
      @open-settings="settingsOpen = true"
      @new-project="newProject"
      @new-thread="newThread"
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
      :messages="messages"
      :live-text="liveText"
      :phase="phase"
      :streaming="streaming"
      :sidebar-collapsed="sidebarCollapsed"
      :models="models"
      :model-id="selectedModelId"
      :thinking-level="selectedThinking"
      @send="send"
      @abort="abort"
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
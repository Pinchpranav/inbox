<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { stateLabel, type Message, type Session, type ModelEntry } from "../data/domain";
import ThemeToggle from "./ThemeToggle.vue";
import MarkdownView from "./MarkdownView.vue";
import Composer from "./Composer.vue";

const props = defineProps<{
  session: Session | null;
  projectName: string;
  messages: Message[];
  liveText: string;
  phase: string | null;
  streaming: boolean;
  /** History fetch in flight — show "loading conversation…" instead of the empty hero. */
  loading: boolean;
  sidebarCollapsed: boolean;
  models: ModelEntry[];
  modelId: string | null;
  thinkingLevel: string | null;
}>();

const emit = defineEmits<{ send: [text: string]; abort: []; model: [id: string]; thinking: [level: string] }>();

const scrollEl = ref<HTMLDivElement | null>(null);
const autoFollow = ref(true);
const showEnd = ref(false);

const isEmptyThread = computed(
  () =>
    !!props.session &&
    !props.loading &&
    props.messages.length === 0 &&
    !props.liveText &&
    !props.streaming,
);

function onScroll() {
  const el = scrollEl.value;
  if (!el) return;
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (distFromBottom < 64) {
    autoFollow.value = true;
    showEnd.value = false;
  } else {
    autoFollow.value = false;
    showEnd.value = true;
  }
}

function scrollToEnd() {
  autoFollow.value = true;
  showEnd.value = false;
  nextTick(() => {
    const el = scrollEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// Auto-follow the bottom on new content (unless the user scrolled up).
watch(
  () => [props.messages.length, props.liveText, props.phase],
  () => {
    if (!autoFollow.value) return;
    nextTick(() => {
      const el = scrollEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
);

// Reset follow state when switching sessions.
watch(
  () => props.session?.key,
  () => {
    autoFollow.value = true;
    showEnd.value = false;
    nextTick(() => {
      const el = scrollEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
);
</script>

<template>
  <main class="chat" :class="{ collapsed: sidebarCollapsed }">
    <!-- Header -->
    <header class="chat-head">
      <div class="chat-head-left">
        <h2 class="chat-title">{{ (session ? projectName : "Your Threads").toUpperCase() }}</h2>
        <span v-if="session" class="chat-sub">
          {{ session.name }}
          <span class="sep">·</span>
          <span class="state-badge" :data-state="session.state">
            <span class="dot"></span>{{ stateLabel(session.state) }}
          </span>
          <span v-if="session.noInbox" class="noinbox">noInbox</span>
        </span>
      </div>
      <ThemeToggle />
    </header>

    <!-- No thread selected -->
    <div v-if="!session" class="no-session">
      <div class="no-session-card">
        <p class="ns-title">Pick a thread to continue</p>
        <p class="ns-sub">Select something from the Inbox or a project on the left.</p>
      </div>
    </div>

    <!-- Thread body -->
    <div v-else class="chat-body" :class="{ 'is-empty': isEmptyThread }">
      <!-- Loading state: history fetch in flight -->
      <div v-if="loading" class="loading-state">
        <span class="pulse"></span> loading conversation…
      </div>

      <div v-show="!isEmptyThread && !loading" ref="scrollEl" class="messages" @scroll="onScroll">
        <div class="messages-inner">
          <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
            <div v-if="m.role === 'user'" class="bubble">
              <p class="msg-text">{{ m.text }}</p>
            </div>
            <MarkdownView v-else :text="m.text" />
          </div>

          <!-- Live streaming reply -->
          <div v-if="liveText || streaming" class="msg assistant live">
            <MarkdownView :text="liveText" />
            <span v-if="streaming" class="cursor">▍</span>
            <div v-if="streaming && phase" class="phase">
              <span class="pulse"></span> {{ phase }}
            </div>
          </div>
        </div>
      </div>

      <!-- Scroll-to-end pill -->
      <button v-if="showEnd" class="scroll-end" @click="scrollToEnd">↓ Scroll to end</button>

      <!-- Composer -->
      <Composer
        :models="models"
        :model-id="modelId"
        :thinking-level="thinkingLevel"
        :streaming="streaming"
        @send="emit('send', $event)"
        @abort="emit('abort')"
        @model="emit('model', $event)"
        @thinking="emit('thinking', $event)"
      />
    </div>
  </main>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--chat-bg);
  grid-column: 2;
  min-width: 0;
  /* focus pit: subtle inset on top + left edge so the chat reads as recessed */
  box-shadow: var(--pit-shadow);
}
.chat.collapsed .chat-head {
  padding-left: 50px;
}

.chat-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  min-height: 56px;
}
.chat-head-left {
  min-width: 0;
}
.chat-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat-sub {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: var(--text-soft);
  margin-top: 2px;
}
.sep {
  color: var(--text-faint);
}

/* state badge = colored dot + all-caps label */
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
.noinbox {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
}

/* No-thread empty state */
.no-session {
  flex: 1;
  display: grid;
  place-items: center;
}
.no-session-card {
  text-align: center;
  color: var(--text-soft);
}
.ns-title {
  margin: 0 0 4px;
  font-weight: 600;
  font-size: 17px;
  color: var(--text);
}
.ns-sub {
  margin: 0;
  font-size: 15px;
}

/* Thread body */
.chat-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 16px 8px;
}
.messages-inner {
  max-width: 64rem;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Messages */
.msg {
  width: 100%;
}
.msg.user {
  display: flex;
  justify-content: flex-end;
}
.msg.user .bubble {
  max-width: 80%;
  padding: 9px 13px;
  border-radius: 14px;
  background: var(--user-bubble-bg);
  color: var(--user-bubble-text);
  border: 1px solid var(--user-bubble-border);
}
.msg-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg.assistant {
  width: 100%;
}
.msg.assistant.live {
  width: 100%;
}

.cursor {
  display: inline-block;
  margin-left: 1px;
  animation: blink 1s steps(2) infinite;
  color: var(--text-faint);
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
.phase {
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-faint);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text);
  animation: pulse 1.1s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
}

/* Loading state (history fetch in flight) */
.loading-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-faint);
}

/* Scroll-to-end pill */
.scroll-end {
  position: absolute;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  z-index: 10;
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--bg);
  color: var(--text-soft);
  box-shadow: var(--shadow);
}
.scroll-end:hover {
  color: var(--text);
  background: var(--bg-soft-2);
}

/* Composer layout override for the empty-thread case: center the composer in
   the pane. (Composer.vue owns the composer's own styling; a parent's scoped
   CSS still reaches the child's root element, so this override works.) */
.chat-body.is-empty .composer {
  margin: auto;
}
</style>
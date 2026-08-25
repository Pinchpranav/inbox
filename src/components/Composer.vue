<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { ModelEntry } from "../data/domain";

// build-gw6.5.1: the chat composer. Lives at the bottom of ChatView.
// Input shell (top): ＋ attach stub, auto-grow textarea, send ↑ → ■ stop while streaming.
// Control row (bottom): [Model ▾] + [thinking: off ▾] (click + Shift+Tab cycle).
const props = defineProps<{
  models: ModelEntry[];
  modelId: string | null;
  thinkingLevel: string | null;
  streaming: boolean;
}>();

const emit = defineEmits<{
  send: [text: string];
  abort: [];
  model: [id: string];
  thinking: [level: string];
}>();

// ── Input shell ────────────────────────────────────────────────────────
const draft = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const taEl = ref<HTMLTextAreaElement | null>(null);

const currentModel = computed<ModelEntry | undefined>(() =>
  props.models.find((m) => m.id === props.modelId) ?? props.models[0],
);

// Attach stub: open the native picker (no model wiring yet — phase-2 per gw6).
function onAttach() {
  fileInput.value?.click();
}
function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  // Stub: we don't send the file anywhere yet; just clear the input.
  input.value = "";
}

function autoGrow() {
  const el = taEl.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

function send() {
  const text = draft.value.trim();
  if (!text || props.streaming) return;
  emit("send", text);
  draft.value = "";
  nextTick(autoGrow);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

watch(draft, () => nextTick(autoGrow));

// ── Control row: model picker ───────────────────────────────────────────
const modelOpen = ref(false);
const modelRef = ref<HTMLElement | null>(null);

function pickModel(id: string) {
  emit("model", id);
  modelOpen.value = false;
}

// ── Control row: thinking pill ──────────────────────────────────────────
const THINKING_LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Levels this model actually supports (off + the map's non-null keys).
const availableLevels = computed<string[]>(() => {
  const map = currentModel.value?.thinkingLevelMap;
  if (!map) return ["off"];
  const keys = Object.keys(map).map((k) => k.toLowerCase());
  return ["off", ...THINKING_LADDER.filter((l) => keys.includes(l))];
});

const supportsThinking = computed(() => availableLevels.value.length > 1);

const currentThinking = computed(() => {
  const lvl = props.thinkingLevel ?? "off";
  return availableLevels.value.includes(lvl) ? lvl : "off";
});

// Cycle to the next level (Shift+Tab = previous). Wraps around.
function cycleThinking(dir: 1 | -1 = 1) {
  if (!supportsThinking.value) return;
  const idx = availableLevels.value.indexOf(currentThinking.value);
  const next = (idx + dir + availableLevels.value.length) % availableLevels.value.length;
  emit("thinking", availableLevels.value[next]);
}

function onThinkingKeydown(e: KeyboardEvent) {
  if (e.key === "Tab") {
    e.preventDefault();
    cycleThinking(e.shiftKey ? -1 : 1);
  }
}
</script>

<template>
  <footer class="composer">
    <!-- Input shell -->
    <div class="shell">
      <button class="attach" title="Attach file (stub)" @click="onAttach">＋</button>
      <input ref="fileInput" type="file" class="file-input" @change="onFileChange" />
      <textarea
        ref="taEl"
        v-model="draft"
        class="input"
        :placeholder="streaming ? 'Generating…' : 'Message. Enter to send, Shift+Enter for newline.'"
        :disabled="streaming"
        rows="1"
        @keydown="onKeydown"
      />
      <button v-if="!streaming" class="send" :disabled="!draft.trim()" @click="send">↑</button>
      <button v-else class="stop" title="Stop" @click="$emit('abort')">■</button>
    </div>

    <!-- Control row -->
    <div class="controls">
      <div ref="modelRef" class="picker">
        <button class="pill" :disabled="!models.length" @click="modelOpen = !modelOpen">
          {{ currentModel ? currentModel.name : "Model ▾" }}
        </button>
        <div v-if="modelOpen" class="menu" @mouseleave="modelOpen = false">
          <button
            v-for="m in models"
            :key="m.id"
            class="menu-item"
            :class="{ current: m.id === (currentModel?.id ?? null) }"
            @click="pickModel(m.id)"
          >
            {{ m.name }}
          </button>
        </div>
      </div>

      <button
        class="pill thinking"
        :class="{ disabled: !supportsThinking }"
        :disabled="!supportsThinking"
        :title="supportsThinking ? 'Click to cycle · Shift+Tab for previous' : 'This model has no thinking levels'"
        @click="cycleThinking(1)"
        @keydown="onThinkingKeydown"
      >
        thinking: {{ currentThinking }} ▾
      </button>
    </div>
  </footer>
</template>

<style scoped>
.composer {
  width: 100%;
  max-width: 48rem;
  margin: 0 auto;
  padding: 10px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: transparent;
  box-sizing: border-box;
}

/* Input shell */
.shell {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 10px 10px 10px 8px;
  min-height: 56px;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.04);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.shell:focus-within {
  border-color: var(--border);
  box-shadow: none;
}
.attach {
  flex: none;
  width: 38px;
  height: 38px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--bg-soft);
  color: var(--text-soft);
  font-size: 19px;
  line-height: 1;
}
.attach:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.file-input {
  display: none;
}
.input {
  flex: 1;
  min-width: 0;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  line-height: 1.5;
  font-family: inherit;
  font-size: 14px;
  min-height: 24px;
  max-height: 200px;
  padding: 8px 4px;
  overflow-y: auto;
}
.input::placeholder {
  color: var(--text-soft);
  opacity: 0.75;
}
.input:disabled {
  opacity: 0.6;
}
.send,
.stop {
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  font-weight: 600;
  font-size: 17px;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.send {
  background: var(--accent);
  color: var(--accent-contrast);
  border: none;
}
.send:hover:not(:disabled) {
  opacity: 0.9;
}
.send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.stop {
  background: transparent;
  color: var(--text);
  border: 1px solid var(--border-strong);
}
.stop:hover {
  background: var(--bg-soft-2);
}

/* Control row */
.controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.picker {
  position: relative;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-soft);
  color: var(--text-soft);
  font-size: 13.5px;
  line-height: 1;
  cursor: pointer;
}
.pill:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-strong);
}
.pill:disabled,
.pill.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 30;
  min-width: 240px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  box-shadow: var(--shadow);
  padding: 6px;
}
.menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
}
.menu-item:hover {
  background: var(--bg-soft-2);
}
.menu-item.current {
  background: var(--bg-soft-2);
  color: var(--text-soft);
}
</style>

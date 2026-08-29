<script setup lang="ts">
import { ref, watch } from "vue";
import type { BackendConfig } from "../config";

const props = defineProps<{
  open: boolean;
  config: BackendConfig;
  conn?: "ok" | "loading" | "error";
  connError?: string;
}>();

const emit = defineEmits<{
  save: [cfg: BackendConfig];
  clear: [];
  close: [];
}>();

const url = ref(props.config.url);

watch(
  () => props.open,
  (open) => {
    if (open) {
      url.value = props.config.url;
    }
  },
);

function save() {
  emit("save", { url: url.value.trim() });
}
</script>

<template>
  <div v-if="open" class="overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h2>Backend settings</h2>
        <button class="x" title="Close" @click="$emit('close')">×</button>
      </div>

      <p class="hint">
        Connect the sidebar to the Hono backend (<code>/api</code>). Leave blank to use the
        same-origin backend (Vite proxy in dev, nginx in prod).
      </p>

      <label class="field">
        <span>Backend URL</span>
        <input
          v-model="url"
          type="text"
          placeholder="http://localhost:8787"
          autocomplete="off"
          spellcheck="false"
        />
      </label>

      <div class="status">
        <span class="dot" :data-conn="conn ?? 'loading'"></span>
        <span class="status-text">
          <template v-if="conn === 'ok'">Connected</template>
          <template v-else-if="conn === 'loading'">Connecting…</template>
          <template v-else-if="conn === 'error'">{{
            connError || "Connection error"
          }}</template>
          <template v-else>Connection error</template>
        </span>
      </div>

      <div class="actions">
        <button class="ghost" @click="$emit('clear')">Clear</button>
        <button class="primary" @click="save">Save &amp; connect</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.modal {
  width: 100%;
  max-width: 440px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
  padding: 20px 22px 18px;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.modal-head h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}
.x {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  color: var(--text-soft);
  font-size: 20px;
  line-height: 1;
}
.x:hover {
  background: var(--bg-soft-2);
  color: var(--text);
}
.hint {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--text-soft);
  line-height: 1.5;
}
.hint code {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--bg-soft);
  padding: 1px 4px;
  border-radius: 4px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 14px;
}
.field span {
  font-size: 13px;
  color: var(--text-soft);
}
.field input {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 11px;
  background: var(--bg-soft);
  font-size: 14px;
  font-family: var(--font-mono);
}
.field input:focus {
  outline: none;
  border-color: var(--border-strong);
  background: var(--bg);
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 16px;
  font-size: 13px;
  color: var(--text-soft);
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1px solid var(--text-faint);
  flex: none;
}
.dot[data-conn="ok"] {
  background: var(--conn-ok);
  border-color: var(--conn-ok);
}
.dot[data-conn="loading"] {
  background: var(--conn-loading);
  border-color: var(--conn-loading);
}
.dot[data-conn="error"] {
  background: var(--conn-error);
  border-color: var(--conn-error);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.actions button {
  padding: 8px 16px;
  border-radius: 8px;
  font-size: 14px;
  border: 1px solid var(--border);
}
.ghost {
  color: var(--text-soft);
}
.ghost:hover {
  background: var(--bg-soft-2);
  color: var(--text);
}
.primary {
  background: var(--accent);
  color: var(--accent-contrast);
  border-color: var(--accent);
  font-weight: 600;
}
.primary:hover {
  opacity: 0.9;
}
</style>
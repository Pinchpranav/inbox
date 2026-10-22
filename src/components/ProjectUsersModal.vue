<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { Project } from "../data/domain";
import * as api from "../api/projectsApi";
import { currentUser } from "../state/backend";

const props = defineProps<{ project: Project | null }>();
const emit = defineEmits<{ close: [] }>();

const users = ref<string[]>([]);
const email = ref("");
const error = ref("");
const busy = ref(false);
const input = ref<HTMLInputElement | null>(null);

/** The owner always has access; the list only shows people explicitly shared with. */
const shared = computed(() => users.value.filter((user) => user !== currentUser.value?.email));

let request = 0; // bumps on every project change, invalidating responses for old projects

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function load(projectId: string, current: number): Promise<void> {
  busy.value = true;
  try {
    const rows = await api.getProjectUsers(projectId);
    if (request === current) users.value = rows;
  } catch (err) {
    if (request === current) error.value = reason(err);
  } finally {
    if (request === current) busy.value = false;
  }
}

watch(
  () => props.project?.id,
  async (projectId) => {
    const current = ++request;
    users.value = [];
    email.value = "";
    error.value = "";
    busy.value = false;
    if (!projectId) return;

    await load(projectId, current);
    await nextTick();
    if (request === current) input.value?.focus(); // Esc works once focus is inside the panel
  },
);

async function change(remove?: string): Promise<void> {
  const project = props.project;
  if (!project || busy.value) return;
  if (remove && !window.confirm(`Remove ${remove} from ${project.name}?`)) return;

  const current = request;
  busy.value = true;
  error.value = "";
  try {
    if (remove) await api.revokeProjectAccess(project.id, remove);
    else await api.grantProjectAccess(project.id, email.value.trim());
    const rows = await api.getProjectUsers(project.id);
    if (request === current) {
      users.value = rows;
      if (!remove) email.value = "";
    }
  } catch (err) {
    if (request === current) error.value = reason(err);
  } finally {
    if (request === current) busy.value = false;
  }
}
</script>

<template>
  <div
    v-if="project"
    class="backdrop"
    @click.self="emit('close')"
    @keydown.esc="emit('close')"
  >
    <section class="panel" role="dialog" aria-modal="true" aria-labelledby="users-title">
      <header class="head">
        <div class="titles">
          <h2 id="users-title">Project users</h2>
          <p class="subtitle">{{ project.name }}</p>
        </div>
        <button class="close" type="button" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <div class="body">
        <p class="lede">
          Everyone listed here can read and change every conversation in this project.
        </p>

        <form class="add" @submit.prevent="change()">
          <input
            ref="input"
            v-model="email"
            type="email"
            placeholder="name@example.com"
            aria-label="Email address to grant access"
            required
            :disabled="busy"
          />
          <button type="submit" :disabled="busy || !email.trim()">Add</button>
        </form>

        <p v-if="error" class="error" role="alert">{{ error }}</p>

        <div class="list">
          <p class="row owner">
            <span class="who">{{ currentUser?.email }}</span>
            <span class="tag">Owner</span>
          </p>

          <p v-if="busy && !users.length" class="row empty">Loading users…</p>

          <ul v-else-if="shared.length">
            <li v-for="user in shared" :key="user" class="row">
              <span class="who">{{ user }}</span>
              <button class="remove" type="button" :disabled="busy" @click="change(user)">
                Remove
              </button>
            </li>
          </ul>

          <p v-else class="row empty">Private for now. Add an email above to share this project.</p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.45);
}

.panel {
  display: flex;
  flex-direction: column;
  width: min(100%, 440px);
  max-height: 85vh;
  overflow: hidden;
  color: var(--text);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
}

/* ── header ─────────────────────────────────────────────── */
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border);
}
.titles {
  min-width: 0;
}
h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.subtitle {
  margin: 2px 0 0;
  overflow: hidden;
  font-size: 13px;
  color: var(--text-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.close {
  flex: none;
  width: 28px;
  height: 28px;
  font-size: 18px;
  line-height: 1;
  color: var(--text-soft);
  border: 1px solid transparent;
  border-radius: 7px;
}
.close:hover {
  color: var(--text);
  border-color: var(--border);
}

/* ── body ───────────────────────────────────────────────── */
.body {
  padding: 16px 20px 20px;
  overflow-y: auto;
}
.lede {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-soft);
}

.add {
  display: flex;
  gap: 8px;
}
.add input {
  flex: 1;
  min-width: 0;
  padding: 9px 11px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 7px;
}
.add input:focus {
  outline: none;
  border-color: var(--border-strong);
}
.add button {
  flex: none;
  padding: 9px 14px;
  color: var(--accent-contrast);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 7px;
}
.add button:disabled {
  opacity: 0.4;
  cursor: default;
}

.error {
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--conn-error);
}

/* ── user list ──────────────────────────────────────────── */
.list {
  margin-top: 16px;
}
.list ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 0;
  padding: 9px 0;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}
.owner {
  border-top: 1px solid var(--border);
}
.who {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 12px;
}
.tag {
  flex: none;
  padding: 1px 7px;
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-soft);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.empty {
  color: var(--text-faint);
}
.remove {
  flex: none;
  padding: 5px 10px;
  font-size: 12px;
  color: var(--text-soft);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.remove:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-strong);
}
.remove:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>

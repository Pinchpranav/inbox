<script setup lang="ts">
import { stateLabel, type Session, type State } from "../data/domain";

const props = defineProps<{
  s: Session;
  selected: boolean;
  menuOpen: boolean;
}>();

const emit = defineEmits<{
  select: [];
  "set-state": [state: State];
  "toggle-no-inbox": [];
  move: [];
  "toggle-menu": [];
}>();

const STATES: State[] = ["active", "deferred", "done"];
</script>

<template>
  <div class="row-wrap">
    <button class="row" :class="{ selected }" :data-state="s.state" @click="$emit('select')">
      <span class="dot" :data-state="s.state"></span>
      <span class="row-name">{{ s.name }}</span>
      <span v-if="s.noInbox" class="noinbox">noInbox</span>
    </button>
    <div class="menu">
      <button class="menu-btn" @click="$emit('toggle-menu')">⋯</button>
      <div v-if="menuOpen" class="dropdown">
        <div class="dd-label">Set state</div>
        <button
          v-for="st in STATES"
          :key="st"
          class="dd-item"
          :class="{ current: s.state === st }"
          @click="$emit('set-state', st)"
        >{{ stateLabel(st) }}</button>
        <hr />
        <button class="dd-item" @click="$emit('toggle-no-inbox')">
          {{ s.noInbox ? "Remove from noInbox" : "Add to noInbox" }}
        </button>
        <hr />
        <button class="dd-item" @click="$emit('move')">Move to project…</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.row {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 7px;
  text-align: left;
  color: var(--text);
  min-width: 0;
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
.row[data-state="deferred"] .row-name,
.row[data-state="done"] .row-name {
  color: var(--text-soft);
}
.noinbox {
  font-size: 11px;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
  white-space: nowrap;
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

.menu {
  position: relative;
}
.menu-btn {
  padding: 2px 6px;
  color: var(--text-faint);
  border-radius: 6px;
}
.menu-btn:hover {
  color: var(--text);
  background: var(--bg-soft-2);
}
.dropdown {
  position: absolute;
  right: 4px;
  top: 100%;
  z-index: 20;
  min-width: 180px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow);
  padding: 6px;
}
.dd-label {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  padding: 2px 6px;
}
.dd-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 8px;
  border-radius: 6px;
  color: var(--text);
}
.dd-item:hover {
  background: var(--bg-soft-2);
}
.dd-item.current {
  color: var(--text-faint);
}
hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 4px 0;
}
</style>
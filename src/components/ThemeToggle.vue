<script setup lang="ts">
import { onMounted, ref } from "vue";

const theme = ref<"light" | "dark">("light");

function apply(t: "light" | "dark") {
  theme.value = t;
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("mvp-theme", t);
}

function toggle() {
  apply(theme.value === "light" ? "dark" : "light");
}

onMounted(() => {
  const saved = localStorage.getItem("mvp-theme");
  apply(saved === "dark" ? "dark" : "light");
});
</script>

<template>
  <button class="theme-toggle" @click="toggle" :title="theme === 'light' ? 'Dark mode' : 'Light mode'">
    <span class="icon" aria-hidden="true">{{ theme === "light" ? "☾" : "☀" }}</span>
  </button>
</template>

<style scoped>
.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text-soft);
  background: var(--bg);
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.theme-toggle:hover {
  color: var(--text);
  border-color: var(--border-strong);
  background: var(--bg-soft);
}
.icon {
  font-size: 14px;
  line-height: 1;
}
</style>
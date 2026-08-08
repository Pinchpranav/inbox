<script setup lang="ts">
import { computed } from "vue";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";

// Mirror openclaw's renderer (markdown-it) but in plain Vue. Config:
//   html:false  -> raw HTML is escaped (safe, no DOMPurify needed for MVP)
//   breaks:true -> single newlines become <br>
//   linkify     -> bare URLs auto-linked
//   strikethrough + task lists (read-only)
// Code blocks render in grayscale monospace (no syntax-token colors) to keep
// "color = data only".
const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
});
md.enable("strikethrough");
md.use(taskLists, { enabled: false, label: false });

const props = defineProps<{ text: string }>();
const html = computed(() => md.render(props.text ?? ""));
</script>

<template>
  <div class="md" v-html="html"></div>
</template>

<style scoped>
.md :deep(p) {
  margin: 0 0 0.75em;
}
.md :deep(p:last-child) {
  margin-bottom: 0;
}
.md :deep(h1),
.md :deep(h2),
.md :deep(h3) {
  margin: 1.2em 0 0.5em;
  font-weight: 600;
  line-height: 1.3;
}
.md :deep(h1) {
  font-size: 1.3em;
}
.md :deep(h2) {
  font-size: 1.15em;
}
.md :deep(h3) {
  font-size: 1.05em;
}
.md :deep(ul),
.md :deep(ol) {
  margin: 0 0 0.75em;
  padding-left: 1.4em;
}
.md :deep(li) {
  margin: 0.2em 0;
}
.md :deep(li:last-child) {
  margin-bottom: 0;
}
.md :deep(a) {
  color: var(--text);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.md :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--bg-soft-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.1em 0.35em;
}
.md :deep(pre) {
  margin: 0 0 0.8em;
  padding: 12px 14px;
  background: var(--bg-soft-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow-x: auto;
}
.md :deep(pre code) {
  font-family: var(--font-mono);
  font-size: 0.88em;
  background: none;
  border: none;
  padding: 0;
  color: var(--text);
  white-space: pre;
}
.md :deep(blockquote) {
  margin: 0 0 0.8em;
  padding: 0 0 0 0.9em;
  border-left: 3px solid var(--border-strong);
  color: var(--text-soft);
}
.md :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}
.md :deep(table) {
  border-collapse: collapse;
  margin: 0 0 0.8em;
  font-size: 0.95em;
}
.md :deep(th),
.md :deep(td) {
  border: 1px solid var(--border);
  padding: 5px 9px;
  text-align: left;
}
.md :deep(th) {
  background: var(--bg-soft);
  font-weight: 600;
}
/* task list checkboxes — read-only, grayscale */
.md :deep(input[type="checkbox"]) {
  margin-right: 0.4em;
  accent-color: var(--text-faint);
}
</style>
# Pi-Powered Sidebar Agent — Functionality Spec (V4, LOCKED)

**Status:** LOCKED (2026-08-11). All of Pranav's V2 edits + six doubt-resolutions folded in.
**Purpose:** Plain-language spec of **what this thing does and why it exists** — the behavior contract. System/contracts docs (next) pin the *how*. Mechanism names (sqlite, dolt, beads, herdr) appear only as behavior implications; the detail belongs to later docs.

---

## 0. The model in one breath

A **personal AI coding agent that comes with an opinionated way of organizing your work.** You open a **project**, pick a **conversation** (mostly from the inbox), and the agent works — reads files, edits code, runs commands — and **streams its replies live**. Each project is its **own separate agent with its own context**. It runs **24/7 on your VPS** (kept alive with herdr), so you can leave work running and pick it up from anywhere.

---

## 1. Why this exists

The larger vision (the north star, not the MVP): a **personal AI** that gives you a personalized, cohesive experience and insights **across all your projects together** — where the opinionated organization lowers your cognitive load, so you stop thinking "did I do this? did I do that?" It becomes automatic.

Four concrete reasons:

1. **Personal AI in the shape *I* want.** The last attempt leaned on OpenClaw, which became a liability — the abstractions got in the way, and its structure went against the grain of how I organize work (inbox / projects / conversations). Building on top of it failed. The learning: build a **minimally abstracted application** that serves as "my AI-everything thing" — whatever I want to do with AI, I do through it. I already trust pi as my agent harness, so I build my own abstractions on top of pi.

2. **pi is a great engine, but the wrong thing to store state in.** pi does the thinking/acting well, but its session storage is ephemeral and per-folder — not queryable, not versioned, not a source of truth. So pi stays the **brain**, and the **state lives somewhere we own** (our own database + versioned memory). For the state-storing side, we copy t3code's approach.

3. **Self-hosting + your own models.** Runs on my VPS. Inference via **ollama-cloud**.

4. **Persistence / 24-7.** The agent stays alive on the VPS and keeps working; it remembers across restarts, so long-running work isn't lost.

**A governing philosophy throughout — lazy loading.** The agent is *told* what exists (files, memory, specialist agents) but only *loads* them when it judges it necessary. Knowing something exists ≠ reading it all up front. This keeps each agent lean and keeps token cost down.

---

## 2. Conversations (the core)

- You open a project, see its conversations — **or, more likely, you see the conversation in the inbox and jump straight to it.**
- A conversation is a **durable record** — it reloads exactly as you left it (messages, history) after a browser refresh or a restart. The transcript is preserved.

### 2.1 Starting a conversation
- You can start a new conversation in any project. It appears in that project's list.

### 2.2 What "the agent does" in a conversation
- It can **read your files, edit code, run commands** — it's an agent, not a chatbot.
- **MVP shows text replies only.** No tool-call/segment rendering in the UI for now.

---

## 3. Projects

- **Every project = its own separate agent**, with its own conversations and its own memory. Projects group related work.
- **The `main` agent is the main/admin agent.** Nothing special as a *project* — but it's the agent that **knows all the other projects exist** and can see across them.
- A project can be in one of three states: **active / deferred / done**.

### 3.1 Creating a project
- You create a project (name + a folder/working directory). It appears in the project list.
- On creation, it gets a set of **openclaw-style `.md` files** (e.g. `AGENTS.md`, `USER.md`, `SOUL.md`, and similar) that define the project's agent.
- **No `MEMORY.md`** — memory is handled by the Beads/dolt layer instead (see §6).

### 3.2 Specialist agents are projects too
- The specialists a project agent can call (web search, memory) are **themselves projects** — e.g. a "web project," a "memory (librarian) project."
- A project agent knows these specialists exist (lazy-loaded) and calls one when a task needs it.

---

## 4. Inbox

- A **pick-up rail**: the conversations you're most likely to resume. The **default place to enter**.
- Shows **active conversations touched in the last 2 days**, across **all projects** (including `main`).
- Row shows **conversation name + project name** only. Sorted most-recent-first.
- Purpose: "what should I pick up next?" with zero friction.

### 4.1 What appears in the inbox
- Active + touched within 48h + across all projects. Unknown "last touched" → include it.

### 4.2 What's excluded
- Not active (deferred/done), **or** flagged `noInbox`, **or** untouched for more than 2 days.

### 4.3 The `noInbox` flag
- An independent on/off flag. When set, a conversation **never shows in the inbox** — regardless of state or recency.
- Does **not** change the conversation's state, does **not** remove it from its project. Purpose: "ongoing but stop nagging me."

---

## 5. State (active / deferred / done)

- **Project state** and **conversation state** are two **independent** levels: a project can be `done` while its conversations are still `active`, and vice-versa.
- The project list can be filtered by project state (All / Active / Deferred / Done).
- Inside a project, conversations can be filtered by conversation state.

---

## 6. Memory (the remembering part)

- The agent **remembers what it was doing in a project across sessions** — across days, refreshes, restarts.
- At minimum: open a project and ask "**what were we working on?**" and it answers from that project's memory.
- **Two separate stores, both MVP:**
  - **Session storage** (sqlite, t3code-style) = the durable transcript of conversations.
  - **Project memory** (dolt, guided by Beads) = what we're working on / done / next — the project-level memory that travels with the project.
- **All projects' Beads live in one shared dolt database**, scoped per project (each project has its own beads within the shared DB → per-project memory). The `main` agent knows all these projects exist and can see across them.
- A project's memory **travels with the project's working directory** — `cd` deep into a nested folder and the agent still sees the project's memory, not an empty folder.
- **Moving a conversation between projects:** transcript is preserved, but it **restarts on the new project's memory** (context resets; the history is still there to read/ask about).

---

## 7. Agent identity (who the agent is)

- Each project carries plain markdown files at its root that define its agent's **personality / behavior / how it works / tools available** (the `.md` files created in §3.1).
- These are **ordinary editable files** — you edit them like any doc; they take effect when the agent next reads them. **In MVP.**

---

## 8. Scheduled work (crons) — **IN MVP**

- You can schedule the agent to run something **recurring** (e.g. "every morning, summarize X").
- Runs happen even when you're not looking; **results are durable and recorded — not ephemeral.**
- Cron outputs **surface on top of your inbox** as a conversation you can open and **continue** — you choose when to engage.

---

## 9. Specialist sub-agents — **IN MVP**

- Specialist agents (web search, memory/librarian, …) exist as **their own projects**.
- A project's agent can **call a specialist when a task needs it** (lazy-loaded — it knows it exists, loads it on demand).
- Purpose: **keep each project's agent lean** — avoids the bloat I ran into with OpenClaw.
- From your perspective: you just ask; the agent pulls in the right specialist. You don't think about it.

---

## 10. Defaults and edge cases

| Thing | Default | Rule |
|---|---|---|
| Project state | `active` | Every new project starts active. |
| Conversation state | `active` | Every new conversation starts active. |
| Project tab | `All` | Shows everything until filtered. |
| Inbox window | 48h | Active + touched within 48h, all projects. |
| "last touched" unknown | treated recent | Included in inbox. |
| `noInbox` | off | Independent flag; hides from inbox regardless of state/recency. |
| Conversation reopen | exact state | Reloads with full history after refresh/restart; transcript preserved. |
| Conversation moved to another project | transcript kept, new memory | Context resets to the destination project's memory; history still readable. |

---

## 11. Non-goals (explicitly out of MVP)

- Tool-call / segment rendering in chat — text replies only.
- Multi-user / permissions — single-user.
- Mobile apps — web UI in a browser is enough.
- Building our own model-training / model-hosting.

---

## 12. Resolved decisions (from the V2 review)

1. **Agent topology:** every project = its own agent. `main` = the main/admin agent that knows all projects exist. Specialist agents (web, memory) are themselves projects. Lazy loading is the governing philosophy — an agent knows something exists and loads it when needed.
2. **Context isolation across moves:** transcript preserved, new project memory (context resets).
3. **Cron conversations:** durable, surface in inbox, conversation can continue.
4. **`main` project:** nothing special as a project; it's the admin agent that sees across all projects.
5. **Memory scope:** per-project memory; all beads live in one shared dolt DB (scoped per project); main knows all projects exist.
6. **MVP surface:** the full thing — UI + backend structure + DB + all essentials (conversations, projects, inbox, two-level state, memory, crons, subagents, identity files). Simple, not a pared-down Q&A.

---

*Functionality spec LOCKED 2026-08-11. Next: System design doc.*

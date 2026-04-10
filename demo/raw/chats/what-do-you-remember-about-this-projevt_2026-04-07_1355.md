---
tags:
- demo
---

# Chat — 2026-04-07 13:55
Session: 1b28e13c-2869-486b-9208-37d2756b3762

## You

what do you remember about this projevt

<details>
<summary>Thought</summary>

The user is asking what I remember about this project. Let me check my memory files.The user is asking what I remember about this project. Let me check my memory files.

</details>

<details>
<summary>Read 3 files</summary>

- **Read** — /Users/ckausik/.claude/projects/-Users-ckausik-Documents-GitHub-loom/memory/MEMORY.md
  - 1	- [Settings cleanup done](feedback_settings_cleanup.md) — settings.local.json cleaned up 2026-04-07, don't redo
2	- [Wiki as context substrate](project_wiki_context_plan.md) — plan for CLAUDE.md, memory, conventions as wiki pages. Awaiting user review.
3	- [Transformer LR tuned](project_lr_tuned.md) — learning rate tuned to 3e-4 for transformer project
4	
- **Read** — /Users/ckausik/.claude/projects/-Users-ckausik-Documents-GitHub-loom/memory/project_lr_tuned.md
  - 1	---
2	name: transformer-lr-tuned
3	description: Transformer project learning rate tuned to 3e-4 after experimentation
4	type: project
5	---
6	
7	Learning rate for the transformer-from-scratch project was tuned to 3e-4.
8	
9	**Why:** Result of hyperparameter tuning by the user.
10	**How to apply:** Use 3e-4 as the known-good LR baseline when discussing training config or suggesting changes. Don't suggest re-tuning unless there's a specific reason (e.g., architecture change, different dataset scale).
11	
- **Read** — /Users/ckausik/.claude/projects/-Users-ckausik-Documents-GitHub-loom/memory/project_wiki_context_plan.md
  - 1	---
2	name: Wiki context substrate — implemented, TODO remaining
3	description: Modular context pipeline implemented. Remaining: tex compilation, code/wiki review agents, memory end-to-end testing, PDF examples.
4	type: project
5	---
6	
7	Context pipeline implemented (2026-04-07). See TODO.md for remaining work.
8	
9	**What's done:**
10	- Bootstrap creates CLAUDE.md, conventions.md, memory dir, settings.json, config.yaml
11	- build_system_prompt refactored into modular blocks (_permissions, _memory, _location)
12	- Agent SDK uses preset+append with setting_sources=["project"]
13	- MEMORY.md + loom internals hidden from canvas (togglable in settings)
14	- Bring-to-front on click for floating panels and cards
15	- No-cache middleware for static files
16	- Demo loom in repo at demo/
17	- 300 tests, docs updated
18	
19	**Remaining (see TODO.md):**
20	- TeX compilation with side-by-side PDF preview
21	- PDF examples in demo loom
22	- Code review agent (multi-agent, like Claude Code's)
23	

</details>

## Claude

Let me check my memory files.Here's what I remember:

1. **Transformer LR tuned to 3e-4** — this is the known-good baseline for the transformer-from-scratch project. No need to re-tune unless the architecture or dataset changes significantly.

2. **Wiki context pipeline is implemented** — the modular context system (CLAUDE.md, conventions, memory injection) is done. Remaining work includes TeX compilation, PDF examples, code/wiki review agents, and memory end-to-end testing. Details in `TODO.md`.

3. **Settings cleanup** — `settings.local.json` was cleaned up today, don't redo.

From the page you're viewing, I also see the **transformer-from-scratch** project status: sorting task and EN→DE translation are working, LR warmup schedule is in place, and **next steps are BPE tokenization and beam search decoding**.

## You

Some of this is unrelated to this project

<details>
<summary>Thought</summary>

The user is pointing out that some of my memories aren't specific to the transformer-from-scratch project. They're right — the wiki context pipeline and settings cleanup are about the loom tool itself, not the transformer project.

What's actually relevant to this project:
- LR tuned to 3e-4
- Sorting + translation working, LR warmup done, next: BPE + beam searchThe user is pointing out that some of my memories aren't specific to the transformer-from-scratch project. They're right — the wiki context pipeline and settings cleanup are about the loom tool itself, not the transformer project.

What's actually relevant to this project:
- LR tuned to 3e-4
- Sorting + translation working, LR warmup done, next: BPE + beam search

</details>

## Claude

You're right. The wiki context pipeline and settings cleanup are about loom itself, not the transformer project.

What I actually remember about **this project**:

- **LR tuned to 3e-4** — known-good baseline, don't re-tune without reason.
- Sorting and EN→DE translation are working, LR warmup is in place.
- **Next up: BPE tokenization and beam search decoding.**

That's it for project-specific memory.

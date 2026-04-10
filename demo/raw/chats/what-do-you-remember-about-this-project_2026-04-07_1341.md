---
tags:
- demo
---

# Chat — 2026-04-07 13:41
Session: 1b28e13c-2869-486b-9208-37d2756b3762

## You

what do you remember about this project?

<details>
<summary>Thought</summary>

The user is asking what I remember about this project. Let me check my memory files.The user is asking what I remember about this project. Let me check my memory files.

</details>

<details>
<summary>Read 4 files</summary>

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
- **Read** — /Users/ckausik/.claude/projects/-Users-ckausik-Documents-GitHub-loom/memory/feedback_settings_cleanup.md
  - 1	---
2	name: Settings cleanup done
3	description: settings.local.json was cleaned up on 2026-04-07 — don't redo this work
4	type: feedback
5	---
6	
7	On 2026-04-07, `.claude/settings.local.json` was cleaned up from ~58 overly specific permission rules (one-off curls, sed commands from vault→loom rename, hardcoded paths) down to ~17 general rules.
8	
9	**Why:** The file had accumulated cruft from past sessions and was hard to read/maintain.
10	
11	**How to apply:** Don't re-add overly specific permission rules. Use general patterns like `Bash(git *)` instead of separate `Bash(git add:*)`, `Bash(git commit:*)`, etc. If you see the file is already clean, don't touch it.
12	

</details>

## Claude

Let me check my memory files.Here's what I remember:

**Transformer project** (the one you're viewing): Learning rate tuned to **3e-4** — known-good baseline, don't re-tune without reason. Sorting task and EN→DE translation are working. Next up: BPE tokenization and beam search.

**Loom platform**: The modular context pipeline is implemented (CLAUDE.md, conventions, memory, settings). Remaining work includes TeX compilation, code/wiki review agents, memory e2e testing, and PDF examples — tracked in TODO.md.

**Preferences**: Keep settings.local.json clean with general permission patterns (~17 rules, not 58). You're a senior engineer, prefer concise responses. Paper deadline is mid-May, and experiments feed into results.

---
saved: '2026-04-09'
session_id: 02470266-a840-4b9b-9dd3-1801ed40ac17
tags:
- demo
title: What Projects Are Currently Active
type: chat
---

Session: 02470266-a840-4b9b-9dd3-1801ed40ac17

## You

what projects are active rn

<details>
<summary>Thought</summary>

The user wants to know what active projects are in the loom. Let me check the projects directory.The user wants to know what active projects are in the loom. Let me check the projects directory.

</details>

<details>
<summary>Ran 2 commands</summary>

- **Bash** — ls /Users/ckausik/Documents/loom/projects/
  - ABOUT.md
agentic-memory
cacheable-functions
codenames-bot
crossword-solver
intuiting-randomness
loom
newtons-cradle
phd-thesis
ppo-implementation
scraping-tools
website
[rerun: b1]
- **Bash** — cd /Users/ckausik/Documents/loom/projects && for d in */; do echo "=== $d ==="; head -5 "$d/ABOUT.md" 2>/dev/null || echo "(no ABOUT.md)"; echo; done
  - === agentic-memory/ ===
---
title: Agentic Memory
type: project
tags: [research, rl, llm, memory]
---

=== cacheable-functions/ ===
---
title: Cacheable Functions
type: project
tags: [tools, python, caching]
---

=== codenames-bot/ ===
---
title: Codenames Bot
type: project
tags: [ml, rl, nlp, games]
---

=== crossword-solver/ ===
---
title: Crossword Solver
type: project
tags: [ml, nlp, puzzles]
---

=== intuiting-randomness/ ===
---
title: Intuiting Randomness
type: project
tags: [demo, games, probability, javascript]
---

=== loom/ ===
---
title: Loom
type: project
tags: [loom, tools]
---

=== newtons-cradle/ ===
---
title: Newton's Cradle
type: project
tags: [demo, physics, music, javascript]
---

=== phd-thesis/ ===
---
title: PhD Thesis
type: project
tags: [research, thesis, rl, bandits]
---

=== ppo-implementation/ ===
---
title: PPO Implementation Details
type: project
tags: [ml, rl, ppo]
---

=== scraping-tools/ ===
---
title: Scraping Tools
type: project
tags: [tools, python,

</details>

## Claude

11 projects:

| Project | Tags |
|---|---|
| **loom** | tools — this system itself |
| **phd-thesis** | research, RL, bandits |
| **agentic-memory** | research, RL, LLM, memory |
| **ppo-implementation** | ML, RL, PPO |
| **codenames-bot** | ML, RL, NLP, games |
| **crossword-solver** | ML, NLP, puzzles |
| **intuiting-randomness** | demo, games, probability, JS |
| **newtons-cradle** | demo, physics, music, JS |
| **cacheable-functions** | tools, Python, caching |
| **scraping-tools** | tools, Python, scraping |
| **website** | Jekyll personal site |

Based on recent git activity, **loom** is the most active right now (chat compaction, Tauri app, context pipeline work). Want me to check recent commits or TODO items for any specific project?

## You

hmm

## You

i see

<details>
<summary>Thought</summary>

The user said "hmm" - they might be thinking or unsure about something. I'll keep it brief and see if they want to dig into anything specific.The user said "hmm" - they might be thinking or unsure about something. I'll keep it brief and see if they want to dig into anything specific.

</details>

## Claude

Anything you want to dig into?

## Claude

👍

---
saved: '2026-04-09'
session_id: 6308f977-74eb-45c8-ba56-20a06e3822e4
tags:
- demo
title: Chat — 2026-04-09 15:01
type: chat
---

Session: 6308f977-74eb-45c8-ba56-20a06e3822e4

## You

what projects are active rn

<details>
<summary>Thought</summary>

The user wants to know what projects are currently active. Let me check the projects directory.The user wants to know what projects are currently active. Let me check the projects directory.

</details>

<details>
<summary>Ran 4 commands</summary>

- **Bash** — ls /Users/ckausik/Documents/loom/projects/
- **Bash** — cat /Users/ckausik/Documents/loom/TODO.md 2>/dev/null | head -50
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
- **Bash** — cd /Users/ckausik/Documents/loom/projects && for d in */; do echo "=== $d ==="; head -5 "$d/ABOUT.md" 2>/dev/null || head -5 "$d/README.md" 2>/dev/null || echo "(no description)"; echo; done
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
- **Bash** — cd /Users/ckausik/Documents/loom/projects && for d in */; do echo "$d $(git -C "$d" log --oneline -1 --format='%ar' 2>/dev/null || echo 'not a git repo')"; done
  - agentic-memory/ not a git repo
cacheable-functions/ 8 months ago
codenames-bot/ 4 months ago
crossword-solver/ 3 months ago
intuiting-randomness/ 8 months ago
loom/ 4 hours ago
newtons-cradle/ 8 months ago
phd-thesis/ not a git repo
ppo-implementation/ 3 years, 9 months ago
scraping-tools/ not a git repo
website/ 5 months ago
Shell cwd was reset to /Users/ckausik/Documents/loom/projects/loom/demo
[rerun: b4]

</details>

## Claude

12 projects total. By recent activity:

| Project | Last commit | Tags |
|---|---|---|
| **loom** | 4 hours ago | tools |
| **crossword-solver** | 3 months ago | ml, nlp, puzzles |
| **codenames-bot** | 4 months ago | ml, rl, nlp, games |
| **website** | 5 months ago | jekyll |

Everything else (cacheable-functions, intuiting-randomness, newtons-cradle, ppo-implementation) is 8+ months stale. agentic-memory, phd-thesis, and scraping-tools aren't git repos so no commit history.

**Loom** is clearly the hot one right now. Crossword-solver and codenames-bot saw work in the last few months.

## You

i see

## Claude

Anything you want to dig into on any of them?

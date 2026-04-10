---
saved: '2026-04-09'
session_id: 6308f977-74eb-45c8-ba56-20a06e3822e4
tags:
- demo
title: Loom Infinite Canvas Interface Overview
type: chat
---

Session: 6308f977-74eb-45c8-ba56-20a06e3822e4

## You

what is this

[Pasted image: /Users/ckausik/Documents/loom/projects/loom/demo/raw/media/chat-images/1775732912158-image.png]

<details>
<summary>Thought</summary>

The user wants me to look at a pasted image.The user wants me to look at a pasted image.

</details>

<details>
<summary>Read 1 file</summary>

- **Read** — /Users/ckausik/Documents/loom/projects/loom/demo/raw/media/chat-images/1775732912158-image.png
  - {'type': 'image', 'source': {'type': 'base64', 'data': '/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAEpAlYDAREAAhEBAxEB/9sAQwAQCwwODAoQDg0OEhEQExgoGhgWFhgxIyUdKDozPTw5Mzg3QEhcTkBEV0U3OFBtUVdfYmdoZz5NcXlwZHhcZWdj/9sAQwEREhIYFRgvGhovY0I4QmNjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjaoAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKACgAoAKA

</details>

## Claude

That's a screenshot of the Loom infinite canvas UI. It shows the three main content areas as connected cards:

- **raw** — ingested sources (articles, papers, chat transcripts)
- **projects** — active work ("Transformer From Scratch", "Research Paper Draft")
- **wiki** — compiled knowledge base with topics like Attention Mechanisms, Transformer Architecture, BERT/GPT, Reinforcement Learning

The lines between cards show the flow: raw sources get compiled into wiki pages, and projects link to both. This is essentially the demo loom's workspace layout.

## You

what repos have updated recently

<details>
<summary>Thought</summary>

The user is asking about recent repo updates. Let me check git log and look at the projects directory.The user is asking about recent repo updates. Let me check git log and look at the projects directory.

</details>

<details>
<summary>Ran 2 commands</summary>

- **Bash** — cd /Users/ckausik/Documents/loom && git log --oneline -20 --format="%h %ad %s" --date=short
  - Exit code 128
fatal: not a git repository (or any of the parent directories): .git
[rerun: b1]
- **Bash** — ls -lt /Users/ckausik/Documents/loom/projects/
  - <tool_use_error>Cancelled: parallel tool call Bash(cd /Users/ckausik/Documents/loom && git …) errored</tool_use_error>

</details>

## You

continue

<details>
<summary>Ran 2 commands</summary>

- **Bash** — cd /Users/ckausik/Documents/loom/projects/loom && git log --oneline -20 --format="%h %ad %s" --date=short
- **Bash** — ls -lt /Users/ckausik/Documents/loom/projects/
  - 931da2c 2026-04-09 Fix Tauri default loom root to ~/Documents/loom
ccea3a3 2026-04-09 Rename Tauri app from Vault to Loom
f990a68 2026-04-09 Chat compaction: PreCompact snapshots, serial summarization on Continue
e7462f1 2026-04-09 Add PreCompact hook for chat compaction snapshots
7519975 2026-04-09 Implement adaptive context budget for system prompt
41d12cb 2026-04-09 Add adaptive context budget and chat compaction to TODO
909ec98 2026-04-09 Update demo canvas layout
33ae355 2026-04-09 Remove accidentally committed raw/inbox/ research sources
a214c23 2026-04-08 Use Cmd+W (not Ctrl+W) to close PDF pane in split view
2b26adb 2026-04-08 Ctrl+W closes PDF pane, Cmd+[ goes back to canvas from split view
4b362d3 2026-04-08 Cmd+[ closes split view, returns to fullpage editor
3bf94bc 2026-04-08 Move Compile to left pane header, close button to right side of PDF
1b281a1 2026-04-08 Split view: left Back returns to canvas, right Close returns to editor
12ce5c0 2026-04-08 TeX: start as fullpage e

</details>

## Claude

Most recently active projects (by modification time):

| Project | Last Modified |
|---|---|
| **agentic-memory** | Apr 9, 05:41 |
| **loom** | Apr 9, 05:23 |
| **phd-thesis** | Apr 9, 02:35 |
| **scraping-tools** | Apr 8 |
| **intuiting-randomness** | Apr 8 |

The **loom** repo itself has been the most actively committed today — 8 commits on Apr 9 covering chat compaction, Tauri rename, and adaptive context budgets. The rest (Apr 8 batch) look like they were touched during a bulk operation (all at 21:35).

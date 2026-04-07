# TODO

## TeX Compilation
- Compile `.tex` files to PDF from the UI
- Side-by-side PDF preview in fullscreen mode
- Open PDF in fullscreen after compilation when not in fullscreen

## Demo Loom
- Add sample PDF files to demonstrate PDF rendering
- Create sample memories + project MEMORY.md to test memory pipeline end-to-end

## Code Review Agent
- Multi-agent review of code changes in loom projects
- Modeled after Claude Code's code review: multiple agents examine changes in parallel, verification step filters false positives
- Post findings with severity levels

## Wiki Review Agent
- Semantic verification of compiled wiki pages (beyond what `/lint` does mechanically)
- Source accuracy: does the page faithfully represent the raw source?
- Contradictions: does the new page contradict existing pages?
- Cross-reference completeness: are obvious connections missing?
- Glossary alignment: does the page use canonical terms?

## Memory System
- Compiler agent updated for memory reporting: `/compile` reports stale memories, verifies MEMORY.md index drift
- `/memory` interactive cleanup command: plan-mode style review for cross-project and global memories
- End-to-end test: verify Claude creates memories following CLAUDE.md instructions in web chat

## Chat Transcripts
- Auto-tag chat transcripts on save: Claude infers tags from conversation context (project, topics) and writes them to frontmatter
- UI: filter/group chats by tag in files view and chat history
- Tags should use the same vocabulary as wiki pages and memory files

## Known Issues
- System prompt not updated when client is reused mid-session (chat.py lines 454-458). Context changes don't take effect until next session. Pre-existing bug.

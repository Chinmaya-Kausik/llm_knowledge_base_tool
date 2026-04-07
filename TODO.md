# TODO

Ordered by: validate what's built → fill demo gaps → features that build on each other.

## 1. Memory End-to-End
- Create sample memories in `wiki/meta/memory/` + project MEMORY.md in demo loom
- Verify injection works in web chat (is the MEMORY.md content in the prompt?)
- Verify Claude creates memories following CLAUDE.md instructions
- Compiler agent updated for memory reporting: `/compile` reports stale memories, verifies MEMORY.md index drift

Rationale: the memory system is built but untested. Validate before building on top of it.

## 2. Chat Transcript Tagging
- Auto-tag chat transcripts on save: Claude infers tags from conversation context (project, topics) and writes them to frontmatter
- Tags should use the same vocabulary as wiki pages and memory files
- UI: filter/group chats by tag in files view and chat history

Rationale: small change (one field in frontmatter on save), enables filtering later. Do before review agents since those generate transcripts too.

## 3. Demo Loom Polish
- Add sample PDF files to demonstrate PDF rendering
- Ensure demo exercises all features: wiki pages, projects, raw sources, memories, chat transcripts with tags

Rationale: the demo should be a complete showcase before adding major features.

## 4. TeX Compilation
- Compile `.tex` files to PDF from the UI
- Side-by-side PDF preview in fullscreen mode
- Open PDF in fullscreen after compilation when not in fullscreen

Rationale: the demo loom has `projects/attention-efficiency-paper/paper.tex`. This feature makes it useful. Depends on PDF rendering already working.

## 5. Wiki Review Agent
- Semantic verification of compiled wiki pages (beyond what `/lint` does mechanically)
- Source accuracy: does the page faithfully represent the raw source?
- Contradictions: does the new page contradict existing pages?
- Cross-reference completeness: are obvious connections missing?
- Glossary alignment: does the page use canonical terms?

Rationale: before code review. Wiki review is simpler (markdown in, markdown out) and validates the multi-agent review pattern before applying it to code.

## 6. Code Review Agent
- Multi-agent review of code changes in loom projects
- Modeled after Claude Code's code review: multiple agents examine changes in parallel, verification step filters false positives
- Post findings with severity levels

Rationale: builds on the wiki review pattern. More complex (code semantics, test coverage, regressions).

## 7. `/memory` Interactive Cleanup
- Plan-mode style review for cross-project and global memories
- Claude scans, proposes changes, user approves each
- Single-project memories managed autonomously by Claude

Rationale: only needed once the memory pool is large enough to need cleanup. Low priority until memory is actively used.

## Known Issues
- System prompt not updated when client is reused mid-session (chat.py lines 454-458). Context changes don't take effect until next session. Pre-existing bug.

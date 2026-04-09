# TODO

Ordered by: migration infrastructure → validate what's built → features that build on each other.

## 1. ABOUT.md Migration

Rename the loom page file from README.md to ABOUT.md everywhere:
- `ABOUT.md` = loom page content (loaded into Claude's context, shown on canvas)
- `README.md` = just another file (GitHub docs, not special to loom)

Changes needed:
- `loom_mcp/lib/pages.py`: `get_page_content()` reads ABOUT.md, `walk_pages()` skips ABOUT.md instead of README.md, `get_page_metadata()` reads from ABOUT.md
- `loom_mcp/tools/compile.py`: `write_wiki_page()` creates ABOUT.md in folders, `get_stale_readmes()` checks ABOUT.md timestamps
- `loom_mcp/chat.py`: `_location_block()` injects parent folder ABOUT.md
- `loom_mcp/web.py`: bootstrap creates ABOUT.md for wiki folders, not README.md
- Demo loom: rename all folder README.md → ABOUT.md
- Tests: update all fixtures that create README.md in folders
- DEVELOPER.md, README.md: update documentation
- CLAUDE.md template: update "Pages are folders with ABOUT.md"
- wiki/meta/conventions.md: update references

## 2. Migrate Repos to Loom

Move all repos from ~/Documents/GitHub/ into ~/Documents/loom/projects/:

```
~/Documents/loom/projects/
  agentic-memory/              ← grouped project
    crumqs/                    ← CRUMQs repo
    internship/                ← chinmaya-internship-project-main
    paper/                     ← agentic-memory-paper
  phd-thesis/                  ← PhD Thesis Material (from Documents)
  loom/                        ← this repo
  website/                     ← chinmaya-kausik.github.io
  cacheable-functions/
  codenames-bot/
  crossword-solver/            ← crossword-clue-solver
  ppo-implementation/          ← ppo-implementation-details
  newtons-cradle/              ← newtons-cradle-applet
  intuiting-randomness/
  scraping-tools/
```

Steps:
1. Do ABOUT.md migration first (so new ABOUT.md files work)
2. Move repos: `mv ~/Documents/GitHub/* ~/Documents/loom/projects/`
3. Move PhD thesis: `mv ~/Documents/"PhD Thesis Material" ~/Documents/loom/projects/phd-thesis`
4. Group agentic-memory repos into single folder
5. Create ABOUT.md for each project (from repo CLAUDE.md content + README context)
6. Create MEMORY.md for each project (from Claude Code memory files at ~/.claude/projects/)
7. Create wiki/meta/memory/ files for project-specific operational context
8. Update ~/.loom-app-config.json if needed
9. Restart server — bootstrap re-creates .claude/mcp.json with correct paths
10. Delete orphaned Claude Code memory dirs at ~/.claude/projects/

Development workflow (after migration):
- `main` branch = stable. `dev` branch = experimental.
- Two launcher files:
  - `loom-ui.command` — `git checkout main` then start server on port 8420, serves real loom
  - `loom-dev.command` — `git checkout dev` then start server on port 8421, serves demo loom
- Each launcher checks out its branch before starting, so it always loads the right code.
- Running stable server is unaffected by branch switches on disk (code already loaded in memory).
- When validated: `git checkout main && git merge dev`, then restart stable server.
- Both launchers can run simultaneously — first one loaded its code, second switches branch for itself.

For each migrated repo:
- Repo's CLAUDE.md content → distributed to ABOUT.md (project description for Claude), wiki pages (domain knowledge), memory files (operational context)
- Repo's README.md stays as-is (GitHub docs)
- Repo's .claude/ directory can be cleaned up (mcp.json paths will be wrong)

## 3. Distribute Loom Repo Content

The loom repo's CLAUDE.md has architecture, conventions, style, scaling triggers. Distribute:
- **ABOUT.md** (projects/loom/ABOUT.md): project description, architecture overview, directory layout — what Claude needs for development context
- **Wiki**: scaling triggers table → wiki/concepts/loom-scaling-triggers/ABOUT.md
- **Memory**: settings cleanup [loom], user preferences [global], transformer LR [transformer-from-scratch]
- **MEMORY.md** (projects/loom/MEMORY.md): one-liner index for loom-specific memories
- **Root MEMORY.md**: global memory index (user preferences)
- **Delete**: repo CLAUDE.md (replaced by ABOUT.md + wiki + memory)
- **Keep**: wiki/meta/conventions.md (already has style/compilation rules), TODO.md

## 4. Memory End-to-End
- Verify memory injection works in web chat with real project memories
- Verify Claude creates memories following loom root CLAUDE.md instructions
- Compiler agent updated for memory reporting: `/compile` reports stale memories, verifies MEMORY.md index drift

Rationale: memory system is built but needs validation with real content after migration.

## 5. Chat Transcript Tagging
- Mechanical tags from context_path already implemented
- UI: filter/group chats by tag in files view and chat history

Rationale: the backend is done, just needs the UI filter.

## 6. TeX Compilation
- Compile `.tex` files to PDF from the UI
- Side-by-side PDF preview in fullscreen mode
- Open PDF in fullscreen after compilation when not in fullscreen

Rationale: demo loom has `projects/attention-efficiency-paper/paper.tex` and sample PDFs.

## 7. Wiki Review Agent
- Semantic verification of compiled wiki pages (beyond what `/lint` does mechanically)
- Source accuracy: does the page faithfully represent the raw source?
- Contradictions: does the new page contradict existing pages?
- Cross-reference completeness: are obvious connections missing?
- Glossary alignment: does the page use canonical terms?

Rationale: simpler than code review, validates the multi-agent review pattern first.

## 8. Code Review Agent
- Multi-agent review of code changes in loom projects
- Modeled after Claude Code's code review: multiple agents examine changes in parallel, verification step filters false positives
- Post findings with severity levels

## 9. `/memory` Interactive Cleanup
- Plan-mode style review for cross-project and global memories
- Claude scans, proposes changes, user approves each
- Single-project memories managed autonomously by Claude

## Known Issues
- System prompt not updated when client is reused mid-session (chat.py _get_or_create_client). Context changes don't take effect until next session. Pre-existing bug.

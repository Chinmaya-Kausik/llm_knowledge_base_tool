Search the knowledge base and synthesize an answer.

1. Call `loom:read_source` on `wiki/meta/index.md` (the master index) to find relevant pages.
2. Call `loom:ripgrep_search` with the query across scope "wiki" for additional matches.
3. Call `loom:read_index` for any topic indexes that might be relevant.
4. Read the most relevant wiki pages using `loom:read_wiki_page`.
5. Synthesize a clear, well-sourced answer from the wiki content.
6. Cite which wiki pages were consulted using [[wiki-links]].
7. If the wiki doesn't have enough information, say so and suggest ingesting new sources.
8. Call `loom:append_log` with entry_type "query" and a brief summary of the question.

After answering, remind the user they can run `/file-answer` to save this answer back to the wiki.

Question: $ARGUMENTS

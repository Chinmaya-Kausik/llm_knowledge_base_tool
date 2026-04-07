Write the last synthesized answer back to the wiki.

1. Take the most recent answer from this conversation.
2. Generate a descriptive title and filename slug.
3. Write it to `wiki/answers/` using `loom:write_wiki_page` with complete frontmatter:
   - type: "answer"
   - Include the original question in the content
   - List all wiki pages that were consulted as sources
   - Set appropriate tags
4. Call `loom:update_master_index` to update the page catalog.
5. Call `loom:append_log` with entry_type "file-answer" and the answer title.
6. Commit using `loom:auto_commit`.
7. Report the filed answer path.

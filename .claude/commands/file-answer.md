Write the last synthesized answer back to the wiki.

1. Take the most recent answer from this conversation.
2. Generate a descriptive title and filename slug.
3. Write it to `wiki/answers/` using `vault:write_wiki_page` with complete frontmatter:
   - type: "answer"
   - Include the original question in the content
   - List all wiki pages that were consulted as sources
   - Set appropriate tags
4. Call `vault:update_master_index` to update the page catalog.
5. Call `vault:append_log` with entry_type "file-answer" and the answer title.
6. Commit using `vault:auto_commit`.
7. Report the filed answer path.

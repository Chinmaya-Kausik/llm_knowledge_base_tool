Use the vault MCP tools to run incremental compilation.

1. Call `vault:get_changed_sources` to find uncompiled or modified sources.
2. If no changes, report that everything is up to date.
3. Call `vault:get_page_registry` and `vault:get_glossary` for context.
4. For each changed source:
   a. Call `vault:read_source` to get its content.
   b. Synthesize a summary and/or concept article(s) from the source content.
   c. Write each article using `vault:write_wiki_page` with complete frontmatter.
   d. Mark the source compiled using `vault:mark_source_compiled`.
   e. Propose new glossary terms using `vault:update_glossary` if applicable.
5. Update topic indexes using `vault:write_index` for affected topic clusters.
6. Call `vault:update_master_index` to regenerate the master page catalog.
7. Call `vault:append_log` with entry_type "compile" for each compiled source.
8. Commit changes using `vault:auto_commit`.
9. Report what was compiled.

If arguments are provided, compile only matching files: $ARGUMENTS

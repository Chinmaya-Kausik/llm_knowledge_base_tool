Use the loom MCP tools to run incremental compilation.

1. Call `loom:get_changed_sources` to find uncompiled or modified sources.
2. If no changes, report that everything is up to date.
3. Call `loom:get_page_registry` and `loom:get_glossary` for context.
4. For each changed source:
   a. Call `loom:read_source` to get its content.
   b. Synthesize a summary and/or concept article(s) from the source content.
   c. Write each article using `loom:write_wiki_page` with complete frontmatter.
   d. Mark the source compiled using `loom:mark_source_compiled`.
   e. Propose new glossary terms using `loom:update_glossary` if applicable.
5. Update topic indexes using `loom:write_index` for affected topic clusters.
6. Call `loom:update_master_index` to regenerate the master page catalog.
7. Call `loom:append_log` with entry_type "compile" for each compiled source.
8. Commit changes using `loom:auto_commit`.
9. Report what was compiled.

If arguments are provided, compile only matching files: $ARGUMENTS

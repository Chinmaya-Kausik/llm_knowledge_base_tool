Ingest content into the knowledge base.

If $ARGUMENTS looks like a URL (starts with http:// or https://):
- Call `vault:ingest_url` with the URL.

If $ARGUMENTS looks like a file path ending in .pdf:
- Call `vault:ingest_pdf` with the file path.

Otherwise, treat $ARGUMENTS as the title for a text note and ask the user for the content, then call `vault:ingest_text`.

After ingestion:
1. Call `vault:append_log` with entry_type "ingest" and the source title.
2. Report the result and suggest next steps:
   - Review the ingested content
   - Classify it from inbox to the appropriate subdirectory using `vault:classify_inbox_item`
   - Run `/compile` to compile it into wiki articles

Target: $ARGUMENTS

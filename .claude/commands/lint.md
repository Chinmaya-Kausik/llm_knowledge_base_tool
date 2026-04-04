Run wiki health checks and report findings.

1. Call `vault:generate_health_report` to run all checks.
2. Read the generated report at `wiki/meta/health.md`.
3. Summarize the findings, prioritizing:
   - Broken links (most critical)
   - Stale pages (source changed since compilation)
   - Orphan pages (no inbound links)
   - Missing concepts (referenced but no article exists)
4. Suggest specific actions to fix each issue.
5. Call `vault:append_log` with entry_type "lint" and a summary of findings.

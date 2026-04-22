# Full Repository Security and Quality Audit

Audited: 2026-04-21
Scope: Entire Loom repository — Python backend, MCP server, Agent SDK integration, VM tools, web server, chat system

---

## CRITICAL Issues (fix immediately)

### 1. Permission handler fails open on exception
- **File**: `chat.py` line 617
- **Problem**: When `can_use_tool` encounters an exception (WebSocket hiccup, timeout), it returns `PermissionResultAllow()`. Any tool use is silently allowed on error.
- **Fix**: Return `PermissionResultDeny(message="Permission check failed")`. Fail-closed is the standard.

### 2. `/api/page/{path}` — path traversal (read)
- **File**: `web.py` line 676
- **Problem**: `LOOM_ROOT / path` with no validation. `/api/page/../../etc/passwd` reads any file.
- **Fix**: `full_path = (LOOM_ROOT / path).resolve(); assert str(full_path).startswith(str(LOOM_ROOT.resolve()))`

### 3. `/api/pages/bulk` — path traversal (read)
- **File**: `web.py` line 687
- **Problem**: Same — each path used as `LOOM_ROOT / path` without validation.

### 4. `/api/page/{path}` PUT — path traversal (write)
- **File**: `web.py` line 776
- **Problem**: PUT to `/api/page/../../etc/crontab` could overwrite any writable file.

### 5. `/media/{filepath}` — path traversal (read)
- **File**: `web.py` line 2239
- **Problem**: `/media/../../etc/shadow` serves any readable file.

---

## HIGH Severity Issues

### 6. Permission single-slot future — race condition
- **File**: `chat.py` lines 623-641
- **Problem**: `_permission_futures` keyed by `session_id` only. If parent agent and subagent both request permission simultaneously, second request overwrites first future. First never resolves or gets wrong response.
- **Fix**: Key by `(session_id, tool_use_id)` or use a queue.

### 7. `classify_inbox_item` — path traversal
- **File**: `ingest.py` lines 222-240
- **Problem**: Arbitrary `source` and `destination` paths, no validation they stay within loom root.

### 8. `read_source` / `read_wiki_page` / `write_wiki_page` — path traversal
- **File**: `compile.py` lines 65, 80, 95
- **Problem**: `loom_root / path` with no validation.

### 9. `vm_glob` — command injection
- **File**: `server.py` lines 500-520
- **Problem**: Pattern interpolated into shell command: `f"find {base} -path '*{pattern}*'"`. A pattern like `' -exec rm -rf / '` injects.
- **Fix**: Use existing `_shell_escape()` function.

### 10. `vm_grep` — command injection
- **File**: `server.py` lines 523-554
- **Problem**: Pattern and file_glob use single-quote escaping but don't use `_shell_escape()`. Single quotes in pattern break out.

### 11. SSH `known_hosts=None` — MITM vulnerability
- **File**: `vm/ssh.py` line 61
- **Problem**: Host key verification disabled. Network attacker can intercept all SSH traffic.

### 12. rsync `StrictHostKeyChecking=no` — MITM
- **File**: `vm/sync.py` line 41

### 13. Terminal spawns unrestricted login shell
- **File**: `web.py` lines 1577-1578
- **Problem**: `$SHELL -l` with no restrictions. Any authenticated user gets full shell access.

### 14. CORS `allow_origins=["*"]` with credentials
- **File**: `web.py` lines 297-303
- **Problem**: Any website can make authenticated cross-origin requests with the user's cookie.
- **Fix**: Set specific origin, not `*`.

### 15. VM search name mode — command injection
- **File**: `web.py` lines 1858-1888
- **Problem**: `find {base} -iname '*{q}*'` without escaping `q`.

---

## MEDIUM Severity Issues

### 16. Subagent pause timeout silently resumes
- **File**: `subagent_control.py` lines 152-155
- **Problem**: Paused subagent times out (300s) and silently resumes. `TimeoutError` caught with bare `pass`.

### 17. Unknown tools default to "file_read" permission category
- **File**: `chat.py` line 558
- **Problem**: New dangerous tools would be treated as read-only and allowed.
- **Fix**: Default to `"unknown"` category, treat as `"ask"`.

### 18. Destructive command detection is fragile
- **File**: `chat.py` lines 579-588
- **Problem**: Regex blocklist misses `sudo`, `chmod`, `chown`, pipe commands, redirects. `\brm\b` false-matches in some words.

### 19. Session memory leak
- **File**: `chat.py` line 14
- **Problem**: `sessions` dict grows indefinitely. Disconnected sessions never cleaned up.

### 20. Silent exception swallowing in Claude Code adapter
- **File**: `agents/claude_code.py` lines 190-191
- **Problem**: Every event wrapped in `try/except Exception: continue`. Bugs in event parsing silently dropped.

### 21. `/api/set-api-key` allows key override
- **File**: `web.py` lines 837-852
- **Problem**: Any authenticated user can set/override API keys, redirecting calls to different billing.

### 22. QR code contains auth token
- **File**: `web.py` line 869
- **Problem**: Token in URL. If QR screenshotted or shared, auth compromised.

### 23. Context-info endpoint mutates active sessions
- **File**: `web.py` lines 949-964
- **Problem**: When called with a real session_id, modifies the session's `page_path` and `_prompt_metadata`.

---

## LOW Severity Issues

### 24. `_location_block_adaptive` crashes on None page_path + global
- **File**: `chat.py` line 438
- **Problem**: `None.startswith("vm:")` raises AttributeError.

### 25. No reconnection logic in Claude Code adapter
- **File**: `agents/claude_code.py`
- **Problem**: SDK connection drop loses in-progress response.

### 26. Short timeout on disconnect/interrupt (3s)
- **File**: `agents/claude_code.py` lines 197, 205
- **Problem**: May leave orphaned Claude Code subprocesses.

### 27. `messages_snapshot` grows unbounded
- **File**: `chat.py` lines 738-739

### 28. `/api/delete` recursively deletes non-empty directories
- **File**: `web.py` lines 1462-1482
- **Problem**: Uses `shutil.rmtree` but docs say "empty folder."

### 29. `auto_commit` doesn't check for symlinks
- **File**: `server.py` lines 381-389

### 30. `ripgrep_search` susceptible to ReDoS
- **File**: `tools/search.py` lines 58-68
- **Problem**: Mitigated by 30s timeout.

---

## Test Coverage Gaps

### What IS tested
- Context assembly (build_prompt, system prompt, memory, location, budget)
- Web API endpoints (graph, tree, search, bulk pages)
- Frontmatter, hashing, links, registry
- Compilation, lint, git tools
- Tree/graph structure validation

### What IS NOT tested (ordered by risk)

| Area | Risk | Notes |
|------|------|-------|
| Path traversal on web endpoints | CRITICAL | Zero tests for /api/page, /media, /api/pages/bulk |
| Permission flow | CRITICAL | Zero tests for can_use_tool, timeouts, fail-open |
| WebSocket chat protocol | HIGH | No actual WS tests |
| Terminal security | HIGH | No tests for PTY, resize, auth |
| VM command injection | HIGH | No tests for vm_glob, vm_grep injection |
| Auth middleware | HIGH | No tests for token flow, cookie, remote toggle |
| Claude Code adapter | MEDIUM | No tests for events, errors, reconnection |
| Codex/GenericCLI adapters | MEDIUM | No tests at all |
| Subagent control | MEDIUM | No tests for checkpoints, pause/resume |
| Background agent lifecycle | MEDIUM | No adapter create/reuse/cleanup tests |
| Chat continuation/forking | MEDIUM | No append/precompact tests |
| File upload validation | LOW | No data URL parsing or sanitization tests |

---

## Suggested New Tests

### Path Traversal (CRITICAL — missing entirely)
```
test_api_page_traversal_dotdot
test_api_page_bulk_traversal
test_api_page_put_traversal
test_serve_media_traversal
test_classify_inbox_item_destination_traversal
test_read_source_traversal
test_write_wiki_page_traversal
```

### Permission Flow
```
test_permission_allow_returns_immediately
test_permission_deny_returns_deny
test_permission_ask_sends_ws_message_and_waits
test_permission_timeout_returns_deny
test_permission_exception_should_return_deny  # catches fail-open bug
test_concurrent_permission_requests  # catches single-slot future bug
test_destructive_command_detection_rm
test_destructive_command_detection_git_push
test_unknown_tool_category_defaults_safely
```

### Auth Token Handling
```
test_localhost_bypasses_auth
test_remote_requires_token
test_bearer_token_auth
test_query_param_token_auth
test_cookie_token_auth
test_invalid_token_returns_401
test_ws_auth_rejects_without_token
test_cors_origins_not_wildcard
```

### VM Command Injection
```
test_vm_glob_pattern_with_quotes
test_vm_glob_pattern_with_semicolon
test_vm_grep_pattern_with_shell_escape
test_vm_search_name_mode_injection
```

### Terminal Security
```
test_terminal_ws_requires_auth_when_remote
test_terminal_spawns_in_loom_root
test_terminal_resize_message_handled
test_vm_terminal_requires_valid_vm_id
```

### Chat Continuation/Forking
```
test_append_chat_path_traversal
test_append_chat_to_nonexistent_file
test_chat_fork_creates_new_session
test_summarize_precompact_empty_list
```

### Agent Lifecycle
```
test_adapter_created_on_first_message
test_adapter_reused_on_subsequent_messages
test_adapter_cleaned_up_on_disconnect
test_session_cleanup_removes_old_sessions
```

### Context Edge Cases
```
test_none_page_path_global_level  # catches NoneType.startswith bug
test_vm_page_path_context
test_context_info_doesnt_mutate_active_session
test_unicode_file_content
```

### WebSocket Reconnection
```
test_ws_disconnect_cleans_up_adapter
test_ws_reconnect_creates_new_session
test_stop_during_active_query
test_stop_when_no_query_active
```

### File Upload
```
test_upload_valid_png
test_upload_invalid_data_url
test_upload_filename_sanitization
test_upload_large_file
```

---

## Summary

**5 CRITICAL** issues (path traversal on 4 web endpoints + fail-open permissions)
**10 HIGH** issues (command injection, MITM, CORS, race conditions)
**8 MEDIUM** issues (session leaks, fragile detection, silent failures)
**7 LOW** issues (crashes, timeouts, minor gaps)

Most urgent: path traversal fixes (items 2-5, 7-8) are straightforward resolve-and-check-prefix patterns. The fail-open permission handler (item 1) is a one-line change from Allow to Deny.

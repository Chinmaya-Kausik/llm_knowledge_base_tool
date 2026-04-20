# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in Loom, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities.
2. Use [GitHub's private security advisory feature](https://github.com/ckausik/loom/security/advisories/new) to report the issue.
3. Alternatively, open a private advisory on the repository's Security tab.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgement**: Within 48 hours
- **Initial assessment**: Within 7 days
- **Fix for critical vulnerabilities**: Within 14 days
- **Public disclosure**: After fix is released, coordinated with reporter

## Security Architecture

Loom is a **local-first** application. Key security properties:

### Data handling
- All data (wiki pages, memory, chat transcripts) stored on the user's local filesystem
- No Loom-operated servers — the MCP server runs locally on `localhost`
- Git-versioned: all changes are tracked and reversible

### Network behavior
| Feature | Outbound connection | Destination | Can be disabled? |
|---------|-------------------|-------------|-----------------|
| Chat (Claude Code) | Yes (via Claude Code CLI) | api.anthropic.com (or enterprise endpoint) | Yes — don't connect a chat |
| Chat (Codex) | Yes (via Codex CLI) | api.openai.com | Yes — don't use Codex agent |
| MCP server | localhost only | N/A | N/A |
| Font loading | None (bundled) | N/A | N/A |
| Telemetry | None | N/A | N/A |
| Remote access | Optional (`LOOM_REMOTE=1`) | Binds 0.0.0.0 | Yes — off by default |

### LLM API integration
- **Loom does not make LLM API calls directly.** It spawns the Claude Code process via the Agent SDK. Claude Code handles all API communication using its own authentication and configuration.
- If your organization has an enterprise Claude Code subscription, all API calls flow through your existing enterprise account — same data governance, same retention policies, same infrastructure that your security team already approved.
- Loom operates no proxy or relay servers. It is a local frontend that manages context and displays results.
- Context sent to the agent is user-controlled via the context level picker (page/folder/global).
- For Codex: similarly spawns the Codex CLI process, which uses its own OpenAI authentication.
- API keys are never handled, stored, or logged by Loom itself.

### Agent permissions
- File read/write, shell commands, destructive git operations, and MCP tools can each be set to Allow/Ask/Deny
- Default: all allowed except destructive git (set to Ask)
- Enterprise deployments should set defaults to Ask

## Dependencies

SBOM is published with each release. Run `pip-audit` and check `pyproject.toml` for the current dependency list.

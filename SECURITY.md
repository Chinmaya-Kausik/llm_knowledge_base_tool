# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in Loom, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities.
2. Use [GitHub's private security advisory feature](https://github.com/ckausik/loom/security/advisories/new) to report the issue.
3. Alternatively, email: security@chinmayakausik.com

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
| Chat (Claude Code) | Yes | api.anthropic.com | Yes — don't connect a chat |
| Chat (Codex) | Yes | api.openai.com | Yes — don't use Codex agent |
| MCP server | localhost only | N/A | N/A |
| Font loading | None (bundled) | N/A | N/A |
| Telemetry | None | N/A | N/A |
| Remote access | Optional (`LOOM_REMOTE=1`) | Binds 0.0.0.0 | Yes — off by default |

### LLM API integration
- **Bring Your Own Key** model: API calls go directly from your machine to Anthropic/OpenAI
- Loom operates no proxy or relay servers
- Context sent to the LLM is user-controlled via the context level picker (page/folder/global)
- API keys are stored in environment variables or OS keychain, never logged

### Agent permissions
- File read/write, shell commands, destructive git operations, and MCP tools can each be set to Allow/Ask/Deny
- Default: all allowed except destructive git (set to Ask)
- Enterprise deployments should set defaults to Ask

## Dependencies

SBOM is published with each release. Run `pip-audit` and check `pyproject.toml` for the current dependency list.

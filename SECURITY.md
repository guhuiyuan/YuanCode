# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

YuanCode is currently pre-1.0. The latest release on the `main` branch receives security fixes; older releases do not.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use one of these private channels instead:

- **GitHub Security Advisories** (preferred): <https://github.com/guhuiyuan/yuancode/security/advisories/new>
  This routes the report privately to the maintainers and lets us coordinate disclosure and a fix.
- **Email**: open a Security Advisory first and we will reply with an address if a direct channel is preferred.

### What to include

A good report helps us triage quickly. Please include:

1. The commit / tag / release where you observed the issue.
2. A clear description of the vulnerability and its impact (e.g. *arbitrary file read via path traversal in `read` tool when `cwd` is untrusted*).
3. A minimal reproduction — code snippet, command sequence, or PoC.
4. Your assessment of severity (Critical / High / Medium / Low) and reasoning.
5. Any known workarounds.

### Response timeline

| Step                                  | Target        |
|---------------------------------------|---------------|
| Acknowledge receipt                   | within 72 h   |
| Triage & assess severity              | within 7 d    |
| Patch & coordinate disclosure         | within 30 d   |
| Public CVE / advisory (if applicable) | after fix released |

We will keep you informed of progress and credit you in the advisory (unless you prefer to stay anonymous).

## Scope

YuanCode is a local agent harness. The most security-sensitive surfaces are:

- **Sandbox bypass** — escaping the configured sandbox (local / bubblewrap / docker / landlock) to touch paths like `~/.ssh`, `/etc`, `C:\Windows\System32`.
- **PermissionGate bypass** — getting a high-risk tool to execute in a stricter permission mode than the user selected.
- **Checkpoint / SessionStore tampering** — letting a previous turn's snapshot affect a fresh, unrelated session.
- **Hook injection** — arbitrary code execution via `hooks.json` from an untrusted project (e.g. `YUANCODE_PROJECT_DIR/.yuancode/hooks.yaml`).
- **MCP server supply chain** — a malicious MCP server returning crafted tool schemas or tool results.
- **Secret leakage** — anything that could cause an API key, token, or credential to land in a committed file, log line, or telemetry stream.

Anything **outside** this list (typos, UI bugs, performance) belongs in a regular issue.

## Recognition

We follow a coordinated disclosure model. Reporters who follow this policy will be credited in the release notes and (with permission) in the advisory itself.

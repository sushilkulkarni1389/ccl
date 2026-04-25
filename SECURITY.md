# CCL Security Policy

## Supported versions
Only the latest release of CCL is supported. Security fixes are not
backported.

## Trust boundary
CCL is designed to run exclusively within Claude Code as an MCP server.
It relies on Claude Code's elicitation API (`server.elicitInput`) for all
user-facing prompts. The security model assumes:

1. **The MCP client is Claude Code (or a trusted equivalent).** Running CCL
   against an unknown or untrusted MCP host is unsupported and may allow a
   compromised client to spoof elicitation responses, bypassing the
   human-in-the-loop permission gates.

2. **The host machine is single-user or the user's home directory is
   appropriately permissioned.** CCL writes `~/.claude/claude.json` with
   mode 0600 on Unix-like systems. On multi-user systems, verify that your
   home directory is not world-accessible.

3. **Web search results during best practices refresh are untrusted input.**
   CCL validates and filters all incoming practice candidates against a
   trusted domain allowlist before writing them to disk. Candidates from
   unknown domains are discarded and reported to the user.

## Audit trail
Every elicitation prompt and its response is logged via
`sendLoggingMessage` at level `info`. In Claude Code, these appear in the
MCP server debug output prefixed with `[ccl:elicit]`. If you suspect a
session was tampered with, inspect these logs.

## Reporting a vulnerability
Open a GitHub issue with the label `security`. For high-severity findings,
email the maintainers directly (address in package.json).

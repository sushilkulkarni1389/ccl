# Contributing to CCL

Thank you for contributing. CCL is a small, focused tool — contributions
that keep it small and focused are most welcome.

---

## Before you start

Open an issue before writing code for anything beyond a trivial fix. This
saves everyone time — many PRs arrive solving problems that are already
being worked on, or that the maintainers have decided not to solve.

For bug fixes and documentation improvements, a PR without a prior issue
is fine.

---

## Setup

**Requirements:** Node.js 18+, npm

```bash
git clone https://github.com/your-org/ccl
cd ccl
npm install
npm run build
npm test
```

The repo is a monorepo with two packages:

| Package | What it contains |
|---|---|
| `packages/core` | Stack detection, scaffold planning, file writing, practices refresh |
| `packages/mcp` | MCP server, `/ccl` command handler, `npx @sushilkulkarni1389/ccl-mcp` registration |

Build in dependency order: `core` first, then `mcp`.

---

## Build sequence

Follow this order — each step is independently testable:

1. `packages/core/templates/` — file templates (CLAUDE.md, SKILL.md, etc.)
2. `packages/core/src/detector.ts` — project file scanner + stack inferencer
3. `packages/core/src/scaffold.ts` — plan builder + file writer + state manager
4. `packages/core/src/practices.ts` — ccl-practices.json manager + refresh logic
5. `packages/mcp/src/commands/ccl.ts` — `/ccl` command + conversation flow
6. `packages/mcp/src/index.ts` — MCP server entry point
7. `packages/mcp/src/setup.ts` — `npx @sushilkulkarni1389/ccl-mcp` registration logic
8. Integration tests — full flow from `/ccl` to scaffolded project

---

## What we are looking for

**Good contributions:**
- Bug fixes with a failing test that demonstrates the bug
- Improvements to existing best practices in `ccl-initial-practices.json`
  (with source URLs)
- Additional stack detectors in `detector.ts` for common project types
- Documentation corrections

**Please discuss first:**
- New commands or entry points beyond `/ccl`
- Changes to the `ccl-practices.json` or `ccl-state.json` schemas
- Any change to the 200-line CLAUDE.md limit
- New runtime dependencies

**We will not accept:**
- Features that add interactive prompts beyond what the blueprint specifies
- Changes that make CCL work outside of Claude Code
- Dependencies that require a global install or break zero-install behaviour
- Anything that writes outside the user's project directory or `~/.claude/`

---

## Code style

- TypeScript throughout — no `any` types
- No default exports
- Functions over classes where possible
- Tests co-located with implementation (`*.test.ts` next to `*.ts`)
- Run `npm run lint` and `npm run typecheck` before submitting — CI will
  reject PRs that fail either

---

## Pull request checklist

- [ ] `npm test` passes locally
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes with no warnings
- [ ] New behaviour is covered by a test
- [ ] `CHANGELOG.md` updated with a one-line summary under `[Unreleased]`
- [ ] If changing the scaffold output, the blueprint version comment in
      `CCL_BLUEPRINT_v*.md` reflects the change (or a new version is noted)

---

## Commit style

```
type: short description (≤72 chars)

Optional body. What changed and why — not what the diff shows.
```

Types: `fix`, `feat`, `docs`, `refactor`, `test`, `chore`

One logical change per commit. Squash fixup commits before requesting review.

---

## Security

### Shell execution
All external process calls must use `execFile` or `spawn` with an
explicit array of arguments. Never use `exec`, `execSync`, or
`spawn`/`spawnSync` with `shell: true`. A semgrep rule in
`.semgrep/no-shell-exec.yml` enforces this and runs as a CI gate.

Rationale: string-interpolated shell commands allow argument
injection if any input is user- or LLM-controlled.

### Temp file atomicity
All file writes must follow the `.ccl-tmp-<random>` + `rename`
pattern established in `scaffold.ts`. Never write to the final
destination path directly.

### Override validation
Any string entering `buildScaffoldPlan` from an untrusted source
(LLM response, file read, web search result) must pass through
`validateScaffoldOverrides` first. See `override-validator.ts`.

---

## Reporting bugs

Use the bug report issue template. Include:
- Node.js version (`node --version`)
- Claude Code version
- The project type CCL was run against (stack, approximate size)
- What CCL did vs. what you expected
- The contents of `.claude/ccl-state.json` if scaffold failed midway

---

## Questions

Open a GitHub Discussion. Issues are for bugs and concrete feature proposals.

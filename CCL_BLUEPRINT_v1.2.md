# CCL — Claude Context Loader
## Complete Product Blueprint

> **Purpose:** This document is the single source of truth for building CCL. Reference it in every Claude Code session. Do not start coding without this open.

---

## 0. Changelog

### v1.4 — 2026-04-27
- **§3 `--list-key` implemented:** new setup command in setup.ts that
  prints the masked active key and its storage location, or "No key set."
  if none is configured. Surfaces ANTHROPIC_API_KEY env var too. Warns
  if both keychain and env var are set (env var takes precedence).
  Naming kept singular to match --set-key / --remove-key. Only one key
  is supported at a time — multi-key routing is out of scope.

### v1.3 — 2026-04-25
- **§5, §6, §8 Elicitation replaced:** all `elicitInput()` calls removed.
  The `/ccl` tool now accepts an optional `input?: string` parameter.
  CCL outputs questions as plain text; conversation state is tracked
  via `conversation_step` in `ccl-state.json`. Fixes dialogs lingering
  on screen and timing out in Claude Code.
- **§14 ccl-state.json schema:** added `conversation_step: string`,
  `guided_answers: {}`, and `plan_overrides: {}` fields. `plan_overrides`
  persists the cumulative LLM-derived overrides across plan-review turns
  so successive change requests compose rather than reset.
- **§4.1, §8.1, §8.2, §15 prompt UI:** replaced `[1] [2]` button-style
  options and `[Yes] [No]` buttons with plain-text hints (e.g. "Type 1
  or 2 to continue"). MCP tool output is plain text only — there is no
  UI layer to render buttons.

### v1.2 — 2026-04-24
- **§20 SDK naming corrected:** `@anthropic-ai/sdk` is the Anthropic API client used
  for `llmCall` in the MCP server. The MCP server transport SDK is
  `@modelcontextprotocol/sdk`. Both are runtime dependencies of `@ccl/mcp`. The prior
  entry listed only `@anthropic-ai/sdk`, which was ambiguous.
- **§8.2 Resume behaviour clarified:** the resume path rebuilds the full scaffold plan
  and re-executes all steps. Atomic writes make this idempotent for already-completed
  files. The implementation note "continues from last completed step" refers to
  user-facing messaging, not selective file writes. Source corrected in this version.

### v1.1 — 2026-04-24
- **§18 Model Routing:** `claude-opus-4` → `claude-opus-4-7`. The v1.0 ID referred to the original Claude Opus 4 (deprecated, retiring 2026-06-15). The current generally-available Opus is 4.7.
- **§18 Note added:** clarified that the IDs listed in the table are the durable API *aliases*; dated snapshot IDs (e.g. `claude-haiku-4-5-20251001`) should be used when reproducibility across snapshot releases matters. CCL tracks both via `CCL_MODEL_ALIASES` and `CCL_MODEL_DATED_IDS` in `packages/core/src/templates/types.ts`.
- **§12 Subagent Template:** no change needed — the example already uses `claude-haiku-4-5`, which remains the current Haiku alias.

### v1.0 — 2026-04-24
- Initial blueprint.

---

## 1. What Is CCL?

CCL (Claude Context Loader) is an MCP server that integrates directly into Claude Code. It scaffolds a complete, production-ready Claude Code project — including `CLAUDE.md`, skills, subagents, hooks, and configuration — using current best practices, automatically gathered and maintained via web search.

**Core principles:**
- Zero friction setup (`npx ccl` once, `/ccl` forever)
- Self-updating best practices (no manual maintenance)
- Works like Claude Code itself — confirm once, execute, never nag
- Never bloats `CLAUDE.md` — 200-line discipline enforced
- Security-first — minimal permissions, explicit user consent

---

## 2. Distribution

| Channel | Command | Status |
|---|---|---|
| MCP Server (primary) | `npx ccl` → `/ccl` | Phase 1 |
| Open Source Repo | GitHub (MIT License) | Phase 1 |

**No web app. No CLI tool. Claude Code is the only interface.**

---

## 3. Setup — One Command

```bash
npx ccl
```

| Command | What it does |
|---|---|
| `npx ccl` | Register CCL as an MCP server in Claude Code config |
| `npx ccl --set-key <key>` | Store Anthropic API key in OS keychain |
| `npx ccl --remove-key` | Delete key from OS keychain |
| `npx ccl --list-key` | Print masked key + storage location, or "No key set." |
| `npx ccl --help` | Show this table |

Only one key is active at a time. CCL does not route across multiple API accounts.

**What this does:**
1. Downloads and registers CCL as an MCP server in Claude Code config
2. Adds CCL to `~/.claude/claude.json` (or equivalent config path)
3. Prints confirmation: `✓ CCL registered. Open Claude Code and type /ccl to get started.`

**Requirements:**
- Node.js (if not installed, error message links to nodejs.org)
- Claude Code installed

**Security:**
- `npx ccl` only modifies Claude Code config — nothing else
- No global installs without consent
- All file operations happen inside the user's project directory only
- MCP server runs locally — no external calls except web search during best practices refresh

---

## 4. Entry Point — `/ccl`

Every interaction starts here, inside Claude Code.

### 4.1 Greeting Message

```
👋 Welcome to Claude Context Loader (CCL)

I'll scaffold a production-ready Claude Code project for you — including
CLAUDE.md, skills, subagents, hooks, and all configuration files.

How would you like to get started?
[1] Auto-detect  — scan your directory
[2] Guided setup — answer 5 questions
Type 1 or 2 to continue.
```

Before this prompt is shown, CCL runs three pre-greeting checks in order
and detours through the matching prompt if any fires:

1. **Interrupted recovery** — see §8.2.
2. **Re-scaffold warning** — see §8.1.
3. **Practices refresh** — see §15.

Once the user resolves the detour, CCL falls through to the greeting
above.

---

## 5. Option 1 — Auto-Detect Flow

```
User types: /ccl → selects [1]

1. CCL scans current directory
   - Reads: package.json, pyproject.toml, go.mod, Cargo.toml, pubspec.yaml
   - Reads: existing README, .env.example, Dockerfile, CI config
   - Checks: if .claude/ or CLAUDE.md already exist → triggers re-scaffold warning (see §8.1)
   - Infers: project name, type, stack, language, dev/test/build/lint commands

2. CCL builds a complete scaffolding plan

3. CCL presents detailed plan (see §7 — Plan Format)

4. Conversational review loop:
   - User requests changes in plain English
   - CCL updates plan and re-presents
   - Repeat until user approves

5. CCL asks one-time session permission:
   "May I create and modify files in this project?
    Type 'yes' or 'no'."
   → If yes: no further permission prompts for this session

6. CCL asks about ccl-state.json git sync:
   "Would you like to sync ccl-state.json to git?
    Type 'yes' or 'no'."
   → Updates .gitignore accordingly

7. CCL scaffolds everything in one shot (see §9 — What Gets Scaffolded)

8. CCL prints completion summary
```

---

## 6. Option 2 — Guided Setup Flow

```
User types: /ccl → selects [2]

1. CCL asks 4 questions (one at a time) + 1 open-ended final question

2. CCL builds plan using answers + intelligent assumptions for anything not provided

3. Same conversational review loop as Option 1 (§5, steps 3–8)
```

### 6.1 The 5 Questions

**Q1 — Project Name & Description**
```
What is your project called, and what does it do?

Hint: e.g. "auth-service — a REST API that handles user authentication
for our mobile app" or just "my portfolio website"
```

**Q2 — Project Type**
```
What type of project is this?

Hint: e.g. web app, REST API, CLI tool, mobile app, browser extension,
library/package, desktop app, monorepo, data pipeline
```

**Q3 — Tech Stack**
```
What technologies are you using?

Hint: e.g. "Next.js 14, TypeScript, PostgreSQL, Prisma, Tailwind" or
"Python, FastAPI, Redis, Docker" — list as many or as few as you know
```

**Q4 — Constraints**
```
Any constraints I should know about?

Hint: e.g. coding style rules ("no default exports"), security requirements
("HIPAA compliant"), deployment environment ("AWS Lambda, no binaries > 5MB"),
team conventions ("all PRs need two approvals"), performance targets
```

**Q5 — Anything Else?**
```
Is there anything else about your project you'd like me to know before
I build the plan? (press Enter to skip)

Hint: e.g. known pitfalls, legacy decisions, team size, deadline pressure,
things the AI should never do in this codebase
```

---

## 7. Plan Format — Detailed Breakdown

CCL always presents the **exact content** of every file before writing anything. This is CCL's core value proposition — full transparency, no surprises.

### Structure of the plan presentation:

```
Here's what I'll create for [project name]:

─────────────────────────────────────────
 CLAUDE.md
─────────────────────────────────────────
[exact content of CLAUDE.md — see §10]

─────────────────────────────────────────
 .claude/settings.json
─────────────────────────────────────────
[exact JSON content]

─────────────────────────────────────────
 .claude/skills/[name]/SKILL.md  (×N)
─────────────────────────────────────────
[exact content of each skill]

─────────────────────────────────────────
 .claude/agents/[name].md  (×N)
─────────────────────────────────────────
[exact content of each agent]

─────────────────────────────────────────
 .claudeignore
─────────────────────────────────────────
[exact content]

─────────────────────────────────────────
 .gitignore additions
─────────────────────────────────────────
[lines CCL will add]

─────────────────────────────────────────
 .claude/ccl-practices.json
─────────────────────────────────────────
[exact JSON content]

─────────────────────────────────────────
 .claude/ccl-state.json
─────────────────────────────────────────
[exact JSON content]

─────────────────────────────────────────

Does this look right? Request any changes or say "looks good" to proceed.
```

---

## 8. Edge Cases

### 8.1 Project Already Scaffolded

If CCL finds existing `.claude/` or `CLAUDE.md`:

```
⚠️  I found an existing CCL scaffold in this directory.

What would you like to do?
[1] Re-scaffold — start fresh; existing CCL files will be overwritten
[2] Skip        — leave everything as-is and exit
Type 1 or 2 to continue.
```

If user selects `1` → falls through to the main greeting (§4.1) and any
later overwrite happens during scaffolding.

### 8.2 Scaffolding Fails Midway

CCL writes state after each file:

```json
// .claude/ccl-state.json
{
  "status": "in_progress",
  "last_completed_step": "skills/deploy",
  "remaining_steps": ["agents/security-auditor", "settings.json"],
  "started_at": "2026-04-24T10:00:00Z"
}
```

On next `/ccl`, if interrupted state detected:

```
⚠️  It looks like a previous scaffold was interrupted.

[1] Continue from where I left off
    — re-executes the full plan; already-written files are overwritten
      idempotently (content is identical for unchanged steps)
[2] Start again from scratch
Type 1 or 2 to continue.
```

The detector treats a state file as interrupted when `status` is not
`complete` AND `steps[]` has been populated (i.e. scaffold execution had
already begun). Mid-conversation states with empty `steps[]` resume
directly via `conversation_step` without showing this prompt.

### 8.3 Git Handling

CCL will:
- Run `git init` if no `.git` found
- Add the following to `.gitignore`:
  ```
  .claude/settings.local.json
  # ccl-state.json (added here only if user chose No to git sync)
  ```
- Nothing beyond this — no `git add`, no commits, no push

### 8.4 Session Permissions

- CCL asks for file write permission once per session
- If granted: no further prompts for that session
- Permission does not persist across sessions — asked again next `/ccl`

---

## 9. What Gets Scaffolded

```
project-root/
├── CLAUDE.md                          ← Project context (≤200 lines)
├── .claudeignore                      ← Noise exclusions
├── .gitignore                         ← CCL additions only
└── .claude/
    ├── settings.json                  ← Permissions, hooks, tool allowlist
    ├── settings.local.json            ← Machine-local overrides (gitignored)
    ├── ccl-practices.json             ← Best practices state (CCL internal)
    ├── ccl-state.json                 ← Scaffold state (CCL internal)
    ├── skills/
    │   └── [skill-name]/
    │       └── SKILL.md               ← One per inferred skill
    └── agents/
        └── [agent-name].md            ← One per inferred subagent
```

---

## 10. CLAUDE.md Template

**Hard limit: 200 lines. Every line must earn its place.**

```markdown
# [Project Name]

## What is this?
[One paragraph written for a senior engineer joining in 30 minutes.
Not instructions for Claude — context for anyone reading cold.]

## Stack
- [technology 1]
- [technology 2]
- [technology 3]

## Where things live
[dir/]          [one-line description]
[dir/]          [one-line description]
[dir/]          [one-line description]

## How to run it
```bash
[dev command]      # start dev server
[test command]     # run tests
[build command]    # production build
[lint command]     # lint + format
```

## Coding rules
- [rule 1]
- [rule 2]
- [rule 3]

## Testing philosophy
[One line: what tests exist, how to run, what coverage means here]

## Common pitfalls
- [what NOT to do + why]
- [what NOT to do + why]

## Gotchas
- [convention violation that exists for legacy reasons]
- [anything surprising about this codebase]

## Never do
- [absolute prohibition + reason]
- [absolute prohibition + reason]

---

## Behavioral guidelines

### Think before coding
- State assumptions explicitly — if uncertain, ask
- If multiple interpretations exist, present them — don't pick silently
- If a simpler approach exists, say so — push back when warranted
- If something is unclear, stop and name what's confusing

### Simplicity first
- Minimum code that solves the problem — nothing speculative
- No features beyond what was asked
- No abstractions for single-use code
- If 200 lines can be 50 lines, rewrite it

### Surgical changes
- Touch only what you must — don't improve adjacent code
- Match existing style even if you'd prefer otherwise
- Every changed line must trace directly to the user's request
- Mention unrelated dead code — don't delete it

### Goal-driven execution
- Transform tasks into verifiable goals
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- For multi-step tasks, state a plan with explicit verify steps per step
```

---

## 11. SKILL.md Template

```yaml
---
name: [skill-name]
description: [precise trigger sentence — when Claude should auto-activate this skill]
allowed-tools: [Read, Bash, Write]
---

## Steps
1. [step]
2. [step]
3. [step]

## Verification criteria
- [how to confirm this skill completed successfully]

## Reference
- [live doc URL via webfetch — no stale training data]
```

---

## 12. Subagent Template

```yaml
---
name: [agent-name]
description: [what this agent does and when to use it]
model: claude-haiku-4-5
tools: [Read, Grep, Glob]
---

## Purpose
[One paragraph — what problem this agent solves]

## Output format
[Structured JSON summary returned to orchestrator]

## Constraints
- Read-only — no file writes
- Returns structured JSON only
- Scope: [specific files or directories]
```

---

## 13. ccl-practices.json Schema

```json
{
  "version": "1.0",
  "last_updated": "2026-04-24T10:00:00Z",
  "last_checked": "2026-04-24T10:00:00Z",
  "next_check_due": "2026-05-01T10:00:00Z",
  "practices": [
    {
      "id": "bp-001",
      "title": "CLAUDE.md 200-line limit",
      "description": "Keep CLAUDE.md under 200 lines — it loads fully every session",
      "source": "https://github.com/forrestchang/andrej-karpathy-skills",
      "added": "2026-04-24",
      "status": "active"
    }
  ],
  "archived_versions": []
}
```

**Version management:**
- Version bumps when new/removed practices are found
- `last_updated` refreshes even when no changes (timestamp of last check)
- Maximum 2 versions retained — oldest moved to `archived_versions`
- If `archived_versions` exceeds 1 entry — oldest is deleted permanently

---

## 14. ccl-state.json Schema

```json
{
  "status": "complete | in_progress | failed",
  "scaffold_version": "1.0",
  "started_at": "2026-04-24T10:00:00Z",
  "completed_at": "2026-04-24T10:02:00Z",
  "project_name": "[name]",
  "project_type": "[type]",
  "steps": [
    { "name": "CLAUDE.md", "status": "done" },
    { "name": "settings.json", "status": "done" },
    { "name": "skills/deploy", "status": "done" },
    { "name": "agents/security-auditor", "status": "pending" }
  ],
  "git_sync": true,
  "conversation_step": "greeting",
  "guided_answers": {},
  "plan_overrides": {}
}
```

---

## 15. Best Practices Refresh Cycle

### Trigger condition
On every `/ccl`, CCL reads `ccl-practices.json`:

```
if today >= next_check_due → trigger refresh prompt
```

### Refresh prompt

```
📦 It's been 7 days since your best practices were last checked.

Would you like me to search for updates?
[refresh] — refresh now (takes ~30 seconds)
[later]   — remind me next time
[never]   — don't ask again
Type 'refresh', 'later', or 'never' to continue.
```

### Refresh flow

```
1. CCL performs web search for latest Claude Code best practices
2. Compares results against current practices in ccl-practices.json
3. Identifies:
   - New practices not in current version
   - Outdated practices no longer recommended
   - Unchanged practices (no action needed)
4. Presents diff to user:

   ✦ 2 new practices found
   ✦ 1 outdated practice to remove
   ✦ 14 practices unchanged

   NEW:
   + [practice title] — [source URL]
   + [practice title] — [source URL]

   REMOVE:
   - [practice title] — no longer recommended as of [date]

   Accept changes? Type 'yes' or 'no'.

5. If accepted → ccl-practices.json updates, version bumps if changed
6. If no changes → ccl-practices.json last_updated refreshes, version stays
```

### Failure handling

| Scenario | Behaviour |
|---|---|
| Web search fails | "Refresh failed. [Retry] [Skip for now]" |
| User is offline | Silent — checks again on next `/ccl` when online |
| User selects Never | Adds `"refresh": "never"` to ccl-practices.json — never prompts again |
| User selects Later | Prompts again next `/ccl` — does not reset the 7-day clock |

---

## 16. settings.json Template

```json
{
  "permissions": {
    "allow": [
      "Read",
      "Write",
      "Bash(git:*)",
      "Bash(npm:*)",
      "Bash(npx:*)"
    ],
    "deny": [
      "Bash(rm -rf:*)",
      "Bash(curl:*)",
      "Bash(wget:*)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "ccl-validate-bash" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [{ "type": "command", "command": "ccl-audit-write" }]
      }
    ]
  }
}
```

---

## 17. .claudeignore Template

```
# Dependencies
node_modules/
vendor/
.venv/
__pycache__/

# Build outputs
dist/
build/
out/
.next/
target/

# Logs
*.log
logs/

# Test fixtures & snapshots
__fixtures__/
__snapshots__/
*.snap

# Environment
.env
.env.local
.env.*.local

# OS
.DS_Store
Thumbs.db

# CCL internals (always excluded from Claude's context)
.claude/ccl-practices.json
.claude/ccl-state.json
```

---

## 18. Model Routing (applied in generated prompts)

| Model | Use case |
|---|---|
| `claude-haiku-4-5` | Subagents — bulk reads, security scans, dependency mapping |
| `claude-sonnet-4-6` | Daily implementation, multi-file edits, tests (orchestrator default) |
| `claude-opus-4-7` | Complex architecture decisions, heavy algorithmic work |

**Effort level:** `xhigh` — recommended default for all agentic coding tasks.

**Note on IDs:** the values above are the durable Claude API *aliases*. Anthropic also publishes dated snapshot IDs (e.g. `claude-haiku-4-5-20251001`); use these when you need to pin to a specific snapshot for reproducibility. CCL tracks both in `packages/core/src/templates/types.ts` via `CCL_MODEL_ALIASES` and `CCL_MODEL_DATED_IDS`. When Anthropic releases a new generally-available model, bump both constants and cut a new blueprint version.

---

## 19. Repo Structure (Open Source)

```
ccl/
├── packages/
│   ├── core/              ← Shared logic: plan generation, file writing, practices
│   │   ├── src/
│   │   │   ├── scaffold.ts
│   │   │   ├── practices.ts
│   │   │   ├── detector.ts
│   │   │   └── templates/
│   │   └── package.json
│   └── mcp/               ← MCP server + npx ccl setup
│       ├── src/
│       │   ├── index.ts   ← MCP server entry point
│       │   ├── setup.ts   ← npx ccl registration logic
│       │   └── commands/
│       │       └── ccl.ts ← /ccl command handler
│       └── package.json
├── CONTRIBUTING.md
├── LICENSE                ← MIT
└── README.md
```

---

## 20. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript | Type safety, Claude Code ecosystem standard |
| MCP server SDK  | `@modelcontextprotocol/sdk` | MCP stdio transport + tool registration |
| Anthropic client | `@anthropic-ai/sdk`         | LLM calls from the MCP server (llmCall wrapper) |
| Package manager | npm | Universal, no extra tooling |
| Distribution | npx | Zero global install, always latest |
| Web search | Claude Code native | No external API needed |
| State storage | JSON files in `.claude/` | Simple, portable, git-friendly |
| License | MIT | Maximum open source compatibility |

---

## 21. README Quick Start (for open source users)

```markdown
## Quick Start

1. Install CCL (one time only):
   npx ccl

2. Open Claude Code in your project directory

3. Type:
   /ccl

That's it. CCL will guide you from there.

## Requirements
- Node.js 18+ (https://nodejs.org)
- Claude Code

## Contributing
See CONTRIBUTING.md
```

---

## 22. Build Sequence (for Claude Code sessions)

Build in this order — each phase is independently testable:

1. **`packages/core/templates/`** — all file templates (CLAUDE.md, SKILL.md, etc.)
2. **`packages/core/src/detector.ts`** — project file scanner + stack inferencer
3. **`packages/core/src/scaffold.ts`** — plan builder + file writer + state manager
4. **`packages/core/src/practices.ts`** — ccl-practices.json manager + refresh logic
5. **`packages/mcp/src/commands/ccl.ts`** — `/ccl` command + full conversation flow
6. **`packages/mcp/src/index.ts`** — MCP server entry point
7. **`packages/mcp/src/setup.ts`** — `npx ccl` registration logic
8. **Integration testing** — full flow from `/ccl` to scaffolded project

---

## 23. Build & Distribution Notes

**Always rebuild after source changes before testing via npx:**

```bash
cd packages/mcp && npm run build
```

`npx ccl` executes the compiled `dist/` output, not the TypeScript
source directly. Changes to `src/setup.ts` or any other source file
will not be reflected until the build step runs.

**To verify a change is live:**

```bash
grep -n "<your change>" packages/mcp/dist/setup.js
npx ccl --help
```

**If npx serves a stale version despite a clean dist/:**

```bash
npx clear-npx-cache
```

npx caches packages globally. If you are iterating on a locally
linked version, clear this cache to force npx to pick up the
latest build.

---

*Blueprint version: 1.3 — April 25, 2026*
*Do not modify during active build sessions. Create a new version instead.*

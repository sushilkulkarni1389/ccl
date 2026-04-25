  # CCL — Project Build Status

  **Blueprint:** `CCL_BLUEPRINT_v1.2.md`
  **Source of truth for build order:** §22 Build Sequence
  **Last updated:** 2026-04-25

  ---

  ## Snapshot

  | Metric | Value |
  |---|---|
  | Phases complete | 8 / 8 — all phases ✅ (blueprint v1.2) |
  | Tests passing | 227 / 227 (core 158 + mcp 25 ccl + 13 setup + 4 index + 27 integration = 69 mcp) |
  | Source LOC (core) | 4,127 |
  | Source LOC (mcp) | 1,324 |
  | Test LOC | 6,031 |
  | Integration suite wall-clock | ~0.9 s (budget: 30 s) |
  | Typecheck | clean (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes) |
  | Build | clean (tsc → `packages/core/dist/`) |

  ---

  ## Phase status

  ### ✅ Phase 1 — `packages/core/src/templates/`
  File templates for every scaffolded artifact.

  | File | Blueprint § | Key behavior |
  |---|---|---|
  | `types.ts` | — | Context interfaces + `CCL_MODEL_ALIASES` / `CCL_MODEL_DATED_IDS` / `CclModelAlias` |
  | `claude-md.ts` | §10 | 200-line hard limit; `ClaudeMdTooLongError` on overflow |
  | `skill-md.ts` | §11 | Skill name regex validation |
  | `agent-md.ts` | §12 | `model` typed to `CclModelAlias` (Opus 4.7 / Sonnet 4.6 / Haiku 4.5) |
  | `settings-json.ts` | §16 | `defaultSettingsContext()` with canonical allow/deny + `ccl-validate-bash` / `ccl-audit-write` hooks |
  | `claudeignore.ts` | §17 | Verbatim static content |
  | `ccl-practices-json.ts` | §13 | `defaultPracticesContext()` seeds `bp-001`; `addDays()` + `REFRESH_INTERVAL_DAYS = 7` |
  | `ccl-state-json.ts` | §14 | `last_completed_step` / `remaining_steps` emitted when `status !== "complete"` (covers §8.2 failure recovery) |
  | `gitignore.ts` | §8.3 | Additions wrapped in `# >>> ccl managed <<<` markers for idempotent update/remove |

  **Tests:** 15 assertions covering rendering, validation errors, serialization shape, line-limit enforcement.

  ### ✅ Phase 2 — `packages/core/src/detector.ts`
  Project scanner + stack inferencer.

  - **Manifest readers:** `package.json`, `pyproject.toml` (PEP 621 + poetry), `go.mod`, `Cargo.toml`, `pubspec.yaml`
  - **Inference:**
    - `Language`: typescript / javascript / python / go / rust / dart / unknown
    - `ProjectType`: web-app / rest-api / cli / library / monorepo / mobile-app / data-pipeline / unknown
    - Stack: dep-name → friendly-name map (Next.js, React, Fastify, Prisma, FastAPI, Pydantic, Axum, Tokio, Flutter, etc.)
    - Commands: `package.json.scripts` → fallback per-language defaults
    - Directories: known-dir list, ignores `node_modules`, `.git`, `dist`, etc.
  - **Existing CCL detection:** `hasClaudeMd`, `hasClaudeDir`, parsed `version` + `lastUpdatedIso` from `ccl-practices.json` (for §8.1 re-scaffold warning)
  - **Findings:** README first-paragraph snippet, Dockerfile, `.env.example`, CI config, monorepo marker
  - **Dependencies added:** `smol-toml` ^1.3.0, `yaml` ^2.5.0 (runtime)

  **Tests:** 16 tmpdir-fixture scenarios — Node/TS web app, Fastify API, monorepo workspaces, Python FastAPI, Go module + version, Rust workspace with Axum, Flutter mobile app, existing CCL scaffold, empty dir / missing root, CI + Docker + env findings.

  ### ✅ Phase 3 — `packages/core/src/scaffold.ts`
  Plan builder + preview renderer + executor + state manager.

  - **`buildScaffoldPlan(input)`** — merges `DetectedProject` + optional `ScaffoldOverrides` (name / type / whatIsThis / stack / directories / commands / codingRules / testingPhilosophy / pitfalls / gotchas / neverDo / skills / agents) → fully-rendered `ScaffoldPlan`.
  - **Default skills + agents:**
    - Baseline: `onboard` skill + `security-auditor` / `dependency-mapper` agents (both Haiku)
    - Per-type: `deploy` (web-app/rest-api), `run-migrations` (rest-api), `release` (cli), `publish` (library), `run-in-workspace` (monorepo), `build-release` (mobile-app), `run-pipeline` (data-pipeline)
  - **`renderPlanPreview(plan)`** — §7 sectioned preview with dividers, full content per file, approval prompt.
  - **`executeScaffoldPlan(plan, opts)`** — atomic writes via `.ccl-tmp`+rename; writes initial state before any file; updates state after each step; optional `git init` (dependency-injected `runGitCommand` for testability); gitignore merge; on failure marks step `failed`, sets top-level `status=failed`, persists state for §8.2 recovery.
  - **`readScaffoldState` / `detectInterruptedScaffold`** — §8.2 recovery detection.
  - **`mergeCclGitignoreBlock`** — idempotent strip-and-replace using the managed-block markers.

  **Tests:** 12 end-to-end fixtures — plan construction for rest-api, README as `whatIsThis`, overrides, `gitSync=false`, preview rendering, gitignore merge (new / append / replace / idempotent), happy-path execute with state complete, `onStepStart`/`onStepDone` ordering, git init skipped when `.git` exists, §8.2 mid-scaffold failure recovery.

  **Bug fixed during Phase 3:** `renderStateJson` only emitted `last_completed_step` / `remaining_steps` when `status === "in_progress"`. Widened to `status !== "complete"` so `failed` states also carry recovery info.

  ### ✅ Phase 4 — `packages/core/src/practices.ts`
  `ccl-practices.json` lifecycle manager (pure, no web search).

  - **I/O:** `loadPractices(root)` with strict schema validation (returns `null` on missing/malformed); `savePractices(root, ctx)` with atomic write.
  - **Refresh gating (§15):**
    - `isRefreshDue(ctx, now)` — `now >= next_check_due`, always false if `refresh: "never"`
    - `isRefreshDisabled(ctx)` — detects opt-out
    - `disableRefresh(ctx)` — pure, returns copy with `refresh: "never"`
  - **Diffing:** `computePracticesDiff(current, candidates)` → `{ added, removed, modified, unchanged }` — id-keyed with 4-bucket classification (content-aware).
  - **`applyRefresh(current, candidates, now)`** — single entry point covering both paths:
    - No changes → timestamps updated (`last_checked`, `last_updated`, `next_check_due`), version unchanged, no archive.
    - Changes → minor version bump (`1.0` → `1.1` → `1.2`), previous version archived, `archived_versions` capped at 1 entry (§13: "oldest is deleted permanently"), carry-over practices preserve their original `added` date.
  - **`bumpMinorVersion`** — throws `MalformedPracticesVersionError` on non-`<major>.<minor>` input.
  - **`capArchives`** — invariant enforcement for the archive list.

  **Tests:** 18 assertions — I/O round-trip (incl. `refresh:never`), malformed JSON handling, refresh gating at week boundaries, 4-bucket diff, no-change path, version bump + archive preserved/dropped across two consecutive refreshes, minor-version arithmetic (`1.9` → `1.10`), end-to-end save → load → refresh → save → load.

  **Separation of concerns:** web search lives in Phase 5. Phase 4 consumes `PracticeEntry[]` candidates injected by the caller — the core logic is fully unit-testable without network access.

  ---

  ### ✅ Phase 5 — `packages/mcp/src/commands/ccl.ts`
  The `/ccl` command handler + full conversation flow.

  - **Workspace added:** `packages/mcp/` (`@ccl/mcp`) with `@ccl/core` as a workspace dependency. Root `package.json` already globs `packages/*`.
  - **Adapter pattern:** `CclAdapter` interface injects `cwd`, `ask` / `choose` / `say` primitives, `llmCall`, optional `webSearch`, `now`, `runGitCommand`, `initGit`. MCP server wires the real I/O; tests wire scripted mocks. No module-level singletons — `SessionState` is constructed per `runCcl` invocation.
  - **Entry-point preflight:** interrupted-scaffold recovery (§8.2 via `detectInterruptedScaffold`), refresh gate (§15 via `loadPractices` + `isRefreshDue`), then greeting + Auto/Guided dispatch.
  - **Auto-detect flow (§5):** `detectProject` → §8.1 warning if `hasClaudeMd || hasClaudeDir` → `buildScaffoldPlan({ llmCall, ... })` (kicks off Patch 3 skill classification) → skill-mode chooser (Patch 3) → conversational review loop → gitSync → permission → execute → summary.
  - **Guided setup flow (§6):** five questions, each answered before the next is asked. Q1 split on em-dash/hyphen with required whitespace on both sides (avoids splitting on intra-word hyphens like `my-thing`); Q2 mapped to `ProjectType` via keyword heuristics; Q3 tokenised on commas/newlines; Q4 → `codingRules`; Q5 optional → `gotchas`.
  - **Plan review loop (§7):** free-form change requests go through `llmCall` with a `REVIEW_SYSTEM_PROMPT` that returns updated `ScaffoldOverrides` JSON; plan rebuilt via `buildScaffoldPlan` each iteration. Approval detected via substring/exact match on `APPROVAL_PHRASES` (`looks good`, `proceed`, `yes`, `approve`, …). Skill-generation mode is preserved across rebuilds.
  - **Skill generation UX (Patch 3):** `renderEstimatesDisplay(plan.skillEstimates)` shown before the review loop; mode chooser sets `plan.skillGenerationMode` (`parallel` / `sequential` / `skip`). Skip falls back to static `renderSkillMd` output in the plan; parallel/sequential inject LLM-generated bodies during `executeScaffoldPlan` (Patch 3 integration).
  - **Pre-exec prompts:** gitSync → toggles `plan.gitSync` and rewrites the `.gitignore` planned-file content via `renderGitignoreAdditions({ syncStateToGit })` so the preview decision is honoured without a full plan rebuild. Session permission (§8.4) asked once via `ensureSessionPermission`, memoised on `SessionState.permissionGranted`.
  - **Execution:** `executeScaffoldPlan` is called with `llmCall`, step callbacks that stream `⟳` / `✓` lines, and `onSkillGenerationProgress` for per-skill status during sequential generation.
  - **§15 refresh flow:** Accept → `fetchCandidatesWithRetry` (retry/skip loop on non-offline failures; silent skip on `OfflineError`), `computePracticesDiff`, `renderDiffSummary`, then Yes / No / Review-each-one. Review-each-one iterates `added ∪ modified ∪ removed` with `Practice N of M` headers, accepting/rejecting per item, then reconstructs the final candidate list and pipes through `applyRefresh` + `savePractices`. Later → no-op. Never → `disableRefresh` + `savePractices`.
  - **Offline detection:** class `OfflineError` + duck-type check (`err.offline === true`) lets tests simulate offline deterministically without polluting the prompt surface.
  - **User-facing strings:** all prompts, option labels, and boilerplate are top-of-file constants. No inline string literals in logic (strict rule).

  **Tests:** 25 scenarios in `test/ccl.test.ts` driving `runCcl` with a scripted adapter — greeting visibility, §8.2 interrupted prompt, §8.1 re-scaffold warning (incl. Skip exit), §15 refresh due vs. skipped, auto-detect end-to-end file materialisation, guided-setup question routing and Q5 skip, review-loop re-render + approval exit, gitSync Yes/No reflected in `.gitignore`, session-permission single-prompt invariant + No-exit, skill-mode prompt shown when estimates populated, Skip mode preserves static template output, completion summary contents, refresh outcomes (Never persists `refresh:"never"`; Later leaves file untouched; Review-each-one iterates per practice; offline is silent; non-offline failure shows Retry/Skip), plus security scenarios from Fix 1 (LLM-returned override blocked) and Fix 3 (untrusted-domain candidates filtered before `applyRefresh`).

  ### ✅ Phase 6 — `packages/mcp/src/index.ts`
  MCP server entry point over stdio.

  - **SDKs:** `@modelcontextprotocol/sdk ^1.0.0` (installed @ 1.29.0) for the `McpServer` + `StdioServerTransport`; `@anthropic-ai/sdk ^0.30.0` (installed @ 0.30.1) for the Anthropic client used by the `llmCall` wrapper (`claude-sonnet-4-6`, §18 orchestrator default). No web-search primitive is exposed — MCP servers cannot natively web-search — so `webSearch` is left undefined on the adapter (Phase 5's refresh flow silently no-ops, matching §15 offline behaviour).
  - **Server construction is per-invocation** (no module-level singletons). Node version guard (`< 18` → stderr + `exit(1)`) runs before any I/O.
  - **Single tool `ccl`** registered via `McpServer.registerTool` with annotations (`readOnlyHint: false`, destructive/idempotent both `false`).
  - **Capability check per tool-call** (client caps arrive after `initialize`, not at startup): `mcpServer.server.getClientCapabilities()?.elicitation` — when absent, the server emits `sendLoggingMessage({ level: "error" })` and returns a user-facing error string with `isError: true`. Graceful degradation rather than hanging silently on the first `ask`.
  - **Adapter wiring:** `ask` / `choose` use `server.elicitInput` with form schemas (plain string for `ask`; enum + enumNames for `choose`; index returned by parsing the enum value). `say` captures to an in-memory transcript AND emits `sendLoggingMessage` info notifications — the tool response returns the full transcript so clients that do not render logging still see the conversation. `runGitCommand` spawns real `git`; `initGit: true` by default.
  - **Elicitation audit trail (Fix 6):** every `ask` / `choose` invocation now also emits a `sendLoggingMessage({ level: "info" })` event tagged `[ccl:elicit]` carrying the prompt and (for `choose`) the option labels. The audit hook fires even when the host's elicitation surface is unrendered, so server-side logs always reflect what the user was prompted with.
  - **User-facing strings as top-of-file constants** (Phase 5 discipline maintained).

  ### ✅ Phase 7 — `packages/mcp/src/setup.ts`
  `npx ccl` installation script (§3).

  - **DI-first design:** `SetupOptions { configPath, exit, stdout, stderr, nodeVersion, serverDistPath }`. Production uses platform-specific defaults; tests inject tmpdir paths and capture stdout/stderr/exit code.
  - **Config path resolver (§3):** priority `~/.claude/claude.json` → platform-specific (`~/Library/Application Support/Claude/claude.json` on darwin, `%APPDATA%\Claude\claude.json` on win32, `$XDG_CONFIG_HOME/Claude/claude.json` on linux) → create `~/.claude/claude.json` if none exist.
  - **Atomic write:** `.ccl-tmp` + `rename`, same pattern as `scaffold.ts`. Temp file suffix is randomised via `randomBytes` (Fix 4) and the file is `chmod 0o600` before rename (Fix 2). Temp files never linger on success (covered by test).
  - **Error surfaces:** Node `< 18` → `ERR_NODE_VERSION`; malformed config → `ERR_MALFORMED_CONFIG(path)` and the file stays untouched; `EACCES`/`EPERM` → `ERR_PERMISSION(path)`; anything else → `ERR_UNEXPECTED(msg)`. All to stderr; success + already-registered messages to stdout.
  - **Already-registered idempotency:** checks `mcpServers.ccl` presence and exits 0 without writing (file byte-for-byte identical).
  - **Preserves unrelated keys:** only `mcpServers.ccl` is merged in; all other top-level config survives verbatim.
  - **Package wiring:** added `"bin": { "ccl": "./dist/setup.js" }` to `packages/mcp/package.json`. Source file starts with `#!/usr/bin/env node` shebang; TypeScript preserves it in the emitted CJS output. CLI auto-run guarded by `require.main === module` so test imports don't trigger a stray setup run.

  ### ✅ Phase 8 — Integration testing
  End-to-end tests driving the full `runSetup` + `runCcl` pipeline against real tmpdir fixtures.

  - **8 fixtures** under `packages/mcp/test/fixtures/`: `node-ts-webapp`, `python-fastapi`, `go-module`, `rust-workspace` (with `members/api`), `flutter-mobile`, `monorepo` (with `packages/pkg-a`, `packages/pkg-b`), `existing-scaffold` (pre-existing CLAUDE.md + .claude/), `empty-dir` (generated in-test).
  - **Test-only helpers** in `test/integration-helpers.ts`: `readJson` / `assertFileExists` / `assertFileAbsent` / `lineCount` / `assertScaffoldStatus` / `assertBaselineScaffold` (enforces §10's 200-line limit + §9 baseline files) / `copyFixture` / `mkTmpDir` / `mkEmptyDirSync` / `placeObstacleDir` (non-empty directory at a planned file path → triggers mid-scaffold `rename` failure for §8.2 tests) / `buildScriptedAdapter` / `buildDefaultLlmCall` / `buildReviewLoopLlmCall` (per-call canned review responses) / `autoDetectScript` / `guidedSetupScript` (prompt-order mirrors Phase 5).
  - **Group 1 — setup (3):** S1 fresh install on node-ts-webapp writes a resolvable absolute path; S2 re-run is byte-identical; S3 third-party MCP entry survives verbatim next to `ccl`.
  - **Group 2 — auto-detect (10):** A1 node-ts-webapp full §9 tree + CLAUDE.md ≤ 200 lines; A2 Python/FastAPI stack surfaces in CLAUDE.md + valid settings.json; A3 Go module → `dependency-mapper.md` with `model: claude-haiku-4-5`; A4 Rust workspace → `onboard/SKILL.md`; A5 Flutter → `project_type: "mobile-app"` + `build-release` skill; A6 monorepo → `run-in-workspace` skill + `project_type: "monorepo"`; A7 empty dir scaffolds cleanly; A8 existing-scaffold + Re-scaffold overwrites (new CLAUDE.md differs from fixture); A9 existing-scaffold + Skip exits with `status: "skipped"` and preserves CLAUDE.md + prevents `.claude/settings.json` from being written; A10 `gitSync: false` → `ccl-state.json` in `.gitignore` + `settings.local.json` still gitignored.
  - **Group 3 — guided setup (3):** G1 answers propagate into CLAUDE.md (projectName via em-dash split, stack, coding rules); G2 Q5 empty → gotchas section empty/`_(none)_`; G3 "REST API" → `project_type: "rest-api"` + `run-migrations` skill.
  - **Group 4 — review loop (2):** R1 one change + approval → ≥ 2 plan renders + exactly 1 review-LLM call + final CLAUDE.md reflects the change; R2 three rounds + approval → exactly 3 review-LLM calls + 4 plan renders + final CLAUDE.md uses the third projectName.
  - **Group 5 — §8.2 recovery (3):** I1 obstacle at `.claudeignore` causes mid-scaffold failure → state `status: "failed"` + `last_completed_step` populated + `.claudeignore` in `remaining_steps`. I2 resume with [1] Continue → baseline scaffold complete. I3 resume with [2] Restart → baseline scaffold complete after also clearing the §8.1 warning (Phase A left CLAUDE.md + `.claude/` on disk).
  - **Group 6 — §15 refresh (6):** P1 due practices → refresh header shown; P2 Accept + Yes with real `computePracticesDiff` candidates → version bumps + add/remove applied; P3 Later → byte-identical practices file; P4 Never → `refresh: "never"` + subsequent invocation suppresses the prompt; P5 `OfflineError` → silent, scaffold still completes; P6 non-offline webSearch error → Retry/Skip prompt + scaffold continues after Skip.
  - **llmCall strategy:** default stub dispatches on prompt prefix (`Classify each skill` → fast JSON classifications; `User said:` → configurable review response; otherwise skill-body content). Review-loop helper tracks per-call index so tests can pin iteration counts exactly.
  - **Wall-clock:** ~0.9 s on the dev laptop (budget 30 s). No network calls, no real LLM calls.

  ---

  ## Security patches (post-build)

  Nine security fixes applied after Phase 8 completion. Every fix lands a hardening change in source and a regression test that pins the new behaviour. Total of **67 tests added** across these fixes (folded into the 227 / 227 total in the snapshot).

  ### Fix 1 — Prompt Injection Guard on LLM-Generated `ScaffoldOverrides`
  Free-form review-loop responses returned by the LLM are now validated before they touch `buildScaffoldPlan`. A new module-level validator strips disallowed control characters, caps field lengths, and rejects any payload that re-introduces shell-metacharacter or path-traversal patterns into project metadata.

  - **Files:** `packages/core/src/override-validator.ts` (new), `packages/core/src/scaffold.ts`, `packages/mcp/src/commands/ccl.ts`
  - **Tests added:** 16 (14 in `override-validator.test.ts` + 2 security scenarios in `ccl.test.ts`)

  ### Fix 2 — Restrict File Permissions on Sensitive Writes
  Atomic writes that emit credentials-adjacent content (`claude.json` registration, `.claude/ccl-*.json`) now `chmod 0o600` on the temp file before rename. Public files keep their default umask.

  - **Files:** `packages/core/src/scaffold.ts` (`FILE_MODE_PRIVATE`), `packages/mcp/src/setup.ts` (`atomicWriteJson` + `0o600`)
  - **Tests added:** 3 (setup permission scenarios; mode assertions skip on `win32` where POSIX bits don't apply)

  ### Fix 3 — Validate and Gate Incoming Practice Candidates
  Practice candidates returned by `webSearch` are now validated before they reach `computePracticesDiff`. Each entry must (a) match the strict `PracticeEntry` schema and (b) carry a `source` URL whose host is in `TRUSTED_PRACTICE_DOMAINS`. Rejected candidates are dropped silently — they never appear in the diff or the user-facing review-each-one loop.

  - **Files:** `packages/core/src/practices.ts` (`validatePracticeCandidate`, `TRUSTED_PRACTICE_DOMAINS`), `packages/mcp/src/commands/ccl.ts` (validation wired before `computePracticesDiff`)
  - **Tests added:** 18 (17 candidate-validator + 1 `ccl.test.ts` refresh scenario)

  ### Fix 4 — Unpredictable Temp File Names in `atomicWrite`
  All `.ccl-tmp` paths used by atomic writes are now suffixed with `randomBytes(8).toString("hex")` so concurrent writes (or adversarial pre-creation of a predictable name) cannot collide.

  - **Files:** `packages/core/src/scaffold.ts`, `packages/mcp/src/setup.ts`, `packages/core/src/practices.ts`
  - **Tests added:** 3 (no-temp-file-residue + concurrent-write assertions)

  ### Fix 5 — Validate Agent Tool Permissions Before Write
  Agent YAML frontmatter is parsed and inspected before the agent file is written. If a generated agent's `tools` list contains anything outside `AGENT_READONLY_TOOLS`, the step is short-circuited and recorded as `"skipped"` rather than `"failed"` — a security gate that does not break the overall scaffold.

  - **Files:** `packages/core/src/templates/agent-md.ts` (`AGENT_READONLY_TOOLS`, `validateAgentMd`), `packages/core/src/scaffold.ts` (pre-write validation, `"skipped"` step status), `packages/core/src/templates/types.ts` (`StateStep.status` widened)
  - **Tests added:** 12 (11 `validateAgentMd` cases + 1 scaffold-skip scenario)

  ### Fix 6 — Elicitation Audit Trail + Trust Boundary Documentation
  Every elicitation (`ask` / `choose`) now emits an `[ccl:elicit]` info-level logging notification carrying the prompt and option set. A new `SECURITY.md` at the repo root documents the trust boundary between the MCP server, the host, and the LLM.

  - **Files:** `packages/mcp/src/index.ts` (`sendLoggingMessage` on every `ask` / `choose`), `SECURITY.md` (new, repo root), `packages/mcp/package.json` (`author.email`)
  - **Tests added:** 4 (canary assertions in `packages/mcp/test/index.test.ts`)

  ### Fix 7 — Path Traversal Guard in `executeScaffoldPlan`
  Every planned file path is now resolved and checked against the scaffold root before the temp file is written. Any path that escapes the root throws a typed `PathTraversalError`; the step is recorded as `"skipped"`, the plan continues, and no write occurs.

  - **Files:** `packages/core/src/scaffold.ts` (`PathTraversalError`, `assertWithinRoot`)
  - **Tests added:** 4 (traversal scenarios in `scaffold.test.ts`)

  ### Fix 8 — YAML Parser Hardening in `validateAgentMd`
  Agent frontmatter is now parsed with `yaml.parse(text, { schema: "failsafe" })`, restricting the parser to plain strings and rejecting tag-driven type coercion (`!!js/function`, `!!python/object`, etc.). Frontmatter that relies on non-failsafe types is rejected by the validator.

  - **Files:** `packages/core/src/templates/agent-md.ts` (`yaml.parse` + `{ schema: "failsafe" }`)
  - **Tests added:** 3 (failsafe-schema behaviour in `templates.test.ts`)

  ### Fix 9 — Unicode Normalization in `validateScaffoldOverrides`
  All free-text fields routed through the override validator and the practice-candidate validator are now Unicode-normalized (NFKC) before regex / blocklist checks. The original user input is preserved in the stored output — normalization is for *checking only*, not for rewriting what the user typed.

  - **Files:** `packages/core/src/override-validator.ts` (`normalizeCclField`, internal `normalizeField`), `packages/core/src/practices.ts` (`normalizeCclField` applied in `checkTextField`)
  - **Tests added:** 4 (3 normalization cases + 1 practice-candidate scenario)

  ---

  ## Repo layout today

  ```
  ccl/
  ├── CCL_BLUEPRINT.md                  (v1.0, frozen)
  ├── CCL_BLUEPRINT_v1.1.md             (frozen historical reference)
  ├── CCL_BLUEPRINT_v1.2.md             (current source of truth)
  ├── SECURITY.md                       (Fix 6 — trust boundary documentation)
  ├── ccl-project-build-status.md       (this file)
  ├── package.json                      (monorepo, workspaces: packages/*)
  └── packages/
      ├── core/                         (@ccl/core)
      │   ├── package.json              (deps: smol-toml, yaml)
      │   ├── tsconfig.json             (strict; NodeNext; noUncheckedIndexedAccess)
      │   ├── src/
      │   │   ├── index.ts              (barrel)
      │   │   ├── detector.ts           (Phase 2)
      │   │   ├── scaffold.ts           (Phase 3 + Patch 2)
      │   │   ├── practices.ts          (Phase 4 + Patch 1)
      │   │   ├── skill-engine.ts       (Patch 3)
      │   │   ├── override-validator.ts (Fix 1 + Fix 9)
      │   │   └── templates/            (Phase 1 + Patch 1/Patch 2)
      │   │       ├── index.ts
      │   │       ├── types.ts
      │   │       ├── claude-md.ts
      │   │       ├── skill-md.ts
      │   │       ├── agent-md.ts
      │   │       ├── settings-json.ts
      │   │       ├── settings-local-json.ts
      │   │       ├── claudeignore.ts
      │   │       ├── ccl-practices-json.ts
      │   │       ├── ccl-state-json.ts
      │   │       └── gitignore.ts
      │   └── test/
      │       ├── templates.test.ts
      │       ├── detector.test.ts
      │       ├── scaffold.test.ts
      │       ├── practices.test.ts
      │       ├── skill-engine.test.ts
      │       ├── override-validator.test.ts (Fix 1 + Fix 9)
      │       └── dump-samples.ts
      └── mcp/                          (@ccl/mcp, depends on @ccl/core)
          ├── package.json              (bin: "ccl" → dist/setup.js; deps: @modelcontextprotocol/sdk, @anthropic-ai/sdk)
          ├── tsconfig.json             (same strict profile as core)
          ├── src/
          │   ├── index.ts              (Phase 6 — MCP server entry)
          │   ├── setup.ts              (Phase 7 — npx ccl installer)
          │   └── commands/
          │       └── ccl.ts            (Phase 5 — conversation handler)
          └── test/
              ├── ccl.test.ts           (Phase 5 unit — 25)
              ├── setup.test.ts         (Phase 7 unit — 13)
              ├── index.test.ts         (Fix 6 security canaries — 4)
              ├── integration.test.ts   (Phase 8 end-to-end — 27)
              ├── integration-helpers.ts
              └── fixtures/
                  ├── node-ts-webapp/
                  ├── python-fastapi/
                  ├── go-module/
                  ├── rust-workspace/
                  ├── flutter-mobile/
                  ├── monorepo/
                  └── existing-scaffold/
  ```

  ---

  ## How to run

  ```bash
  cd /Users/skulkarni/Documents/ccl

  # Typecheck + build across both workspaces
  npm run typecheck
  npm run build

  # Run all tests (both workspaces)
  cd packages/core && npx tsx --test test/*.test.ts
  cd packages/mcp  && npx tsx --test test/*.test.ts

  # Integration suite only
  cd packages/mcp && npx tsx --test test/integration.test.ts

  # Render sample outputs (visual inspection of templates)
  cd packages/core && npx tsx test/dump-samples.ts

  # Run only the security-focused test files
  cd packages/core && npx tsx --test test/override-validator.test.ts
  cd packages/mcp  && npx tsx --test test/index.test.ts
  ```

  ---

  ## Blueprint deviations to note

  1. **`ccl-state.json` §14 schema clarification:** blueprint example shows `last_completed_step` / `remaining_steps` under `in_progress` state. Implementation emits them whenever `status !== "complete"` so `failed` states also carry recovery context. No schema field was added or removed — only the emission condition was widened.
  2. **Model IDs (v1.1 §18):** runtime constants `CCL_MODEL_ALIASES` and `CCL_MODEL_DATED_IDS` live in `packages/core/src/templates/types.ts`. When Anthropic releases a new GA model, update both and cut a new blueprint version per §18.
  3. **MCP SDK package (§20):** ✅ **resolved in blueprint v1.2 (2026-04-24).** §20 now lists both `@modelcontextprotocol/sdk` (MCP server SDK — stdio transport + tool registration) and `@anthropic-ai/sdk` (Anthropic client — `llmCall` wrapper). Changelog entry added at the top of v1.2.
  4. **§15 refresh-prompt ordering vs. §8.1:** the blueprint shows `/ccl` checking for the refresh prompt before the greeting and for the re-scaffold warning inside the auto-detect flow. Both are present, but when a project has previously had a refresh cycle run (so `.claude/ccl-practices.json` exists) the §8.1 warning also kicks in because the `.claude/` directory is present. The Phase 5 implementation prompts for §15 first, then greets, then triggers §8.1 inside auto-detect — all explicit in the scripted integration tests. No semantic deviation; recording the ordering interaction for future sessions.
  5. **Fix 5 `"skipped"` step status (post-build):** `StateStep.status` in `templates/types.ts` was widened from `"done" | "pending" | "failed"` to include `"skipped"`. Steps are marked skipped (not failed) when `validateAgentMd` rejects a disallowed tool or `assertWithinRoot` blocks a path traversal. The overall scaffold `status` remains `"complete"` when only skipped steps are present — a skipped step is a security gate, not an error.
  6. **Fix 7 `PathTraversalError` export (post-build):** `PathTraversalError` is exported from `packages/core/src/scaffold.ts` and re-exported through the core barrel. `assertWithinRoot` is module-private. Callers who need to distinguish traversal blocks from other errors can import the class directly.
  7. **Fix 9 `normalizeCclField` export (post-build):** `normalizeCclField` is exported from `override-validator.ts` for use by `practices.ts`. The internal `normalizeField` helper remains module-private. Both validate-and-store functions (overrides + practice candidates) normalize for checking but preserve the original user input in the stored output.

  ---

  ## Patch 1 — 2026-04-24 (both gaps resolved)

  1. **`settings.local.json` scaffolding (§9 gap):** `renderSettingsLocalJson()` now lives in `packages/core/src/templates/settings-local-json.ts` and is wired into `buildScaffoldPlan()` as a dedicated step immediately after `settings.json`. Content is `{}\n` — machine-local overrides only. The existing `gitignore.ts` managed block already listed `.claude/settings.local.json` unconditionally, so it is gitignored regardless of the `gitSync` choice (§8.3).
  2. **`modified` diff bucket display (§15 gap):** `renderDiffSummary(diff)` in `packages/core/src/practices.ts` returns a formatted multi-line string for Phase 5 display. Sections (`NEW:` / `UPDATED:` / `REMOVE:`) are omitted entirely when empty; the unchanged count is always shown in the summary line. `modified` entries render under `UPDATED:` with a `~` prefix and a change reason derived from field-level comparison (`description updated` / `source updated` / `content updated`). Exported through the core barrel via the existing `export * from "./practices.js"`.

  ---

  ## Patch 2 — 2026-04-24 (stack-aware subagent roles)

  References blueprint §12, §18.

  1. **`AgentContext.role` field added** (`templates/types.ts`): `role: string` — stack-specific expert identity rendered in the agent YAML frontmatter.
  2. **`renderAgentMd` (`templates/agent-md.ts`):** emits a `role: …` line immediately after `tools:` when the field is non-empty. Empty string suppresses the field entirely so hand-authored agents stay clean.
  3. **`buildAgentRole(agentName, detected)` (`scaffold.ts`):** pure role generator — no LLM call. Resolves the primary language label (Go version preserved via `Go 1.22` stack entries; Dart → `Flutter` when `flutter` is a dep), picks up to 2 frameworks from `detected.stack` (excludes base-language labels), and emits a two-sentence role: agent-specific framing + precision closer. Agent-name matching is substring-based per the §12 framing table (`security` / `dependency` / `doc` / `onboard` / `performance`/`perf`, default fallback). Unknown stacks get the literal generic fallback from the spec.
  4. **`buildScaffoldPlan` integration:** every agent (baseline or override) is mapped through `buildAgentRole` — overrides with a non-empty `role` are respected via `role: agent.role || buildAgentRole(...)`. Default agents ship with `role: ""` so the generator always takes over for the canonical set.
  5. **Invariants covered by tests:** `role` is always ≤3 sentences, never contains `write` / `create` / `generate` verbs (read-only framing), always ends with `never speculate beyond what the code shows`. Verified across TypeScript/Next.js, Python/FastAPI, and unknown-stack fixtures.

  ---

  ## Patch 3 — 2026-04-24 (skill engine: classify → estimate → generate)

  References blueprint §11, §18.

  1. **New module `packages/core/src/skill-engine.ts`** — three-step dynamic skill content pipeline. Structure stays deterministic in core; content is LLM-generated via an injected `LlmCall` function. No MCP/SDK dependencies in `@ccl/core`.
  2. **8-dimension classifier:** `SkillDimensions` = `procedural`, `persona`, `methodology`, `externalIntegration`, `generativeOutput`, `analytical`, `transformative`, `meta`. `classifySkills(names, ctx, llmCall)` runs one batched LLM call, tolerates markdown fences in the response, and returns `{ classifications, classificationLatencyMs }`. `isHighRisk` flag derived from name substring match (deploy / publish / release / migrate / migration / rollback / delete / drop / destroy / push / overwrite).
  3. **Pure estimator:** `buildEstimates(classifications, latencyMs)` applies `forecastSeconds = ceil(effectiveSeconds × 3.5 × (1 + dimCount × 0.15))` with a `MIN_EFFECTIVE_LATENCY_MS = 500` floor so 0ms latency still produces differentiated forecasts. Returns `SkillEngineEstimates` with `sequentialTotalSeconds` (sum) and `parallelTotalSeconds` (max).
  4. **Display:** `renderEstimatesDisplay(est)` renders an 8-char progress bar (one block per active dimension), table columns for skill / dimensions / forecast, sequential vs parallel totals, approximation note, and the three-option prompt (Parallel / Sequential / Skip). Rows with 0 dimensions are filtered out.
  5. **Generation:** `generateSkill` issues one LLM call per skill using a section map driven by active dimensions and the high-risk flag. Section order: Role → Framework → Setup → Credentials → What to look for → Input → Output → What it creates → When to use → When NOT to use → Steps → Failure modes → Verification criteria → Reference. `generateAllSkills(cls, ctx, mode, llmCall, onProgress?)` dispatches on mode: `parallel` (Promise.all), `sequential` (serial with per-skill `onProgress`), `skip` (returns `basicTemplateBody` — no LLM call).
  6. **Assembly:** `assembleSkillMd(name, cls, body, allowedTools)` wraps the LLM body with YAML frontmatter and auto-extracts `description` from the first sentence of the `## When to use` section.
  7. **Scaffold integration:** `BuildPlanInput.llmCall?: LlmCall` added. `buildScaffoldPlan` is now async — when `llmCall` is provided, it classifies all baseline skills and attaches `skillClassifications` + `skillEstimates` to the returned plan. Phase 5 sets `plan.skillGenerationMode` before calling `executeScaffoldPlan`, which invokes `generateAllSkills` and rewrites skill file content via `assembleSkillMd`. Undefined or `skip` mode keeps the existing static `renderSkillMd` content — no regression for callers that don't plug in an LLM.
  8. **Exported** from `packages/core/src/index.ts` via `export * from "./skill-engine.js"`: `classifySkills`, `buildEstimates`, `renderEstimatesDisplay`, `generateSkill`, `generateAllSkills`, `assembleSkillMd`, `isHighRiskSkillName`, `basicTemplateBody`, `CALIBRATION_MULTIPLIER`, all types (`LlmCall`, `ProjectContextSummary`, `SkillDimensions`, `SkillClassification`, `SkillEstimate`, `SkillEngineEstimates`, `SkillGenerationMode`, `GeneratedSkill`), and `SkillClassifierParseError`.
  9. **Tests:** `test/skill-engine.test.ts` adds 25 assertions covering classifier JSON parsing (incl. fence tolerance, latency > 0, empty-input short-circuit), estimator monotonicity + floor, display formatting (8-char bar, 0-dim row skip, latency rendering), generation modes (skip / sequential / parallel concurrency proof), description extraction, and end-to-end scaffold integration for both `skip` (no LLM calls, static fallback) and `parallel` (generated content written to disk) modes. Existing 78 tests updated for the now-async `buildScaffoldPlan` signature.

  ---

  ## Post-build fixes — 2026-04-24

  Two deviations from `ccl-project-build-status.md` were addressed in a single post-build pass. Blueprint advanced to **v1.2** (`CCL_BLUEPRINT_v1.2.md`); v1.1 stays frozen as a historical reference.

  1. **Blueprint v1.2 — §20 SDK naming + §8.2 resume note:** `CCL_BLUEPRINT_v1.2.md` was created as a copy of v1.1 with three targeted changes — a new `v1.2` changelog entry, a split `MCP server SDK` / `Anthropic client` row in §20, and a clarified `[1] Continue` option description under §8.2 (the option list now calls out idempotent overwrite for already-completed files). No source changes accompanied Fix 1.
  2. **§8.2 resume path in `packages/mcp/src/commands/ccl.ts`:** `resumeInterruptedScaffold` now calls `readScaffoldState(adapter.cwd)`, builds the full scaffold plan, and filters `plan.files` by excluding every step whose persisted `status === "done"`. The filtered plan is passed to `executeScaffoldPlan`. Already-completed files are neither re-read nor re-written — their mtime is unchanged across a resume. The user-facing "Resuming — N steps remaining" line reflects the filtered count. Empty-filter early-exit path added for completeness. Change confined to `ccl.ts` (one import + one function body rewrite); `packages/core/src/scaffold.ts` untouched.
  3. **Integration test I2 updated:** the `I2` scenario in `packages/mcp/test/integration.test.ts` now snapshots `mtimeNs` for every `done` file in `ccl-state.json` after the Phase A failure, sleeps 50 ms to guarantee filesystem clock advance, runs the resume, and asserts `mtimeNs` is unchanged on every snapshotted file. A local `stepNameToPath` helper maps state step names (`skills/<name>`, `agents/<name>`, `CLAUDE.md`, `settings.json`, etc.) to their on-disk paths. `I3` (Restart path) is unchanged. All other integration tests (I1, Groups 1–6) unchanged.

  **Verification:** `npm run -w @ccl/mcp typecheck` clean, `npm run -w @ccl/mcp build` clean, full regression **227 / 227 passing** (core 158 + mcp 69). Wall-clock for the integration suite ~0.9 s, well under the 30 s budget.

// ────────────────────────────────────────────────────────────────────────────
// /ccl — Phase 5 command handler.
// Blueprint: CCL_BLUEPRINT_v1.1.md §4–§8, §15.
// All intelligence lives in @ccl/core. This file is the conversation layer.
// ────────────────────────────────────────────────────────────────────────────

import {
  applyRefresh,
  buildScaffoldPlan,
  computePracticesDiff,
  detectInterruptedScaffold,
  detectProject,
  disableRefresh,
  executeScaffoldPlan,
  isRefreshDue,
  loadPractices,
  readScaffoldState,
  renderCandidateValidationSummary,
  renderDiffSummary,
  renderEstimatesDisplay,
  renderGitignoreAdditions,
  renderPlanPreview,
  renderViolationWarning,
  savePractices,
  validatePracticeCandidates,
  validateScaffoldOverrides,
  type DetectedProject,
  type GitRunner,
  type LlmCall,
  type PracticeEntry,
  type PracticesContext,
  type PracticesDiff,
  type ScaffoldExecutionResult,
  type ScaffoldOverrides,
  type ScaffoldPlan,
  type SkillGenerationMode,
} from "@ccl/core";

// ────────────────────────────────────────────────────────────────────────────
// User-facing strings — all consolidated here (strict rule).
// ────────────────────────────────────────────────────────────────────────────

const GREETING = `👋 Welcome to Claude Context Loader (CCL)

I'll scaffold a production-ready Claude Code project for you — including
CLAUDE.md, skills, subagents, hooks, and all configuration files.`;

const GREETING_OPTIONS_HEADER = `How would you like to get started?`;

const GREETING_OPT_AUTO =
  "Auto-detect — I'll scan your current directory, infer your stack and structure, and scaffold everything automatically.";
const GREETING_OPT_GUIDED =
  "Guided setup — We'll go through your project together so I can tailor everything precisely to what you're building.";

const INTERRUPTED_HEADER = `⚠️  It looks like a previous scaffold was interrupted.`;
const INTERRUPTED_CHOICE_CONTINUE = "Continue from where I left off";
const INTERRUPTED_CHOICE_RESTART = "Start again from scratch";

const RESUMING_PREFIX = "Resuming — ";
const RESUMING_ALREADY_DONE = "All steps from the previous run are already complete. Nothing to do.";

const RESCAFFOLD_HEADER = `⚠️  I found an existing CCL scaffold in this directory.`;
const RESCAFFOLD_PROMPT = "What would you like to do?";
const RESCAFFOLD_OPT_RESCAFFOLD =
  "Re-scaffold — Start fresh. All existing CCL files will be overwritten.";
const RESCAFFOLD_OPT_SKIP = "Skip — Leave everything as-is and exit.";

const Q1 = `What is your project called, and what does it do?

Hint: e.g. "auth-service — a REST API that handles user authentication for our mobile app" or just "my portfolio website"`;
const Q2 = `What type of project is this?

Hint: e.g. web app, REST API, CLI tool, mobile app, browser extension, library/package, desktop app, monorepo, data pipeline`;
const Q3 = `What technologies are you using?

Hint: e.g. "Next.js 14, TypeScript, PostgreSQL, Prisma, Tailwind" or "Python, FastAPI, Redis, Docker" — list as many or as few as you know`;
const Q4 = `Any constraints I should know about?

Hint: e.g. coding style rules ("no default exports"), security requirements ("HIPAA compliant"), deployment environment ("AWS Lambda, no binaries > 5MB"), team conventions ("all PRs need two approvals"), performance targets`;
const Q5 = `Is there anything else about your project you'd like me to know before I build the plan? (press Enter to skip)

Hint: e.g. known pitfalls, legacy decisions, team size, deadline pressure, things the AI should never do in this codebase`;

const PLAN_REVIEW_PROMPT = `Does this look right? Request any changes or say "looks good" to proceed.`;

const APPROVAL_PHRASES = [
  "looks good",
  "looks great",
  "proceed",
  "yes",
  "yep",
  "approve",
  "approved",
  "go ahead",
  "ship it",
  "ok",
  "okay",
];

const GITSYNC_PROMPT = `Would you like to sync ccl-state.json to git?`;
const GITSYNC_OPT_YES =
  "Yes — ccl-state.json will be committed (useful for teams)";
const GITSYNC_OPT_NO =
  "No — ccl-state.json will be gitignored (recommended for solo projects)";

const PERMISSION_PROMPT = `May I create and modify files in this project?`;
const PERMISSION_OPT_YES = "Yes, for this session";
const PERMISSION_OPT_NO = "No";

const SKILL_MODE_OPT_PARALLEL = "Parallel  (recommended)";
const SKILL_MODE_OPT_SEQUENTIAL = "Sequential";
const SKILL_MODE_OPT_SKIP = "Skip — use basic templates, enrich later";
const SKILL_MODE_PROMPT = "How should I generate skill content?";

const REFRESH_HEADER = `📦 It's been 7 days since your best practices were last checked.`;
const REFRESH_PROMPT = "Would you like me to search for updates?";
const REFRESH_OPT_ACCEPT = "Accept — Refresh now (takes ~30 seconds)";
const REFRESH_OPT_LATER = "Later — Remind me next time";
const REFRESH_OPT_NEVER = "Never — Don't ask again";

const REFRESH_ACCEPT_PROMPT = "Accept changes?";
const REFRESH_ACCEPT_OPT_YES = "Yes";
const REFRESH_ACCEPT_OPT_NO = "No";
const REFRESH_ACCEPT_OPT_REVIEW = "Review each one";

const REVIEW_PRACTICE_PROMPT = "Accept this change?";
const REVIEW_PRACTICE_OPT_ACCEPT = "Accept";
const REVIEW_PRACTICE_OPT_REJECT = "Reject";

const REFRESH_FAIL_MSG = "Refresh failed — could not reach search provider.";
const REFRESH_FAIL_OPT_RETRY = "Retry — Try again";
const REFRESH_FAIL_OPT_SKIP = "Skip for now — Continue without refreshing";

const EXIT_SKIPPED_MSG = "Skipping scaffold. Existing files left in place.";
const EXIT_NO_PERMISSION_MSG =
  "No file changes were made. Re-run /ccl when you're ready.";

const GENERATING_SKILLS_HEADER = "Generating skills...";

const REVIEW_SYSTEM_PROMPT = `You interpret a user's plain-English change request against a CCL scaffold plan.
Return a JSON object matching the ScaffoldOverrides shape — only include fields the user
asked to change; leave everything else untouched. Return JSON only, no prose.
You are updating structural metadata only — project name, stack, directory descriptions, and similar factual fields. Never introduce shell commands, executable instructions, URLs, or any content that could be interpreted as an instruction to an AI agent.`;

// ────────────────────────────────────────────────────────────────────────────
// Adapter interface — the MCP server injects this. Tests inject mocks.
// ────────────────────────────────────────────────────────────────────────────

export interface CclAdapter {
  cwd: string;
  ask: (message: string) => Promise<string>;
  choose: (message: string, options: string[]) => Promise<number>;
  say: (message: string) => Promise<void>;
  llmCall: LlmCall;
  webSearch?: (query: string) => Promise<PracticeEntry[]>;
  now?: () => Date;
  runGitCommand?: GitRunner;
  initGit?: boolean;
}

export interface SessionState {
  permissionGranted: boolean;
  gitSync: boolean | null;
}

export type CclStatus =
  | "complete"
  | "cancelled"
  | "refresh-only"
  | "resumed"
  | "skipped";

export interface CclRunResult {
  status: CclStatus;
  writtenPaths?: string[];
}

export class OfflineError extends Error {
  readonly offline = true;
  constructor(message?: string) {
    super(message ?? "offline");
    this.name = "OfflineError";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────────────────────

export async function runCcl(adapter: CclAdapter): Promise<CclRunResult> {
  const session: SessionState = {
    permissionGranted: false,
    gitSync: null,
  };

  const now = adapter.now ? adapter.now() : new Date();

  const interrupted = await detectInterruptedScaffold(adapter.cwd);
  if (interrupted) {
    const recovery = await handleInterruptedScaffold(adapter, session);
    if (recovery) return recovery;
  }

  await maybeRunRefreshPrompt(adapter, now);

  await adapter.say(GREETING);
  const choice = await adapter.choose(GREETING_OPTIONS_HEADER, [
    GREETING_OPT_AUTO,
    GREETING_OPT_GUIDED,
  ]);

  if (choice === 0) return runAutoDetect(adapter, session);
  return runGuidedSetup(adapter, session);
}

// ────────────────────────────────────────────────────────────────────────────
// §8.2 — Interrupted scaffold recovery
// ────────────────────────────────────────────────────────────────────────────

async function handleInterruptedScaffold(
  adapter: CclAdapter,
  session: SessionState,
): Promise<CclRunResult | null> {
  const interrupted = await detectInterruptedScaffold(adapter.cwd);
  if (!interrupted) return null;

  const remaining = interrupted.remainingSteps.join(", ") || "(none)";
  const last = interrupted.lastCompletedStep ?? "(none)";
  await adapter.say(INTERRUPTED_HEADER);
  await adapter.say(`  Last completed step: ${last}`);
  await adapter.say(`  Remaining: ${remaining}`);

  const choice = await adapter.choose("", [
    INTERRUPTED_CHOICE_CONTINUE,
    INTERRUPTED_CHOICE_RESTART,
  ]);
  if (choice === 0) {
    return resumeInterruptedScaffold(adapter, session);
  }
  return null;
}

async function resumeInterruptedScaffold(
  adapter: CclAdapter,
  session: SessionState,
): Promise<CclRunResult> {
  const priorState = await readScaffoldState(adapter.cwd);
  const detected = await detectProject(adapter.cwd);
  const plan = await buildScaffoldPlan({
    detected,
    gitSync: true,
    llmCall: adapter.llmCall,
    now: adapter.now ? adapter.now() : new Date(),
  });

  const doneStepNames = new Set(
    (priorState?.steps ?? [])
      .filter((s) => s.status === "done")
      .map((s) => s.name),
  );
  plan.files = plan.files.filter((f) => !doneStepNames.has(f.stepName));

  if (plan.files.length === 0) {
    await adapter.say(RESUMING_ALREADY_DONE);
    return { status: "resumed", writtenPaths: [] };
  }

  await adapter.say(
    `${RESUMING_PREFIX}${plan.files.length} step${plan.files.length === 1 ? "" : "s"} remaining.`,
  );

  const gitSync = await promptGitSync(adapter, session);
  applyGitSyncToPlan(plan, gitSync);

  const authorized = await ensureSessionPermission(adapter, session);
  if (!authorized) return { status: "cancelled" };

  const result = await doExecute(adapter, plan);
  await adapter.say(renderCompletionSummary(plan, result));
  return { status: "resumed", writtenPaths: result.written };
}

// ────────────────────────────────────────────────────────────────────────────
// §15 — Best practices refresh flow
// ────────────────────────────────────────────────────────────────────────────

async function maybeRunRefreshPrompt(
  adapter: CclAdapter,
  now: Date,
): Promise<void> {
  const practices = await loadPractices(adapter.cwd);
  if (!practices) return;
  if (!isRefreshDue(practices, now)) return;

  await adapter.say(REFRESH_HEADER);
  const choice = await adapter.choose(REFRESH_PROMPT, [
    REFRESH_OPT_ACCEPT,
    REFRESH_OPT_LATER,
    REFRESH_OPT_NEVER,
  ]);

  if (choice === 1) return; // Later — no-op
  if (choice === 2) {
    await savePractices(adapter.cwd, disableRefresh(practices));
    return;
  }
  await runAcceptedRefresh(adapter, practices, now);
}

async function runAcceptedRefresh(
  adapter: CclAdapter,
  current: PracticesContext,
  now: Date,
): Promise<void> {
  const rawCandidates = await fetchCandidatesWithRetry(adapter);
  if (rawCandidates === null) return; // offline OR user skipped

  // Security gate: every candidate must pass source-domain + content validation
  // before it can reach applyRefresh. Untrusted sources never persist — this is
  // also what protects the bulk [Yes] path, which has no per-item review.
  const { valid, rejected, totalViolations } = validatePracticeCandidates(
    rawCandidates,
    now,
  );
  const summary = renderCandidateValidationSummary(rejected, totalViolations);
  if (summary !== null) await adapter.say(summary);

  const diff = computePracticesDiff(current.practices, valid);
  await adapter.say(renderDiffSummary(diff));

  const action = await adapter.choose(REFRESH_ACCEPT_PROMPT, [
    REFRESH_ACCEPT_OPT_YES,
    REFRESH_ACCEPT_OPT_NO,
    REFRESH_ACCEPT_OPT_REVIEW,
  ]);

  if (action === 1) {
    const result = applyRefresh(current, [], now);
    await savePractices(adapter.cwd, result.next);
    return;
  }
  if (action === 2) {
    const filtered = await reviewPracticesOneByOne(adapter, diff, current.practices);
    const result = applyRefresh(current, filtered, now);
    await savePractices(adapter.cwd, result.next);
    return;
  }
  const result = applyRefresh(current, valid, now);
  await savePractices(adapter.cwd, result.next);
}

async function fetchCandidatesWithRetry(
  adapter: CclAdapter,
): Promise<PracticeEntry[] | null> {
  if (!adapter.webSearch) return null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await adapter.webSearch("Claude Code best practices");
    } catch (err) {
      if (isOfflineError(err)) return null;
      await adapter.say(REFRESH_FAIL_MSG);
      const choice = await adapter.choose("", [
        REFRESH_FAIL_OPT_RETRY,
        REFRESH_FAIL_OPT_SKIP,
      ]);
      if (choice === 1) return null;
    }
  }
}

function isOfflineError(err: unknown): boolean {
  if (err instanceof OfflineError) return true;
  if (err && typeof err === "object" && "offline" in err) {
    return (err as { offline?: unknown }).offline === true;
  }
  return false;
}

async function reviewPracticesOneByOne(
  adapter: CclAdapter,
  diff: PracticesDiff,
  currentPractices: PracticeEntry[],
): Promise<PracticeEntry[]> {
  interface ReviewItem {
    kind: "added" | "removed" | "modified";
    entry: PracticeEntry;
  }
  const items: ReviewItem[] = [
    ...diff.added.map((e): ReviewItem => ({ kind: "added", entry: e })),
    ...diff.modified.map((m): ReviewItem => ({ kind: "modified", entry: m.after })),
    ...diff.removed.map((e): ReviewItem => ({ kind: "removed", entry: e })),
  ];

  const accepted = new Set<string>();
  const rejected = new Set<string>();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const prefix = item.kind === "added" ? "+" : item.kind === "removed" ? "-" : "~";
    await adapter.say(
      `Practice ${i + 1} of ${items.length}:\n\n${prefix} ${item.entry.title}\n${item.entry.description}\nSource: ${item.entry.source}`,
    );
    const choice = await adapter.choose(REVIEW_PRACTICE_PROMPT, [
      REVIEW_PRACTICE_OPT_ACCEPT,
      REVIEW_PRACTICE_OPT_REJECT,
    ]);
    if (choice === 0) accepted.add(item.entry.id);
    else rejected.add(item.entry.id);
  }

  const result: PracticeEntry[] = [];
  for (const cur of currentPractices) {
    const removalItem = diff.removed.find((r) => r.id === cur.id);
    if (removalItem && accepted.has(cur.id)) continue;
    const modItem = diff.modified.find((m) => m.before.id === cur.id);
    if (modItem && accepted.has(modItem.after.id)) {
      result.push(modItem.after);
      continue;
    }
    result.push(cur);
  }
  for (const add of diff.added) {
    if (accepted.has(add.id)) result.push(add);
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Auto-detect flow (§5)
// ────────────────────────────────────────────────────────────────────────────

async function runAutoDetect(
  adapter: CclAdapter,
  session: SessionState,
): Promise<CclRunResult> {
  const detected = await detectProject(adapter.cwd);

  if (detected.existingCcl.hasClaudeMd || detected.existingCcl.hasClaudeDir) {
    const proceed = await handleRescaffoldWarning(adapter, detected);
    if (!proceed) {
      await adapter.say(EXIT_SKIPPED_MSG);
      return { status: "skipped" };
    }
  }

  return runBuildAndExecute(adapter, session, detected, {});
}

async function handleRescaffoldWarning(
  adapter: CclAdapter,
  detected: DetectedProject,
): Promise<boolean> {
  await adapter.say(RESCAFFOLD_HEADER);
  await adapter.say(renderExistingCclLines(detected));
  const choice = await adapter.choose(RESCAFFOLD_PROMPT, [
    RESCAFFOLD_OPT_RESCAFFOLD,
    RESCAFFOLD_OPT_SKIP,
  ]);
  return choice === 0;
}

function renderExistingCclLines(detected: DetectedProject): string {
  const lines: string[] = [];
  if (detected.existingCcl.hasClaudeMd) lines.push("  CLAUDE.md           ✓ exists");
  if (detected.existingCcl.hasClaudeDir) lines.push("  .claude/            ✓ exists");
  if (detected.existingCcl.practices) {
    const now = Date.now();
    const updated = Date.parse(detected.existingCcl.practices.lastUpdatedIso);
    const days = Math.max(0, Math.round((now - updated) / (24 * 3600 * 1000)));
    lines.push(
      `  ccl-practices.json  ✓ exists (v${detected.existingCcl.practices.version}, last updated ${days} days ago)`,
    );
  }
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Guided setup (§6)
// ────────────────────────────────────────────────────────────────────────────

async function runGuidedSetup(
  adapter: CclAdapter,
  session: SessionState,
): Promise<CclRunResult> {
  const a1 = (await adapter.ask(Q1)).trim();
  const a2 = (await adapter.ask(Q2)).trim();
  const a3 = (await adapter.ask(Q3)).trim();
  const a4 = (await adapter.ask(Q4)).trim();
  const a5 = (await adapter.ask(Q5)).trim();

  const detected = await detectProject(adapter.cwd);
  const overrides = mapGuidedAnswersToOverrides({ a1, a2, a3, a4, a5 });

  // §8.4 — sanitise free-text answers (Q4 → codingRules, Q5 → gotchas)
  // before they can reach CLAUDE.md / SKILL.md.
  const { overrides: safe, violations } = validateScaffoldOverrides({
    codingRules: overrides.codingRules,
    gotchas: overrides.gotchas,
  });
  if (violations.length > 0) {
    await adapter.say(renderViolationWarning(violations));
  }
  if (safe.codingRules !== undefined) overrides.codingRules = safe.codingRules;
  if (safe.gotchas !== undefined) overrides.gotchas = safe.gotchas;

  return runBuildAndExecute(adapter, session, detected, overrides);
}

interface GuidedAnswers {
  a1: string;
  a2: string;
  a3: string;
  a4: string;
  a5: string;
}

function mapGuidedAnswersToOverrides(a: GuidedAnswers): ScaffoldOverrides {
  const overrides: ScaffoldOverrides = {};
  if (a.a1) {
    const split = a.a1.split(/\s+[—-]\s+/);
    if (split.length >= 2 && split[0]) {
      overrides.projectName = split[0].trim();
      overrides.whatIsThis = split.slice(1).join(" — ").trim();
    } else {
      overrides.whatIsThis = a.a1;
    }
  }
  if (a.a2) overrides.projectType = mapProjectType(a.a2);
  if (a.a3) overrides.stack = a.a3.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (a.a4) overrides.codingRules = a.a4.split(/\n/).map((s) => s.trim()).filter(Boolean);
  if (a.a5) overrides.gotchas = [a.a5];
  return overrides;
}

function mapProjectType(raw: string): NonNullable<ScaffoldOverrides["projectType"]> {
  const s = raw.toLowerCase();
  if (/rest\s*api|api/.test(s)) return "rest-api";
  if (/monorepo|workspace/.test(s)) return "monorepo";
  if (/mobile|flutter|react\s*native|ios|android/.test(s)) return "mobile-app";
  if (/library|package|sdk/.test(s)) return "library";
  if (/cli|tool/.test(s)) return "cli";
  if (/data|pipeline|etl/.test(s)) return "data-pipeline";
  if (/web|site|app|front/.test(s)) return "web-app";
  return "unknown";
}

// ────────────────────────────────────────────────────────────────────────────
// Build + plan review + execute (shared by auto-detect and guided setup)
// ────────────────────────────────────────────────────────────────────────────

async function runBuildAndExecute(
  adapter: CclAdapter,
  session: SessionState,
  detected: DetectedProject,
  initialOverrides: ScaffoldOverrides,
): Promise<CclRunResult> {
  let overrides: ScaffoldOverrides = { ...initialOverrides };
  let plan = await buildScaffoldPlan({
    detected,
    gitSync: true,
    overrides,
    llmCall: adapter.llmCall,
    now: adapter.now ? adapter.now() : new Date(),
  });

  await handleSkillGenerationModeChoice(adapter, plan);
  plan = await runPlanReviewLoop(adapter, plan, detected, overrides);

  const gitSync = await promptGitSync(adapter, session);
  applyGitSyncToPlan(plan, gitSync);

  const authorized = await ensureSessionPermission(adapter, session);
  if (!authorized) {
    await adapter.say(EXIT_NO_PERMISSION_MSG);
    return { status: "cancelled" };
  }

  const result = await doExecute(adapter, plan);
  await adapter.say(renderCompletionSummary(plan, result));
  return { status: "complete", writtenPaths: result.written };
}

async function runPlanReviewLoop(
  adapter: CclAdapter,
  initialPlan: ScaffoldPlan,
  detected: DetectedProject,
  initialOverrides: ScaffoldOverrides,
): Promise<ScaffoldPlan> {
  let plan = initialPlan;
  let overrides: ScaffoldOverrides = { ...initialOverrides };
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await adapter.say(renderPlanPreview(plan));
    const response = (await adapter.ask(PLAN_REVIEW_PROMPT)).trim();
    if (isApproval(response)) return plan;
    overrides = await applyReviewChange(adapter, response, overrides);
    const rebuilt = await buildScaffoldPlan({
      detected,
      gitSync: plan.gitSync,
      overrides,
      llmCall: adapter.llmCall,
      now: adapter.now ? adapter.now() : new Date(),
    });
    // Preserve user's skill generation choice across rebuilds.
    if (plan.skillGenerationMode) {
      rebuilt.skillGenerationMode = plan.skillGenerationMode;
    }
    plan = rebuilt;
  }
}

function isApproval(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return APPROVAL_PHRASES.some((p) => t === p || t.startsWith(p + " ") || t.includes(p));
}

async function applyReviewChange(
  adapter: CclAdapter,
  userInput: string,
  current: ScaffoldOverrides,
): Promise<ScaffoldOverrides> {
  const prompt = [
    `User said: ${userInput}`,
    `Current overrides JSON: ${JSON.stringify(current)}`,
    `Return the updated overrides JSON (same shape). Only modify fields the user asked to change.`,
  ].join("\n");
  let raw: string;
  try {
    raw = await adapter.llmCall(prompt, REVIEW_SYSTEM_PROMPT);
  } catch {
    return current;
  }
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return current;
  }
  const { overrides: safe, violations } = validateScaffoldOverrides(parsed);
  if (violations.length > 0) {
    await adapter.say(renderViolationWarning(violations));
  }
  return { ...current, ...safe };
}

// ────────────────────────────────────────────────────────────────────────────
// Skill generation UX (Patch 3)
// ────────────────────────────────────────────────────────────────────────────

async function handleSkillGenerationModeChoice(
  adapter: CclAdapter,
  plan: ScaffoldPlan,
): Promise<void> {
  if (!plan.skillEstimates) return;
  if (plan.skillEstimates.classifications.length === 0) return;

  await adapter.say(renderEstimatesDisplay(plan.skillEstimates));
  const choice = await adapter.choose(SKILL_MODE_PROMPT, [
    SKILL_MODE_OPT_PARALLEL,
    SKILL_MODE_OPT_SEQUENTIAL,
    SKILL_MODE_OPT_SKIP,
  ]);
  const modes: SkillGenerationMode[] = ["parallel", "sequential", "skip"];
  plan.skillGenerationMode = modes[choice] ?? "skip";
}

// ────────────────────────────────────────────────────────────────────────────
// gitSync + permission prompts
// ────────────────────────────────────────────────────────────────────────────

async function promptGitSync(
  adapter: CclAdapter,
  session: SessionState,
): Promise<boolean> {
  const choice = await adapter.choose(GITSYNC_PROMPT, [
    GITSYNC_OPT_YES,
    GITSYNC_OPT_NO,
  ]);
  const gitSync = choice === 0;
  session.gitSync = gitSync;
  return gitSync;
}

async function ensureSessionPermission(
  adapter: CclAdapter,
  session: SessionState,
): Promise<boolean> {
  if (session.permissionGranted) return true;
  const choice = await adapter.choose(PERMISSION_PROMPT, [
    PERMISSION_OPT_YES,
    PERMISSION_OPT_NO,
  ]);
  if (choice === 0) {
    session.permissionGranted = true;
    return true;
  }
  return false;
}

function applyGitSyncToPlan(plan: ScaffoldPlan, gitSync: boolean): void {
  plan.gitSync = gitSync;
  const gitignoreStep = plan.files.find((f) => f.path === ".gitignore");
  if (gitignoreStep) {
    gitignoreStep.content = renderGitignoreAdditions({
      syncStateToGit: gitSync,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Execute + summary
// ────────────────────────────────────────────────────────────────────────────

async function doExecute(
  adapter: CclAdapter,
  plan: ScaffoldPlan,
): Promise<ScaffoldExecutionResult> {
  const hasSkillGeneration =
    plan.skillGenerationMode === "parallel" ||
    plan.skillGenerationMode === "sequential";

  if (hasSkillGeneration && plan.skills.length > 0) {
    await adapter.say(GENERATING_SKILLS_HEADER);
  }

  return executeScaffoldPlan(plan, {
    llmCall: adapter.llmCall,
    onStepStart: (step) => {
      if (step.startsWith("skills/") && hasSkillGeneration) {
        void adapter.say(`  ⟳ ${step}  (generating...)`);
        return;
      }
      void adapter.say(`  ⟳ ${step}`);
    },
    onStepDone: (step) => {
      void adapter.say(`  ✓ ${step}`);
    },
    onSkillGenerationProgress: (skillName, index, total) => {
      void adapter.say(`  ✓ ${skillName}  (${index + 1}/${total})`);
    },
    ...(adapter.runGitCommand !== undefined
      ? { runGitCommand: adapter.runGitCommand }
      : {}),
    ...(adapter.initGit !== undefined ? { initGit: adapter.initGit } : {}),
    ...(adapter.now !== undefined ? { now: adapter.now } : {}),
  });
}

function renderCompletionSummary(
  plan: ScaffoldPlan,
  result: ScaffoldExecutionResult,
): string {
  const lines: string[] = [];
  lines.push(`✅ CCL scaffold complete for ${plan.projectName}`);
  lines.push("");
  lines.push("  Created:");
  for (const path of result.written) {
    lines.push(`  ✓ ${path}`);
  }
  if (result.gitInitialized) lines.push("  ✓ git init");
  lines.push("");
  lines.push("  Your project is ready. Open CLAUDE.md to review and refine.");
  lines.push("  Best practices will refresh automatically in 7 days.");
  return lines.join("\n");
}

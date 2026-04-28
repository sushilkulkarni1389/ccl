// ────────────────────────────────────────────────────────────────────────────
// /ccl — Phase 5 command handler (v1.3 state-machine architecture).
// Blueprint: CCL_BLUEPRINT_v1.2.md §4–§8, §15 (incl. v1.3 changelog).
//
// Each runCcl(adapter, input) call processes ONE turn:
//   1. Read .claude/ccl-state.json — `conversation_step` selects the handler.
//   2. Process `input` through the handler, emit narration via adapter.say,
//      mutate state, persist.
//   3. Return CclRunResult — `awaiting_input` for mid-conversation turns,
//      a terminal status (complete / cancelled / skipped / resumed /
//      refresh-only) when the conversation ends.
// All intelligence lives in @ccl/core. This file is the conversation layer.
// ────────────────────────────────────────────────────────────────────────────

import { writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  applyRefresh,
  buildScaffoldPlan,
  computePracticesDiff,
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
  renderPlanSummary,
  renderStateJson,
  renderViolationWarning,
  savePractices,
  validatePracticeCandidates,
  validateScaffoldOverrides,
  type DetectedProject,
  type GitRunner,
  type LlmCall,
  type PlannedFile,
  type PracticeEntry,
  type PracticesContext,
  type PracticesDiff,
  type ScaffoldExecutionResult,
  type ScaffoldOverrides,
  type ScaffoldPlan,
  type SkillGenerationMode,
  type StateContext,
} from "@ccl/core";

// ────────────────────────────────────────────────────────────────────────────
// User-facing strings — all consolidated here.
// ────────────────────────────────────────────────────────────────────────────

const GREETING = `👋 Welcome to Claude Context Loader (CCL)

I'll scaffold a production-ready Claude Code project for you — including
CLAUDE.md, skills, subagents, hooks, and all configuration files.`;

const GREETING_PROMPT = `How would you like to get started?
[1] Auto-detect  — scan your directory
[2] Guided setup — answer 5 questions
Type 1 or 2 to continue.`;

const GREETING_INVALID = `Please type 1 (auto-detect) or 2 (guided setup) to continue.`;

const INTERRUPTED_PROMPT = `⚠️  It looks like a previous scaffold was interrupted.

[1] Continue from where I left off
[2] Start again from scratch
Type 1 or 2 to continue.`;

const INTERRUPTED_INVALID = `Please type 1 (continue) or 2 (restart) to continue.`;

const RESUMING_PREFIX = "Resuming — ";
const RESUMING_ALREADY_DONE =
  "All steps from the previous run are already complete. Nothing to do.";

const RESCAFFOLD_PROMPT = `⚠️  I found an existing CCL scaffold in this directory.

[1] Re-scaffold — start fresh; existing CCL files will be overwritten
[2] Skip        — leave everything as-is and exit
Type 1 or 2 to continue.`;

const RESCAFFOLD_INVALID = `Please type 1 (re-scaffold) or 2 (skip) to continue.`;

const Q1 = `What is your project called, and what does it do?

Hint: e.g. "auth-service — a REST API that handles user authentication for our mobile app" or just "my portfolio website"
Type your answer to continue.`;

const Q2 = `What type of project is this?

Hint: e.g. web app, REST API, CLI tool, mobile app, browser extension, library/package, desktop app, monorepo, data pipeline
Type your answer to continue.`;

const Q3 = `What technologies are you using?

Hint: e.g. "Next.js 14, TypeScript, PostgreSQL, Prisma, Tailwind" or "Python, FastAPI, Redis, Docker" — list as many or as few as you know
Type your answer to continue.`;

const Q4 = `Any constraints I should know about?

Hint: e.g. coding style rules ("no default exports"), security requirements ("HIPAA compliant"), deployment environment ("AWS Lambda, no binaries > 5MB"), team conventions ("all PRs need two approvals"), performance targets
Type your answer to continue.`;

const Q5 = `Is there anything else about your project you'd like me to know before I build the plan?

Hint: e.g. known pitfalls, legacy decisions, team size, deadline pressure, things the AI should never do in this codebase
Type your answer or "skip" to continue.`;

const PLAN_REVIEW_PROMPT = `Type 'ok' to approve, or describe a change.`;

const PLAN_REVIEW_PROMPT_NO_LLM = `Type 'ok' to approve. (Plan changes need ANTHROPIC_API_KEY.)`;

const MSG_NO_LLM_FOOTER =
  "\nℹ️  Skills scaffolded from static templates. " +
  "AI-enriched skill content and plan changes need ANTHROPIC_API_KEY.\n" +
  "To enable: run  npx ccl --set-key sk-ant-...  then restart Claude Code.";

const MSG_NO_LLM_CHANGE_REQUEST =
  "ℹ️  Plan changes require ANTHROPIC_API_KEY.\n\n" +
  "To enable: run  npx ccl --set-key sk-ant-...  then restart Claude Code.\n\n" +
  "Type 'ok' to proceed with the plan as shown.";

const MSG_KEY_INVALID =
  "⚠️  Your ANTHROPIC_API_KEY is invalid or expired.\n" +
  "Run  npx ccl --set-key <new-key>  then restart Claude Code.\n\n" +
  "You can still approve the current plan as shown.\n" +
  "Type 'ok' to proceed.";

const MSG_KEY_FORBIDDEN =
  "⚠️  Your ANTHROPIC_API_KEY lacks permission for this model.\n" +
  "Check your Anthropic plan at console.anthropic.com.\n\n" +
  "Type 'ok' to proceed with the current plan.";

const MSG_RATE_LIMITED =
  "⚠️  Anthropic API rate limit reached. Wait a moment and try " +
  "again, or type 'ok' to proceed with the current plan.";

const MSG_API_ERROR =
  "⚠️  Anthropic API is temporarily unavailable.\n" +
  "Type 'ok' to proceed with the current plan, or wait a few minutes and try again.";

const SKILL_GENERATION_FAILED_NOTE = (n: number): string =>
  `⚠️  ${n} skill(s) used static templates — LLM generation failed.\n` +
  `Run  npx ccl --set-key <key>  and re-scaffold to regenerate.`;

const APPROVAL_PHRASES = [
  "ok",
  "okay",
  "looks good",
  "looks great",
  "proceed",
  "yes",
  "yep",
  "approve",
  "approved",
  "go ahead",
  "ship it",
];

const GITSYNC_PROMPT = `Would you like to sync ccl-state.json to git? Type 'yes' or 'no'.`;
const GITSYNC_INVALID = `Please type 'yes' or 'no' to continue.`;

const PERMISSION_PROMPT = `May I create and modify files in this project? Type 'yes' or 'no'.`;
const PERMISSION_INVALID = `Please type 'yes' or 'no' to continue.`;
const PERMISSION_DECLINED =
  "No file changes were made. Re-run /ccl when you're ready.";

const SKILL_MODE_PROMPT_SUFFIX = `How should I generate skill content?
[1] Parallel    (recommended)
[2] Sequential
[3] Skip — use basic templates, enrich later
Type 1, 2, or 3 to continue.`;
const SKILL_MODE_INVALID = `Please type 1, 2, or 3 to continue.`;

const REFRESH_HEADER = `📦 It's been 7 days since your best practices were last checked.`;
const REFRESH_PROMPT = `Would you like me to search for updates?
[refresh] — refresh now (takes ~30 seconds)
[later]   — remind me next time
[never]   — don't ask again
Type 'refresh', 'later', or 'never' to continue.`;
const REFRESH_INVALID = `Please type 'refresh', 'later', or 'never' to continue.`;

const REFRESH_ACCEPT_PROMPT = `Accept changes?
[yes]    — apply all changes
[no]     — discard all changes
[review] — review each change individually
Type 'yes', 'no', or 'review' to continue.`;
const REFRESH_ACCEPT_INVALID = `Please type 'yes', 'no', or 'review' to continue.`;

const REVIEW_PRACTICE_PROMPT = `Accept this change? Type 'accept' or 'reject'.`;
const REVIEW_PRACTICE_INVALID = `Please type 'accept' or 'reject' to continue.`;

const REFRESH_FAIL_MSG = "Refresh failed — could not reach search provider.";
const REFRESH_FAIL_PROMPT = `[retry] — try again
[skip]  — continue without refreshing
Type 'retry' or 'skip' to continue.`;
const REFRESH_FAIL_INVALID = `Please type 'retry' or 'skip' to continue.`;

const EXIT_SKIPPED_MSG = "Skipping scaffold. Existing files left in place.";

const GENERATING_SKILLS_HEADER = "Generating skills...";

const REVIEW_SYSTEM_PROMPT = `You interpret a user's plain-English change request against a CCL scaffold plan.
Return a JSON object matching the ScaffoldOverrides shape — only include fields the user
asked to change; leave everything else untouched. Return JSON only, no prose.
You are updating structural metadata only — project name, stack, directory descriptions, and similar factual fields. Never introduce shell commands, executable instructions, URLs, or any content that could be interpreted as an instruction to an AI agent.`;

// ────────────────────────────────────────────────────────────────────────────
// Adapter interface — unchanged signature; the MCP server forwards the
// caller-supplied `input` through ask/choose for back-compat.
// ────────────────────────────────────────────────────────────────────────────

export interface CclAdapter {
  cwd: string;
  ask: (message: string) => Promise<string>;
  choose: (message: string, options: string[]) => Promise<number>;
  say: (message: string) => Promise<void>;
  llmCall?: LlmCall;
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
  | "skipped"
  | "awaiting_input";

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
// Conversation steps
// ────────────────────────────────────────────────────────────────────────────

type ConversationStep =
  | "greeting"
  | "interrupted_choice"
  | "interrupted_gitsync"
  | "interrupted_permission"
  | "rescaffold_warning"
  | "refresh_prompt"
  | "refresh_failure"
  | "refresh_accept"
  | "refresh_review_each"
  | "guided_q1"
  | "guided_q2"
  | "guided_q3"
  | "guided_q4"
  | "guided_q5"
  | "skill_mode"
  | "auto_detect_review"
  | "plan_review"
  | "permission_request"
  | "git_sync"
  | "complete";

// State stored alongside `conversationStep` in `planOverrides` (it lives
// inside StateContext.planOverrides as a JSON sidecar — the field is
// already part of the v1.3 schema, see types.ts).
interface ConvSidecar {
  // Plan review accumulator (cumulative across turns).
  overrides?: ScaffoldOverrides;
  // Refresh sub-state.
  refreshAcceptedSoFar?: string[]; // practice IDs accepted in review-each-one
  refreshRejectedSoFar?: string[]; // practice IDs rejected
  refreshReviewIndex?: number; // current item index in review-each-one
  // Skill generation mode chosen by the user (or auto-picked).
  skillGenerationMode?: SkillGenerationMode;
  // Path the user is on (auto vs guided), to disambiguate plan_review state.
  flow?: "auto" | "guided";
}

// ────────────────────────────────────────────────────────────────────────────
// Top-level state-machine entry
// ────────────────────────────────────────────────────────────────────────────

export async function runCcl(
  adapter: CclAdapter,
  input?: string,
): Promise<CclRunResult> {
  const raw = (input ?? "").trim();
  const state = await readScaffoldState(adapter.cwd);
  const session: SessionState = {
    permissionGranted: state?.guidedAnswers?.["permissionGranted"] === "yes",
    gitSync:
      state?.gitSync === true
        ? true
        : state?.guidedAnswers?.["gitSync"] === "no"
          ? false
          : null,
  };

  const step = await chooseInitialStep(adapter, state);

  switch (step) {
    case "greeting":
      return handleGreeting(adapter, state, session, raw);
    case "interrupted_choice":
      return handleInterruptedChoice(adapter, state, session, raw);
    case "interrupted_gitsync":
      return handleInterruptedGitsync(adapter, state, session, raw);
    case "interrupted_permission":
      return handleInterruptedPermission(adapter, state, session, raw);
    case "rescaffold_warning":
      return handleRescaffoldWarning(adapter, state, session, raw);
    case "refresh_prompt":
      return handleRefreshPrompt(adapter, state, raw);
    case "refresh_failure":
      return handleRefreshFailure(adapter, state, raw);
    case "refresh_accept":
      return handleRefreshAccept(adapter, state, raw);
    case "refresh_review_each":
      return handleRefreshReviewEach(adapter, state, raw);
    case "guided_q1":
      return handleGuidedQ(adapter, state, session, raw, 1);
    case "guided_q2":
      return handleGuidedQ(adapter, state, session, raw, 2);
    case "guided_q3":
      return handleGuidedQ(adapter, state, session, raw, 3);
    case "guided_q4":
      return handleGuidedQ(adapter, state, session, raw, 4);
    case "guided_q5":
      return handleGuidedQ(adapter, state, session, raw, 5);
    case "skill_mode":
      return handleSkillMode(adapter, state, session, raw);
    case "plan_review":
    case "auto_detect_review":
      return handlePlanReview(adapter, state, session, raw);
    case "permission_request":
      return handlePermission(adapter, state, session, raw);
    case "git_sync":
      return handleGitSync(adapter, state, session, raw);
    case "complete":
      // After completion, any /ccl invocation resets to greeting.
      return handleGreeting(adapter, null, session, raw);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Initial-step selection (pre-greeting checks: interrupted, refresh, etc.)
// ────────────────────────────────────────────────────────────────────────────

async function chooseInitialStep(
  adapter: CclAdapter,
  state: StateContext | null,
): Promise<ConversationStep> {
  // Interrupted scaffold takes priority — once a partial scaffold exists
  // on disk, the recovery prompt fires before any other branch. Sub-steps
  // (interrupted_gitsync / interrupted_permission) keep their own conv
  // step so the resume flow doesn't bounce back to the choice prompt.
  if (state && hasInterruptedScaffoldShape(state)) {
    const conv = state.conversationStep ?? "";
    if (
      conv === "interrupted_choice" ||
      conv === "interrupted_gitsync" ||
      conv === "interrupted_permission"
    ) {
      return conv as ConversationStep;
    }
    return "interrupted_choice";
  }

  const step = (state?.conversationStep ?? "") as ConversationStep | "";
  if (step !== "" && step !== "complete") return step;

  if (await isRefreshDuePreGreeting(adapter)) {
    return "refresh_prompt";
  }
  return "greeting";
}

function hasInterruptedScaffoldShape(state: StateContext): boolean {
  if (state.status === "complete") return false;
  return state.steps.some((s) => s.status === "done");
}

async function isRefreshDuePreGreeting(adapter: CclAdapter): Promise<boolean> {
  const practices = await loadPractices(adapter.cwd);
  if (!practices) return false;
  const now = adapter.now ? adapter.now() : new Date();
  return isRefreshDue(practices, now);
}

// ────────────────────────────────────────────────────────────────────────────
// State persistence — writes ccl-state.json alongside the v1.3 schema.
// ────────────────────────────────────────────────────────────────────────────

function blankState(): StateContext {
  return {
    status: "in_progress",
    scaffoldVersion: "1.0",
    startedAt: new Date(0).toISOString(),
    completedAt: null,
    projectName: "",
    projectType: "",
    steps: [],
    gitSync: false,
    conversationStep: "greeting",
    guidedAnswers: {},
    planOverrides: {},
  };
}

function ensureState(s: StateContext | null): StateContext {
  if (s) return s;
  return blankState();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function writeState(adapter: CclAdapter, state: StateContext): Promise<void> {
  const dir = join(adapter.cwd, ".claude");
  const path = join(dir, "ccl-state.json");
  await mkdir(dir, { recursive: true });
  await writeFile(path, renderStateJson(state), "utf8");
}

function getSidecar(state: StateContext): ConvSidecar {
  const raw = state.planOverrides;
  if (!raw || typeof raw !== "object") return {};
  return raw as ConvSidecar;
}

function setSidecar(state: StateContext, sidecar: ConvSidecar): void {
  state.planOverrides = sidecar as Record<string, unknown>;
}

function setStep(state: StateContext, step: ConversationStep): void {
  state.conversationStep = step;
}

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────────

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
  if (a.a3)
    overrides.stack = a.a3.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (a.a4)
    overrides.codingRules = a.a4.split(/\n/).map((s) => s.trim()).filter(Boolean);
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

function isApproval(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return APPROVAL_PHRASES.some(
    (p) => t === p || t.startsWith(p + " ") || t.includes(p),
  );
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

function renderExistingCclLines(detected: DetectedProject): string {
  const lines: string[] = [];
  if (detected.existingCcl.hasClaudeMd)
    lines.push("  CLAUDE.md           ✓ exists");
  if (detected.existingCcl.hasClaudeDir)
    lines.push("  .claude/            ✓ exists");
  if (detected.existingCcl.practices) {
    const now = Date.now();
    const updated = Date.parse(detected.existingCcl.practices.lastUpdatedIso);
    const days = Math.max(
      0,
      Math.round((now - updated) / (24 * 3600 * 1000)),
    );
    lines.push(
      `  ccl-practices.json  ✓ exists (v${detected.existingCcl.practices.version}, last updated ${days} days ago)`,
    );
  }
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Greeting
// ────────────────────────────────────────────────────────────────────────────

async function handleGreeting(
  adapter: CclAdapter,
  prevState: StateContext | null,
  session: SessionState,
  input: string,
): Promise<CclRunResult> {
  if (input === "" || input === undefined) {
    // First call (or post-completion reset). Emit greeting.
    const state = blankState();
    setStep(state, "greeting");
    await adapter.say(GREETING);
    await adapter.say(GREETING_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }

  const state = ensureState(prevState);
  setStep(state, "greeting");
  // Drop any stale completion sidecar.
  if (state.status === "complete") {
    state.status = "in_progress";
    state.completedAt = null;
    state.steps = [];
    state.guidedAnswers = {};
    setSidecar(state, {});
  }

  const trimmed = input.trim();
  if (trimmed === "1") {
    return startAutoDetect(adapter, state, session);
  }
  if (trimmed === "2") {
    return startGuidedFlow(adapter, state);
  }
  // Unrecognized — re-emit.
  await adapter.say(GREETING_INVALID);
  await adapter.say(GREETING_PROMPT);
  await writeState(adapter, state);
  return { status: "awaiting_input" };
}

async function startAutoDetect(
  adapter: CclAdapter,
  state: StateContext,
  session: SessionState,
): Promise<CclRunResult> {
  const detected = await detectProject(adapter.cwd);
  // Note: detected.existingCcl.hasClaudeDir is true whenever `.claude/` exists,
  // including when our state machine wrote it on a prior turn. Tighten the
  // check to a definitive scaffold artifact (CLAUDE.md or settings.json) so
  // the warning only fires for genuine pre-existing scaffolds.
  const hasRealScaffold =
    detected.existingCcl.hasClaudeMd ||
    (await pathExists(join(adapter.cwd, ".claude", "settings.json")));
  if (hasRealScaffold) {
    setStep(state, "rescaffold_warning");
    const sidecar = getSidecar(state);
    sidecar.flow = "auto";
    setSidecar(state, sidecar);
    await adapter.say(RESCAFFOLD_PROMPT);
    await adapter.say(renderExistingCclLines(detected));
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  return buildPlanAndPresent(adapter, state, session, detected, "auto", {});
}

async function startGuidedFlow(
  adapter: CclAdapter,
  state: StateContext,
): Promise<CclRunResult> {
  setStep(state, "guided_q1");
  const sidecar = getSidecar(state);
  sidecar.flow = "guided";
  setSidecar(state, sidecar);
  state.guidedAnswers = {};
  await adapter.say(Q1);
  await writeState(adapter, state);
  return { status: "awaiting_input" };
}

// ────────────────────────────────────────────────────────────────────────────
// Interrupted scaffold recovery
// ────────────────────────────────────────────────────────────────────────────

async function handleInterruptedChoice(
  adapter: CclAdapter,
  prevState: StateContext | null,
  session: SessionState,
  input: string,
): Promise<CclRunResult> {
  const state = ensureState(prevState);
  setStep(state, "interrupted_choice");

  if (input === "") {
    const remaining = state.remainingSteps?.join(", ") || "(none)";
    const last = state.lastCompletedStep ?? "(none)";
    await adapter.say(INTERRUPTED_PROMPT);
    await adapter.say(`  Last completed step: ${last}`);
    await adapter.say(`  Remaining: ${remaining}`);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }

  const t = input.trim();
  if (t === "1") {
    setStep(state, "interrupted_gitsync");
    await adapter.say(GITSYNC_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  if (t === "2") {
    // Restart — clear everything, start at greeting.
    return handleGreeting(adapter, null, session, "");
  }
  await adapter.say(INTERRUPTED_INVALID);
  await adapter.say(INTERRUPTED_PROMPT);
  await writeState(adapter, state);
  return { status: "awaiting_input" };
}

async function handleInterruptedGitsync(
  adapter: CclAdapter,
  prevState: StateContext | null,
  session: SessionState,
  input: string,
): Promise<CclRunResult> {
  const state = ensureState(prevState);
  setStep(state, "interrupted_gitsync");
  if (input === "") {
    await adapter.say(GITSYNC_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  const t = input.trim().toLowerCase();
  let gitSync: boolean;
  if (t === "yes" || t === "y" || t === "1") gitSync = true;
  else if (t === "no" || t === "n" || t === "2") gitSync = false;
  else {
    await adapter.say(GITSYNC_INVALID);
    await adapter.say(GITSYNC_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  state.gitSync = gitSync;
  session.gitSync = gitSync;
  setStep(state, "interrupted_permission");
  await adapter.say(PERMISSION_PROMPT);
  await writeState(adapter, state);
  return { status: "awaiting_input" };
}

async function handleInterruptedPermission(
  adapter: CclAdapter,
  prevState: StateContext | null,
  session: SessionState,
  input: string,
): Promise<CclRunResult> {
  const state = ensureState(prevState);
  setStep(state, "interrupted_permission");
  if (input === "") {
    await adapter.say(PERMISSION_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  const t = input.trim().toLowerCase();
  if (t === "no" || t === "n" || t === "2") {
    await adapter.say(PERMISSION_DECLINED);
    setStep(state, "complete");
    state.status = "complete";
    state.completedAt = new Date().toISOString();
    await writeState(adapter, state);
    return { status: "cancelled" };
  }
  if (t !== "yes" && t !== "y" && t !== "1") {
    await adapter.say(PERMISSION_INVALID);
    await adapter.say(PERMISSION_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  session.permissionGranted = true;

  // Resume the scaffold — rebuild plan, filter out done steps, execute.
  const detected = await detectProject(adapter.cwd);
  const plan = await buildScaffoldPlan({
    detected,
    gitSync: state.gitSync,
    ...(adapter.llmCall !== undefined ? { llmCall: adapter.llmCall } : {}),
    now: adapter.now ? adapter.now() : new Date(),
  });
  if (adapter.llmCall === undefined) {
    plan.skillGenerationMode = "skip";
  } else {
    plan.skillGenerationMode = "parallel";
  }
  applyGitSyncToPlan(plan, state.gitSync);

  const doneStepNames = new Set(
    state.steps.filter((s) => s.status === "done").map((s) => s.name),
  );
  plan.files = plan.files.filter((f) => !doneStepNames.has(f.stepName));

  if (plan.files.length === 0) {
    await adapter.say(RESUMING_ALREADY_DONE);
    setStep(state, "complete");
    state.status = "complete";
    state.completedAt = new Date().toISOString();
    await writeState(adapter, state);
    return { status: "resumed", writtenPaths: [] };
  }

  await adapter.say(
    `${RESUMING_PREFIX}${plan.files.length} step${plan.files.length === 1 ? "" : "s"} remaining.`,
  );

  const stats: SkillGenStats = { failedCount: 0 };
  const result = await doExecute(adapter, plan, stats);
  await adapter.say(renderCompletionSummary(plan, result));
  if (stats.failedCount > 0) {
    await adapter.say(SKILL_GENERATION_FAILED_NOTE(stats.failedCount));
  }
  // executeScaffoldPlan rewrites ccl-state.json with status=complete and no
  // conversation_step. Re-stamp conversation_step="complete" for clarity.
  const after = await readScaffoldState(adapter.cwd);
  if (after) {
    setStep(after, "complete");
    await writeState(adapter, after);
  }
  return { status: "resumed", writtenPaths: result.written };
}

// ────────────────────────────────────────────────────────────────────────────
// Re-scaffold warning (auto-detect path, .claude/ already exists)
// ────────────────────────────────────────────────────────────────────────────

async function handleRescaffoldWarning(
  adapter: CclAdapter,
  prevState: StateContext | null,
  session: SessionState,
  input: string,
): Promise<CclRunResult> {
  const state = ensureState(prevState);
  setStep(state, "rescaffold_warning");
  if (input === "") {
    await adapter.say(RESCAFFOLD_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  const t = input.trim();
  if (t === "1") {
    const detected = await detectProject(adapter.cwd);
    return buildPlanAndPresent(adapter, state, session, detected, "auto", {});
  }
  if (t === "2") {
    await adapter.say(EXIT_SKIPPED_MSG);
    setStep(state, "complete");
    state.status = "complete";
    state.completedAt = new Date().toISOString();
    await writeState(adapter, state);
    return { status: "skipped" };
  }
  await adapter.say(RESCAFFOLD_INVALID);
  await adapter.say(RESCAFFOLD_PROMPT);
  await writeState(adapter, state);
  return { status: "awaiting_input" };
}

// ────────────────────────────────────────────────────────────────────────────
// Refresh flow (§15)
// ────────────────────────────────────────────────────────────────────────────

async function handleRefreshPrompt(
  adapter: CclAdapter,
  prevState: StateContext | null,
  input: string,
): Promise<CclRunResult> {
  const state = ensureState(prevState);
  setStep(state, "refresh_prompt");
  if (input === "") {
    await adapter.say(REFRESH_HEADER);
    await adapter.say(REFRESH_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  const t = input.trim().toLowerCase();
  if (t === "later" || t === "2") {
    // Don't reset the 7-day clock — just transition to greeting.
    return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
  }
  if (t === "never" || t === "3") {
    const practices = await loadPractices(adapter.cwd);
    if (practices) {
      await savePractices(adapter.cwd, disableRefresh(practices));
    }
    return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
  }
  if (t === "refresh" || t === "accept" || t === "1") {
    return runRefreshFetch(adapter, state);
  }
  await adapter.say(REFRESH_INVALID);
  await adapter.say(REFRESH_PROMPT);
  await writeState(adapter, state);
  return { status: "awaiting_input" };
}

async function runRefreshFetch(
  adapter: CclAdapter,
  state: StateContext,
): Promise<CclRunResult> {
  if (!adapter.webSearch) {
    // No web search backend — silent success per §15 offline behaviour.
    return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
  }
  let raw: PracticeEntry[];
  try {
    raw = await adapter.webSearch("Claude Code best practices");
  } catch (err) {
    if (isOfflineError(err)) {
      return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
    }
    setStep(state, "refresh_failure");
    await adapter.say(REFRESH_FAIL_MSG);
    await adapter.say(REFRESH_FAIL_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }

  const now = adapter.now ? adapter.now() : new Date();
  const { valid, rejected, totalViolations } = validatePracticeCandidates(
    raw,
    now,
  );
  const summary = renderCandidateValidationSummary(rejected, totalViolations);
  if (summary !== null) await adapter.say(summary);
  const current = await loadPractices(adapter.cwd);
  if (!current) {
    return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
  }
  const diff = computePracticesDiff(current.practices, valid);
  await adapter.say(renderDiffSummary(diff));

  // Stash the validated candidates in the sidecar for the next turn.
  setStep(state, "refresh_accept");
  const sidecar = getSidecar(state);
  sidecar.refreshAcceptedSoFar = [];
  sidecar.refreshRejectedSoFar = [];
  sidecar.refreshReviewIndex = 0;
  setSidecar(state, sidecar);
  await adapter.say(REFRESH_ACCEPT_PROMPT);
  await writeState(adapter, state);
  return { status: "awaiting_input" };
}

async function handleRefreshFailure(
  adapter: CclAdapter,
  prevState: StateContext | null,
  input: string,
): Promise<CclRunResult> {
  const state = ensureState(prevState);
  setStep(state, "refresh_failure");
  if (input === "") {
    await adapter.say(REFRESH_FAIL_MSG);
    await adapter.say(REFRESH_FAIL_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  const t = input.trim().toLowerCase();
  if (t === "retry" || t === "1") {
    return runRefreshFetch(adapter, state);
  }
  if (t === "skip" || t === "2") {
    return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
  }
  await adapter.say(REFRESH_FAIL_INVALID);
  await adapter.say(REFRESH_FAIL_PROMPT);
  await writeState(adapter, state);
  return { status: "awaiting_input" };
}

async function handleRefreshAccept(
  adapter: CclAdapter,
  prevState: StateContext | null,
  input: string,
): Promise<CclRunResult> {
  const state = ensureState(prevState);
  setStep(state, "refresh_accept");
  if (input === "") {
    await adapter.say(REFRESH_ACCEPT_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  const t = input.trim().toLowerCase();
  const current = await loadPractices(adapter.cwd);
  if (!current) {
    return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
  }
  const now = adapter.now ? adapter.now() : new Date();

  if (t === "no" || t === "2") {
    // Discard all changes — applyRefresh with empty candidates.
    const result = applyRefresh(current, [], now);
    await savePractices(adapter.cwd, result.next);
    return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
  }

  if (t === "yes" || t === "y" || t === "1") {
    if (!adapter.webSearch) {
      return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
    }
    let candidates: PracticeEntry[];
    try {
      candidates = await adapter.webSearch("Claude Code best practices");
    } catch {
      return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
    }
    const { valid } = validatePracticeCandidates(candidates, now);
    const result = applyRefresh(current, valid, now);
    await savePractices(adapter.cwd, result.next);
    return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
  }

  if (t === "review" || t === "3") {
    return startRefreshReview(adapter, state);
  }

  await adapter.say(REFRESH_ACCEPT_INVALID);
  await adapter.say(REFRESH_ACCEPT_PROMPT);
  await writeState(adapter, state);
  return { status: "awaiting_input" };
}

async function startRefreshReview(
  adapter: CclAdapter,
  state: StateContext,
): Promise<CclRunResult> {
  const items = await getReviewItems(adapter);
  if (!items || items.length === 0) {
    // Nothing to review — proceed to greeting.
    return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
  }
  setStep(state, "refresh_review_each");
  const sidecar = getSidecar(state);
  sidecar.refreshReviewIndex = 0;
  sidecar.refreshAcceptedSoFar = [];
  sidecar.refreshRejectedSoFar = [];
  setSidecar(state, sidecar);
  await emitReviewItem(adapter, items, 0);
  await writeState(adapter, state);
  return { status: "awaiting_input" };
}

async function handleRefreshReviewEach(
  adapter: CclAdapter,
  prevState: StateContext | null,
  input: string,
): Promise<CclRunResult> {
  const state = ensureState(prevState);
  setStep(state, "refresh_review_each");
  const sidecar = getSidecar(state);
  const items = await getReviewItems(adapter);
  if (!items) {
    return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
  }
  const idx = sidecar.refreshReviewIndex ?? 0;

  if (input === "") {
    await emitReviewItem(adapter, items, idx);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  const t = input.trim().toLowerCase();
  let decision: "accept" | "reject" | null = null;
  if (t === "accept" || t === "yes" || t === "y" || t === "1") decision = "accept";
  else if (t === "reject" || t === "no" || t === "n" || t === "2") decision = "reject";
  if (!decision) {
    await adapter.say(REVIEW_PRACTICE_INVALID);
    await emitReviewItem(adapter, items, idx);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  const item = items[idx];
  if (item) {
    if (decision === "accept") {
      sidecar.refreshAcceptedSoFar = [
        ...(sidecar.refreshAcceptedSoFar ?? []),
        item.entry.id,
      ];
    } else {
      sidecar.refreshRejectedSoFar = [
        ...(sidecar.refreshRejectedSoFar ?? []),
        item.entry.id,
      ];
    }
  }
  const nextIdx = idx + 1;
  sidecar.refreshReviewIndex = nextIdx;
  setSidecar(state, sidecar);
  if (nextIdx < items.length) {
    await emitReviewItem(adapter, items, nextIdx);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  // Done reviewing — apply.
  const current = await loadPractices(adapter.cwd);
  if (!current) {
    return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
  }
  const accepted = new Set(sidecar.refreshAcceptedSoFar ?? []);
  const finalList = reconstructFinalPracticeList(current.practices, items, accepted);
  const now = adapter.now ? adapter.now() : new Date();
  const result = applyRefresh(current, finalList, now);
  await savePractices(adapter.cwd, result.next);
  return handleGreeting(adapter, null, { permissionGranted: false, gitSync: null }, "");
}

interface ReviewItem {
  kind: "added" | "removed" | "modified";
  entry: PracticeEntry;
}

async function getReviewItems(
  adapter: CclAdapter,
): Promise<ReviewItem[] | null> {
  if (!adapter.webSearch) return null;
  let raw: PracticeEntry[];
  try {
    raw = await adapter.webSearch("Claude Code best practices");
  } catch {
    return null;
  }
  const current = await loadPractices(adapter.cwd);
  if (!current) return null;
  const now = adapter.now ? adapter.now() : new Date();
  const { valid } = validatePracticeCandidates(raw, now);
  const diff = computePracticesDiff(current.practices, valid);
  return [
    ...diff.added.map((e): ReviewItem => ({ kind: "added", entry: e })),
    ...diff.modified.map(
      (m): ReviewItem => ({ kind: "modified", entry: m.after }),
    ),
    ...diff.removed.map((e): ReviewItem => ({ kind: "removed", entry: e })),
  ];
}

async function emitReviewItem(
  adapter: CclAdapter,
  items: ReviewItem[],
  idx: number,
): Promise<void> {
  const item = items[idx];
  if (!item) return;
  const prefix =
    item.kind === "added" ? "+" : item.kind === "removed" ? "-" : "~";
  await adapter.say(
    `Practice ${idx + 1} of ${items.length}:\n\n${prefix} ${item.entry.title}\n${item.entry.description}\nSource: ${item.entry.source}`,
  );
  await adapter.say(REVIEW_PRACTICE_PROMPT);
}

function reconstructFinalPracticeList(
  current: PracticeEntry[],
  items: ReviewItem[],
  accepted: Set<string>,
): PracticeEntry[] {
  const result: PracticeEntry[] = [];
  for (const cur of current) {
    const removalItem = items.find(
      (it) => it.kind === "removed" && it.entry.id === cur.id,
    );
    if (removalItem && accepted.has(cur.id)) continue;
    const modItem = items.find(
      (it) => it.kind === "modified" && it.entry.id === cur.id,
    );
    if (modItem && accepted.has(modItem.entry.id)) {
      result.push(modItem.entry);
      continue;
    }
    result.push(cur);
  }
  for (const it of items) {
    if (it.kind === "added" && accepted.has(it.entry.id)) result.push(it.entry);
  }
  return result;
}

function isOfflineError(err: unknown): boolean {
  if (err instanceof OfflineError) return true;
  if (err && typeof err === "object" && "offline" in err) {
    return (err as { offline?: unknown }).offline === true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Guided setup
// ────────────────────────────────────────────────────────────────────────────

async function handleGuidedQ(
  adapter: CclAdapter,
  prevState: StateContext | null,
  session: SessionState,
  input: string,
  qNum: 1 | 2 | 3 | 4 | 5,
): Promise<CclRunResult> {
  const state = ensureState(prevState);
  setStep(state, (`guided_q${qNum}` as ConversationStep));

  const QUESTIONS: Record<1 | 2 | 3 | 4 | 5, string> = {
    1: Q1,
    2: Q2,
    3: Q3,
    4: Q4,
    5: Q5,
  };

  // Spec: each guided_qN call stores the answer (incl. empty) and advances.
  // Empty answer for any question is valid — it just leaves the corresponding
  // override unset and detector defaults flow through.
  void QUESTIONS;

  // Store answer.
  const answers = { ...(state.guidedAnswers ?? {}) };
  answers[`q${qNum}`] = input;
  state.guidedAnswers = answers;

  if (qNum < 5) {
    const next = (qNum + 1) as 1 | 2 | 3 | 4 | 5;
    setStep(state, (`guided_q${next}` as ConversationStep));
    const QS: Record<1 | 2 | 3 | 4 | 5, string> = { 1: Q1, 2: Q2, 3: Q3, 4: Q4, 5: Q5 };
    await adapter.say(QS[next]);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }

  // qNum === 5: build plan from accumulated answers.
  const detected = await detectProject(adapter.cwd);
  const overrides = mapGuidedAnswersToOverrides({
    a1: answers["q1"] ?? "",
    a2: answers["q2"] ?? "",
    a3: answers["q3"] ?? "",
    a4: answers["q4"] ?? "",
    a5: answers["q5"] ?? "",
  });
  const { overrides: safe, violations } = validateScaffoldOverrides({
    codingRules: overrides.codingRules,
    gotchas: overrides.gotchas,
  });
  if (violations.length > 0) {
    await adapter.say(renderViolationWarning(violations));
  }
  if (safe.codingRules !== undefined) overrides.codingRules = safe.codingRules;
  if (safe.gotchas !== undefined) overrides.gotchas = safe.gotchas;

  return buildPlanAndPresent(adapter, state, session, detected, "guided", overrides);
}

// ────────────────────────────────────────────────────────────────────────────
// Plan build → skill mode prompt → review loop
// ────────────────────────────────────────────────────────────────────────────

async function buildPlanAndPresent(
  adapter: CclAdapter,
  state: StateContext,
  session: SessionState,
  detected: DetectedProject,
  flow: "auto" | "guided",
  overrides: ScaffoldOverrides,
): Promise<CclRunResult> {
  const plan = await buildScaffoldPlan({
    detected,
    gitSync: true,
    overrides,
    ...(adapter.llmCall !== undefined ? { llmCall: adapter.llmCall } : {}),
    now: adapter.now ? adapter.now() : new Date(),
  });
  if (adapter.llmCall === undefined) {
    plan.skillGenerationMode = "skip";
  }
  const sidecar = getSidecar(state);
  sidecar.flow = flow;
  sidecar.overrides = overrides;
  state.projectName = plan.projectName;
  state.projectType = plan.projectType;

  // Skill mode prompt — only when estimates exist (i.e. llmCall available).
  if (
    plan.skillEstimates &&
    plan.skillEstimates.classifications.length > 0
  ) {
    setStep(state, "skill_mode");
    setSidecar(state, sidecar);
    await adapter.say(renderEstimatesDisplay(plan.skillEstimates));
    await adapter.say(SKILL_MODE_PROMPT_SUFFIX);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }

  // No skill estimates — go straight to plan review.
  sidecar.skillGenerationMode = plan.skillGenerationMode ?? "skip";
  setSidecar(state, sidecar);
  return presentPlan(adapter, state, plan, flow);
}

async function handleSkillMode(
  adapter: CclAdapter,
  prevState: StateContext | null,
  session: SessionState,
  input: string,
): Promise<CclRunResult> {
  const state = ensureState(prevState);
  setStep(state, "skill_mode");
  const sidecar = getSidecar(state);

  if (input === "") {
    // Re-emit prompt — recompute estimates display from current detected state.
    const detected = await detectProject(adapter.cwd);
    const plan = await buildScaffoldPlan({
      detected,
      gitSync: true,
      overrides: sidecar.overrides ?? {},
      ...(adapter.llmCall !== undefined ? { llmCall: adapter.llmCall } : {}),
      now: adapter.now ? adapter.now() : new Date(),
    });
    if (plan.skillEstimates) {
      await adapter.say(renderEstimatesDisplay(plan.skillEstimates));
    }
    await adapter.say(SKILL_MODE_PROMPT_SUFFIX);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }

  const t = input.trim();
  const modeMap: Record<string, SkillGenerationMode> = {
    "1": "parallel",
    "2": "sequential",
    "3": "skip",
    parallel: "parallel",
    sequential: "sequential",
    skip: "skip",
  };
  const mode = modeMap[t.toLowerCase()];
  if (!mode) {
    await adapter.say(SKILL_MODE_INVALID);
    await adapter.say(SKILL_MODE_PROMPT_SUFFIX);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  sidecar.skillGenerationMode = mode;
  setSidecar(state, sidecar);

  // Rebuild plan with the chosen mode + present.
  const detected = await detectProject(adapter.cwd);
  const plan = await buildScaffoldPlan({
    detected,
    gitSync: true,
    overrides: sidecar.overrides ?? {},
    ...(adapter.llmCall !== undefined ? { llmCall: adapter.llmCall } : {}),
    now: adapter.now ? adapter.now() : new Date(),
  });
  plan.skillGenerationMode = mode;
  return presentPlan(adapter, state, plan, sidecar.flow ?? "auto");
}

async function presentPlan(
  adapter: CclAdapter,
  state: StateContext,
  plan: ScaffoldPlan,
  flow: "auto" | "guided",
): Promise<CclRunResult> {
  setStep(state, flow === "auto" ? "auto_detect_review" : "plan_review");
  const preview = renderPlanSummary(plan);
  const previewText =
    adapter.llmCall === undefined ? `${preview}${MSG_NO_LLM_FOOTER}` : preview;
  await adapter.say(previewText);
  await adapter.say(
    adapter.llmCall === undefined
      ? PLAN_REVIEW_PROMPT_NO_LLM
      : PLAN_REVIEW_PROMPT,
  );
  await writeState(adapter, state);
  return { status: "awaiting_input" };
}

async function handlePlanReview(
  adapter: CclAdapter,
  prevState: StateContext | null,
  session: SessionState,
  input: string,
): Promise<CclRunResult> {
  const state = ensureState(prevState);
  const sidecar = getSidecar(state);
  const flow = sidecar.flow ?? "auto";
  setStep(state, flow === "auto" ? "auto_detect_review" : "plan_review");

  if (input === "") {
    // Rebuild + re-emit current plan.
    const detected = await detectProject(adapter.cwd);
    const plan = await buildPlanFromSidecar(adapter, detected, sidecar);
    return presentPlan(adapter, state, plan, flow);
  }

  // Drill-down: filename match before approval/change handling.
  const detected = await detectProject(adapter.cwd);
  const plan = await buildPlanFromSidecar(adapter, detected, sidecar);
  const matched = matchPlanFileByName(plan, input);
  if (matched) {
    await adapter.say(renderPlanFileFullSection(matched));
    await adapter.say('Any changes, or type "ok" to proceed.');
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }

  if (isApproval(input)) {
    setStep(state, "permission_request");
    await adapter.say(PERMISSION_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }

  // Non-approval — try to interpret as a change request.
  if (adapter.llmCall === undefined) {
    await adapter.say(MSG_NO_LLM_CHANGE_REQUEST);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }

  let nextOverrides: ScaffoldOverrides;
  try {
    nextOverrides = await applyReviewChange(
      adapter,
      input,
      sidecar.overrides ?? {},
    );
  } catch (err) {
    const handled = await handleReviewLlmError(adapter, err);
    if (!handled) throw err;
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }

  sidecar.overrides = nextOverrides;
  setSidecar(state, sidecar);
  const newPlan = await buildPlanFromSidecar(adapter, detected, sidecar);
  return presentPlan(adapter, state, newPlan, flow);
}

const PLAN_FILE_SECTION_DIVIDER = "─".repeat(41);

function matchPlanFileByName(
  plan: ScaffoldPlan,
  input: string,
): PlannedFile | null {
  const needle = input.trim().toLowerCase();
  if (needle.length === 0) return null;
  for (const f of plan.files) {
    const last = f.path.toLowerCase().split("/").pop() ?? "";
    if (last === needle) return f;
  }
  for (const f of plan.files) {
    const last = f.path.toLowerCase().split("/").pop() ?? "";
    if (last.includes(needle)) return f;
  }
  for (const f of plan.files) {
    if (f.path.toLowerCase().includes(needle)) return f;
  }
  const firstWord = needle.split(/\s+/)[0] ?? "";
  if (firstWord.length >= 3) {
    for (const f of plan.files) {
      if (f.path.toLowerCase().includes(firstWord)) return f;
    }
  }
  return null;
}

function renderPlanFileFullSection(file: PlannedFile): string {
  const title =
    file.action === "gitignore-merge" ? `${file.path} additions` : file.path;
  return [
    PLAN_FILE_SECTION_DIVIDER,
    ` ${title}`,
    PLAN_FILE_SECTION_DIVIDER,
    file.content.trimEnd(),
    "",
  ].join("\n");
}

async function buildPlanFromSidecar(
  adapter: CclAdapter,
  detected: DetectedProject,
  sidecar: ConvSidecar,
): Promise<ScaffoldPlan> {
  const plan = await buildScaffoldPlan({
    detected,
    gitSync: true,
    overrides: sidecar.overrides ?? {},
    ...(adapter.llmCall !== undefined ? { llmCall: adapter.llmCall } : {}),
    now: adapter.now ? adapter.now() : new Date(),
  });
  if (sidecar.skillGenerationMode) {
    plan.skillGenerationMode = sidecar.skillGenerationMode;
  } else if (adapter.llmCall === undefined) {
    plan.skillGenerationMode = "skip";
  }
  return plan;
}

// ────────────────────────────────────────────────────────────────────────────
// Permission + git_sync + scaffold execution
// ────────────────────────────────────────────────────────────────────────────

async function handlePermission(
  adapter: CclAdapter,
  prevState: StateContext | null,
  session: SessionState,
  input: string,
): Promise<CclRunResult> {
  const state = ensureState(prevState);
  setStep(state, "permission_request");
  if (input === "") {
    await adapter.say(PERMISSION_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  const t = input.trim().toLowerCase();
  if (t === "no" || t === "n" || t === "2") {
    await adapter.say(PERMISSION_DECLINED);
    setStep(state, "complete");
    state.status = "complete";
    state.completedAt = new Date().toISOString();
    await writeState(adapter, state);
    return { status: "cancelled" };
  }
  if (t !== "yes" && t !== "y" && t !== "1") {
    await adapter.say(PERMISSION_INVALID);
    await adapter.say(PERMISSION_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  session.permissionGranted = true;
  // Persist the granted flag in guided_answers (a tiny abuse — but keeps
  // session state across turns without expanding the schema).
  state.guidedAnswers = {
    ...(state.guidedAnswers ?? {}),
    permissionGranted: "yes",
  };
  setStep(state, "git_sync");
  await adapter.say(GITSYNC_PROMPT);
  await writeState(adapter, state);
  return { status: "awaiting_input" };
}

async function handleGitSync(
  adapter: CclAdapter,
  prevState: StateContext | null,
  session: SessionState,
  input: string,
): Promise<CclRunResult> {
  const state = ensureState(prevState);
  setStep(state, "git_sync");
  if (input === "") {
    await adapter.say(GITSYNC_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  const t = input.trim().toLowerCase();
  let gitSync: boolean;
  if (t === "yes" || t === "y" || t === "1") gitSync = true;
  else if (t === "no" || t === "n" || t === "2") gitSync = false;
  else {
    await adapter.say(GITSYNC_INVALID);
    await adapter.say(GITSYNC_PROMPT);
    await writeState(adapter, state);
    return { status: "awaiting_input" };
  }
  session.gitSync = gitSync;
  state.gitSync = gitSync;

  // Execute scaffold.
  const sidecar = getSidecar(state);
  const detected = await detectProject(adapter.cwd);
  const plan = await buildPlanFromSidecar(adapter, detected, sidecar);
  applyGitSyncToPlan(plan, gitSync);

  const stats: SkillGenStats = { failedCount: 0 };
  const result = await doExecute(adapter, plan, stats);
  await adapter.say(renderCompletionSummary(plan, result));
  if (stats.failedCount > 0) {
    await adapter.say(SKILL_GENERATION_FAILED_NOTE(stats.failedCount));
  }
  // executeScaffoldPlan rewrote ccl-state.json — re-stamp conversation_step.
  const after = await readScaffoldState(adapter.cwd);
  if (after) {
    setStep(after, "complete");
    await writeState(adapter, after);
  }
  return { status: "complete", writtenPaths: result.written };
}

// ────────────────────────────────────────────────────────────────────────────
// LLM-driven plan-review change
// ────────────────────────────────────────────────────────────────────────────

async function applyReviewChange(
  adapter: CclAdapter,
  userInput: string,
  current: ScaffoldOverrides,
): Promise<ScaffoldOverrides> {
  if (adapter.llmCall === undefined) return current;
  const prompt = [
    `User said: ${userInput}`,
    `Current overrides JSON: ${JSON.stringify(current)}`,
    `Return the updated overrides JSON (same shape). Only modify fields the user asked to change.`,
  ].join("\n");
  let raw: string;
  try {
    raw = await adapter.llmCall(prompt, REVIEW_SYSTEM_PROMPT);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("CCL_ERR_")) throw err;
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

async function handleReviewLlmError(
  adapter: CclAdapter,
  err: unknown,
): Promise<boolean> {
  const msg = err instanceof Error ? err.message : "";
  if (
    msg.startsWith("CCL_ERR_KEY_INVALID") ||
    msg.startsWith("CCL_ERR_KEY_FORBIDDEN")
  ) {
    await adapter.say(
      msg.startsWith("CCL_ERR_KEY_INVALID")
        ? MSG_KEY_INVALID
        : MSG_KEY_FORBIDDEN,
    );
    return true;
  }
  if (msg.startsWith("CCL_ERR_RATE_LIMITED")) {
    await adapter.say(MSG_RATE_LIMITED);
    return true;
  }
  if (msg.startsWith("CCL_ERR_API_DOWN") || msg.startsWith("CCL_ERR_NETWORK")) {
    await adapter.say(MSG_API_ERROR);
    return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Execute + summary
// ────────────────────────────────────────────────────────────────────────────

interface SkillGenStats {
  failedCount: number;
}

async function doExecute(
  adapter: CclAdapter,
  plan: ScaffoldPlan,
  stats: SkillGenStats,
): Promise<ScaffoldExecutionResult> {
  const hasSkillGeneration =
    plan.skillGenerationMode === "parallel" ||
    plan.skillGenerationMode === "sequential";

  if (hasSkillGeneration && plan.skills.length > 0) {
    await adapter.say(GENERATING_SKILLS_HEADER);
  }

  const wrappedLlm: LlmCall | undefined =
    adapter.llmCall !== undefined && hasSkillGeneration
      ? wrapLlmCallForSkillGeneration(adapter.llmCall, stats)
      : adapter.llmCall;

  return executeScaffoldPlan(plan, {
    ...(wrappedLlm !== undefined ? { llmCall: wrappedLlm } : {}),
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

const SKILL_GEN_FALLBACK_BODY = [
  "## When to use",
  "Trigger this skill when the situation applies. _(static template — LLM generation unavailable)_",
  "",
  "## Steps",
  "_(add numbered steps)_",
].join("\n");

function wrapLlmCallForSkillGeneration(
  inner: LlmCall,
  stats: SkillGenStats,
): LlmCall {
  return async (prompt, systemPrompt) => {
    try {
      return await inner(prompt, systemPrompt);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("CCL_ERR_")) {
        stats.failedCount += 1;
        return SKILL_GEN_FALLBACK_BODY;
      }
      throw err;
    }
  };
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


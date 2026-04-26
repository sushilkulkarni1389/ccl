import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve as pathResolve, sep as pathSep } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import type { DetectedProject, ProjectType } from "./detector.js";
import { SHELL_TOKENS } from "./override-validator.js";
import {
  CCL_GITIGNORE_MARKER_END,
  CCL_GITIGNORE_MARKER_START,
  CCL_MODEL_ALIASES,
  defaultPracticesContext,
  defaultSettingsContext,
  initialStateContext,
  renderAgentMd,
  renderClaudeMd,
  renderClaudeignore,
  renderGitignoreAdditions,
  renderPracticesJson,
  renderSettingsJson,
  renderSettingsLocalJson,
  renderSkillMd,
  renderStateJson,
  validateAgentMd,
} from "./templates/index.js";
import type {
  AgentContext,
  ClaudeMdContext,
  DirectoryEntry,
  ProjectCommands,
  SkillContext,
  StateContext,
  StateStep,
} from "./templates/types.js";
import {
  assembleSkillMd,
  buildEstimates,
  classifySkills,
  generateAllSkills,
} from "./skill-engine.js";
import type {
  GeneratedSkill,
  LlmCall,
  ProjectContextSummary,
  SkillClassification,
  SkillEngineEstimates,
  SkillGenerationMode,
} from "./skill-engine.js";

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface ScaffoldPlan {
  rootDir: string;
  projectName: string;
  projectType: ProjectType;
  gitSync: boolean;
  files: PlannedFile[];
  skills: SkillContext[];
  agents: AgentContext[];
  now: string;
  skillEstimates?: SkillEngineEstimates;
  skillClassifications?: SkillClassification[];
  skillGenerationMode?: SkillGenerationMode;
}

export interface PlannedFile {
  path: string;
  stepName: string;
  action: "write" | "gitignore-merge";
  content: string;
}

export interface BuildPlanInput {
  detected: DetectedProject;
  overrides?: ScaffoldOverrides;
  gitSync: boolean;
  now?: Date;
  llmCall?: LlmCall;
}

export interface ScaffoldOverrides {
  projectName?: string;
  projectType?: ProjectType;
  whatIsThis?: string;
  stack?: string[];
  directories?: DirectoryEntry[];
  commands?: Partial<ProjectCommands>;
  codingRules?: string[];
  testingPhilosophy?: string;
  commonPitfalls?: string[];
  gotchas?: string[];
  neverDo?: string[];
  skills?: SkillContext[];
  agents?: AgentContext[];
}

export interface ExecuteOptions {
  now?: () => Date;
  initGit?: boolean;
  onStepStart?: (stepName: string) => void;
  onStepDone?: (stepName: string) => void;
  runGitCommand?: GitRunner;
  llmCall?: LlmCall;
  onSkillGenerationProgress?: (
    skillName: string,
    index: number,
    total: number,
  ) => void;
  conversationStep?: string;
  guidedAnswers?: Record<string, string>;
  planOverrides?: Record<string, unknown>;
}

export type GitRunner = (args: string[], cwd: string) => Promise<number>;

export interface ScaffoldExecutionResult {
  status: "complete";
  written: string[];
  startedAt: string;
  completedAt: string;
  gitInitialized: boolean;
}

export class ScaffoldError extends Error {
  constructor(
    message: string,
    public readonly stepName: string | null,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ScaffoldError";
  }
}

export class PathTraversalError extends Error {
  constructor(
    public readonly attemptedPath: string,
    public readonly root: string,
  ) {
    super(
      `Path traversal blocked: "${attemptedPath}" is outside root "${root}"`,
    );
    this.name = "PathTraversalError";
  }
}

function assertWithinRoot(root: string, filePath: string): void {
  const resolvedRoot = pathResolve(root);
  const resolvedFile = pathResolve(filePath);
  if (!resolvedFile.startsWith(resolvedRoot + pathSep)) {
    throw new PathTraversalError(filePath, root);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Default skills + agents per project type
// ────────────────────────────────────────────────────────────────────────────

export function defaultAgents(_type: ProjectType): AgentContext[] {
  return [
    {
      name: "security-auditor",
      description:
        "Scan for secrets, unsafe deps, dangerous shell usage, and common OWASP issues before a release.",
      model: CCL_MODEL_ALIASES.haiku,
      tools: ["Read", "Grep", "Glob"],
      purpose:
        "Audit the repo for common security issues that should block release. Runs read-only against source code and manifests.",
      outputFormat:
        'JSON: { "findings": [{ "severity": "high|medium|low", "file": string, "line": number, "issue": string }], "summary": string }',
      constraints: [
        "Read-only — no file writes",
        "Returns structured JSON only",
        "Scope: source files, manifest files, CI configs",
      ],
      role: "",
    },
    {
      name: "dependency-mapper",
      description:
        "Map first-party packages to their direct dependencies and surface unused or duplicated deps.",
      model: CCL_MODEL_ALIASES.haiku,
      tools: ["Read", "Grep", "Glob"],
      purpose:
        "Produce a dependency map for the repo. Use when planning a refactor that crosses package boundaries.",
      outputFormat:
        'JSON: { "packages": [{ "name": string, "dependencies": string[], "unused": string[] }] }',
      constraints: [
        "Read-only — no file writes",
        "Returns structured JSON only",
        "Scope: manifest files + source imports",
      ],
      role: "",
    },
  ];
}

// ────────────────────────────────────────────────────────────────────────────
// Stack-aware role generation for subagents (§12)
// ────────────────────────────────────────────────────────────────────────────

const GENERIC_ROLE =
  "You are a senior software engineer. You read code precisely and never speculate beyond what the source files show.";

const LANGUAGE_STACK_LABELS = new Set([
  "Node.js",
  "TypeScript",
  "JavaScript",
  "Python",
  "Rust",
  "Dart",
  "Flutter",
]);

export function buildAgentRole(
  agentName: string,
  detected: DetectedProject,
): string {
  const stack = formatStackPhrase(detected);
  if (stack === null) return GENERIC_ROLE;
  return `${roleFraming(agentName, stack)} ${rolePrecisionClause(agentName)}`;
}

function formatStackPhrase(detected: DetectedProject): string | null {
  const language = formatLanguageLabel(detected);
  if (language === null) return null;
  const frameworks = pickFrameworks(detected.stack, language);
  if (frameworks.length === 0) return language;
  if (frameworks.length === 1) return `${language} with ${frameworks[0]}`;
  return `${language} with ${frameworks[0]} and ${frameworks[1]}`;
}

function formatLanguageLabel(detected: DetectedProject): string | null {
  switch (detected.language) {
    case "typescript":
      return "TypeScript";
    case "javascript":
      return "JavaScript";
    case "python":
      return "Python";
    case "go": {
      const goEntry = detected.stack.find((s) => /^Go\b/.test(s));
      return goEntry ?? "Go";
    }
    case "rust":
      return "Rust";
    case "dart":
      return detected.stack.includes("Flutter") ? "Flutter" : "Dart";
    case "unknown":
      return null;
  }
}

function pickFrameworks(stack: string[], language: string): string[] {
  const out: string[] = [];
  for (const entry of stack) {
    if (entry === language) continue;
    if (LANGUAGE_STACK_LABELS.has(entry)) continue;
    if (/^Go\b/.test(entry)) continue;
    out.push(entry);
    if (out.length === 2) break;
  }
  return out;
}

function roleFraming(agentName: string, stack: string): string {
  const name = agentName.toLowerCase();
  if (name.includes("security")) {
    return `You audit ${stack} code for vulnerabilities, misconfigurations, and insecure patterns.`;
  }
  if (name.includes("dependency")) {
    return `You map dependencies, import graphs, and module relationships in ${stack} projects.`;
  }
  if (name.includes("doc")) {
    return `You read ${stack} source files and extract documentation-relevant information.`;
  }
  if (name.includes("onboard")) {
    return `You read ${stack} project structure to produce accurate onboarding summaries.`;
  }
  if (name.includes("performance") || name.includes("perf")) {
    return `You analyse ${stack} code for performance bottlenecks and inefficient patterns.`;
  }
  return `You read and analyse ${stack} code precisely.`;
}

function rolePrecisionClause(agentName: string): string {
  const name = agentName.toLowerCase();
  if (name.includes("security")) {
    return "You identify vulnerabilities precisely and never speculate beyond what the code shows.";
  }
  if (name.includes("dependency")) {
    return "You identify dependencies precisely and never speculate beyond what the code shows.";
  }
  if (name.includes("doc")) {
    return "You identify documented behaviour precisely and never speculate beyond what the code shows.";
  }
  if (name.includes("onboard")) {
    return "You identify project structure precisely and never speculate beyond what the code shows.";
  }
  if (name.includes("performance") || name.includes("perf")) {
    return "You identify bottlenecks precisely and never speculate beyond what the code shows.";
  }
  return "You identify findings precisely and never speculate beyond what the code shows.";
}

export function defaultSkills(type: ProjectType): SkillContext[] {
  const baseline: SkillContext[] = [
    {
      name: "onboard",
      description:
        "Trigger when the user says 'onboard me', 'catch me up', or starts a new session on this repo.",
      allowedTools: ["Read", "Bash"],
      steps: [
        "Read CLAUDE.md in full",
        "List the top-level directory to confirm layout",
        "Summarize project purpose, stack, and commands in 5 bullet points",
        "Ask the user what they want to work on",
      ],
      verification: [
        "User confirms the summary reflects what they're working on",
      ],
      references: ["./CLAUDE.md"],
    },
  ];
  const typeSpecific: Record<ProjectType, SkillContext[]> = {
    "web-app": [deploySkill()],
    "rest-api": [deploySkill(), migrateSkill()],
    cli: [releaseSkill()],
    library: [publishSkill()],
    monorepo: [runInWorkspaceSkill()],
    "mobile-app": [buildReleaseSkill()],
    "data-pipeline": [runPipelineSkill()],
    unknown: [],
  };
  return [...baseline, ...typeSpecific[type]];
}

function deploySkill(): SkillContext {
  return {
    name: "deploy",
    description: "Trigger a deploy when the user says 'deploy' or 'ship it'.",
    allowedTools: ["Read", "Bash"],
    steps: [
      "Confirm the target environment with the user",
      "Run the project's test command and wait for pass",
      "Invoke the deploy command from CLAUDE.md",
      "Report deploy status + link",
    ],
    verification: [
      "Deploy command exits 0",
      "Post-deploy health check passes",
    ],
    references: ["./CLAUDE.md"],
  };
}

function migrateSkill(): SkillContext {
  return {
    name: "run-migrations",
    description:
      "Trigger when the user says 'run migrations' or mentions schema changes.",
    allowedTools: ["Read", "Bash"],
    steps: [
      "List pending migrations",
      "Dry-run the migration and show the plan",
      "Get explicit user approval before applying",
      "Apply and report final schema version",
    ],
    verification: [
      "All migrations applied cleanly",
      "Schema version matches the latest migration",
    ],
    references: ["./migrations"],
  };
}

function releaseSkill(): SkillContext {
  return {
    name: "release",
    description: "Cut a new CLI release when the user says 'release' or 'cut version'.",
    allowedTools: ["Read", "Bash"],
    steps: [
      "Confirm target version (semver bump)",
      "Run full test suite",
      "Update CHANGELOG with unreleased entries",
      "Tag and push",
    ],
    verification: ["Tag visible on remote", "CI release workflow green"],
    references: ["./CHANGELOG.md"],
  };
}

function publishSkill(): SkillContext {
  return {
    name: "publish",
    description: "Publish the library when the user says 'publish' or 'release to npm'.",
    allowedTools: ["Read", "Bash"],
    steps: [
      "Verify clean working tree",
      "Run test + build",
      "Confirm version bump with user",
      "Run npm publish (or registry equivalent)",
    ],
    verification: [
      "Package visible on the target registry",
      "Install from a fresh dir succeeds",
    ],
    references: ["./package.json"],
  };
}

function runInWorkspaceSkill(): SkillContext {
  return {
    name: "run-in-workspace",
    description:
      "Run a command scoped to one monorepo package when the user says 'run X in <package>'.",
    allowedTools: ["Read", "Bash"],
    steps: [
      "Locate the workspace package by name",
      "Run the command with the appropriate workspace flag",
      "Stream output back to the user",
    ],
    verification: ["Command exits 0 in the target package"],
    references: ["./package.json"],
  };
}

function buildReleaseSkill(): SkillContext {
  return {
    name: "build-release",
    description: "Build a release artifact when the user says 'build release'.",
    allowedTools: ["Read", "Bash"],
    steps: [
      "Confirm target platform (ios | android)",
      "Run the build in release mode",
      "Report output location and size",
    ],
    verification: [
      "Build artifact produced at the expected path",
      "Artifact size within the app's budget",
    ],
    references: ["./CLAUDE.md"],
  };
}

function runPipelineSkill(): SkillContext {
  return {
    name: "run-pipeline",
    description: "Run the data pipeline when the user says 'run the pipeline'.",
    allowedTools: ["Read", "Bash"],
    steps: [
      "Confirm input dataset + date range",
      "Run the pipeline end-to-end",
      "Report row counts + any reconciliation issues",
    ],
    verification: [
      "Pipeline exits 0",
      "Output row counts within expected bounds",
    ],
    references: ["./CLAUDE.md"],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Plan builder
// ────────────────────────────────────────────────────────────────────────────

export async function buildScaffoldPlan(
  input: BuildPlanInput,
): Promise<ScaffoldPlan> {
  const { detected, overrides = {}, gitSync, now = new Date(), llmCall } = input;

  const projectName = overrides.projectName ?? detected.projectName;
  const projectType = overrides.projectType ?? detected.projectType;
  const stack = overrides.stack ?? detected.stack;
  const directories = overrides.directories ?? detected.directories;
  const commands: ProjectCommands = {
    ...detected.commands,
    ...overrides.commands,
  };
  const whatIsThis =
    overrides.whatIsThis ??
    detected.readmeSnippet ??
    `${projectName} — add a one-paragraph description for a senior engineer joining cold.`;

  const skills = overrides.skills ?? defaultSkills(projectType);
  const agents = (overrides.agents ?? defaultAgents(projectType)).map(
    (agent) => ({
      ...agent,
      role: agent.role || buildAgentRole(agent.name, detected),
    }),
  );

  const claudeCtx: ClaudeMdContext = {
    projectName,
    whatIsThis,
    stack,
    directories,
    commands,
    codingRules: overrides.codingRules ?? [],
    testingPhilosophy:
      overrides.testingPhilosophy ?? inferTestingPhilosophy(detected, commands),
    commonPitfalls: overrides.commonPitfalls ?? [],
    gotchas: overrides.gotchas ?? [],
    neverDo: overrides.neverDo ?? [],
  };

  const files: PlannedFile[] = [];

  files.push({
    path: "CLAUDE.md",
    stepName: "CLAUDE.md",
    action: "write",
    content: renderClaudeMd(claudeCtx),
  });

  files.push({
    path: ".claude/settings.json",
    stepName: "settings.json",
    action: "write",
    content: renderSettingsJson(defaultSettingsContext()),
  });

  files.push({
    path: ".claude/settings.local.json",
    stepName: "settings.local.json",
    action: "write",
    content: renderSettingsLocalJson(),
  });

  for (const skill of skills) {
    files.push({
      path: `.claude/skills/${skill.name}/SKILL.md`,
      stepName: `skills/${skill.name}`,
      action: "write",
      content: renderSkillMd(skill),
    });
  }

  for (const agent of agents) {
    files.push({
      path: `.claude/agents/${agent.name}.md`,
      stepName: `agents/${agent.name}`,
      action: "write",
      content: renderAgentMd(agent),
    });
  }

  files.push({
    path: ".claudeignore",
    stepName: ".claudeignore",
    action: "write",
    content: renderClaudeignore(),
  });

  files.push({
    path: ".gitignore",
    stepName: ".gitignore",
    action: "gitignore-merge",
    content: renderGitignoreAdditions({ syncStateToGit: gitSync }),
  });

  files.push({
    path: ".claude/ccl-practices.json",
    stepName: "ccl-practices.json",
    action: "write",
    content: renderPracticesJson(defaultPracticesContext(now)),
  });

  const plan: ScaffoldPlan = {
    rootDir: detected.rootDir,
    projectName,
    projectType,
    gitSync,
    files,
    skills,
    agents,
    now: now.toISOString(),
  };

  if (llmCall && skills.length > 0) {
    const projectContext = toProjectContextSummary(
      projectName,
      projectType,
      detected,
      commands,
    );
    const { classifications, classificationLatencyMs } = await classifySkills(
      skills.map((s) => s.name),
      projectContext,
      llmCall,
    );
    plan.skillClassifications = classifications;
    plan.skillEstimates = buildEstimates(classifications, classificationLatencyMs);
  }

  return plan;
}

function toProjectContextSummary(
  projectName: string,
  projectType: ProjectType,
  detected: DetectedProject,
  commands: ProjectCommands,
): ProjectContextSummary {
  return {
    projectName,
    projectType,
    language: detected.language,
    stack: detected.stack,
    commands: {
      dev: commands.dev,
      test: commands.test,
      build: commands.build,
      lint: commands.lint,
    },
  };
}

function inferTestingPhilosophy(
  detected: DetectedProject,
  commands: ProjectCommands,
): string {
  const stack = new Set(detected.stack);
  if (stack.has("Vitest")) {
    return `Unit tests in \`test/\` run on Vitest via \`${commands.test}\`.`;
  }
  if (stack.has("Jest")) {
    return `Unit tests run on Jest via \`${commands.test}\`.`;
  }
  if (stack.has("pytest")) {
    return `Python tests run via pytest: \`${commands.test}\`.`;
  }
  if (detected.language === "go") {
    return `Standard library testing — \`${commands.test}\`.`;
  }
  if (detected.language === "rust") {
    return `Unit + integration tests colocated with code — \`${commands.test}\`.`;
  }
  if (detected.language === "dart") {
    return `Widget + unit tests — \`${commands.test}\`.`;
  }
  return `Run tests with \`${commands.test}\`.`;
}

// ────────────────────────────────────────────────────────────────────────────
// Plan preview (§7)
// ────────────────────────────────────────────────────────────────────────────

const DIVIDER = "─".repeat(41);

export function renderPlanPreview(plan: ScaffoldPlan): string {
  const header = `Here's what I'll create for ${plan.projectName}:`;
  const sections = plan.files.map((f) => renderPreviewSection(f));
  const footer = `Does this look right? Request any changes or say "looks good" to proceed.`;
  return [header, "", ...sections, DIVIDER, "", footer, ""].join("\n");
}

function renderPreviewSection(file: PlannedFile): string {
  const title =
    file.action === "gitignore-merge"
      ? `${file.path} additions`
      : file.path;
  const lines = [DIVIDER, ` ${title}`, DIVIDER, file.content.trimEnd()];
  const warning = skillStepsWarning(file);
  if (warning !== null) lines.push(warning);
  lines.push("");
  return lines.join("\n");
}

const SKILL_PREVIEW_SHELL_RE = new RegExp(
  `\\b(${SHELL_TOKENS.join("|")})\\b`,
  "i",
);
const SKILL_PREVIEW_URL_RE = /\bhttps?:\/\//i;
const SKILL_STEPS_WARNING =
  "⚠  Review: this skill contains commands — verify before approving.";

function skillStepsWarning(file: PlannedFile): string | null {
  if (!file.path.startsWith(".claude/skills/")) return null;
  const steps = extractSkillStepsBlock(file.content);
  if (steps === null) return null;
  if (SKILL_PREVIEW_SHELL_RE.test(steps) || SKILL_PREVIEW_URL_RE.test(steps)) {
    return SKILL_STEPS_WARNING;
  }
  return null;
}

function extractSkillStepsBlock(content: string): string | null {
  const startMatch = content.match(/^## Steps\s*\n/m);
  if (!startMatch || startMatch.index === undefined) return null;
  const afterHeading = startMatch.index + startMatch[0].length;
  const rest = content.slice(afterHeading);
  const nextHeading = rest.search(/^## /m);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

// ────────────────────────────────────────────────────────────────────────────
// Executor + state manager
// ────────────────────────────────────────────────────────────────────────────

export async function executeScaffoldPlan(
  plan: ScaffoldPlan,
  opts: ExecuteOptions = {},
): Promise<ScaffoldExecutionResult> {
  const nowFn = opts.now ?? (() => new Date());
  const runGit = opts.runGitCommand ?? spawnGit;
  const initGit = opts.initGit ?? true;

  const statePath = join(plan.rootDir, ".claude", "ccl-state.json");
  const startedAt = nowFn().toISOString();

  const state: StateContext = {
    ...initialStateContext({
      projectName: plan.projectName,
      projectType: plan.projectType,
      steps: plan.files.map((f) => f.stepName),
      gitSync: plan.gitSync,
      now: new Date(startedAt),
    }),
    ...(opts.conversationStep !== undefined
      ? { conversationStep: opts.conversationStep }
      : { conversationStep: "scaffolding" }),
    ...(opts.guidedAnswers !== undefined
      ? { guidedAnswers: opts.guidedAnswers }
      : {}),
    ...(opts.planOverrides !== undefined
      ? { planOverrides: opts.planOverrides }
      : {}),
  };

  await mkdir(join(plan.rootDir, ".claude"), { recursive: true });
  await writeFile(statePath, renderStateJson(state), "utf8");

  await maybeInjectGeneratedSkills(plan, opts);

  let gitInitialized = false;
  if (initGit && !(await pathExists(join(plan.rootDir, ".git")))) {
    try {
      const code = await runGit(["init", "--quiet"], plan.rootDir);
      gitInitialized = code === 0;
    } catch {
      // Non-fatal — user may not have git installed; .gitignore still written.
      gitInitialized = false;
    }
  }

  const written: string[] = [];

  for (const file of plan.files) {
    if (file.stepName.startsWith("agents/")) {
      const result = validateAgentMd(file.content);
      if (!result.valid) {
        const skipMessage = `${file.stepName} — SKIPPED (security: ${result.violations.join("; ")})`;
        opts.onStepStart?.(skipMessage);
        markStepSkipped(state, file.stepName);
        await writeFile(statePath, renderStateJson(state), "utf8");
        continue;
      }
    }

    const resolvedFilePath = pathResolve(plan.rootDir, file.path);
    try {
      assertWithinRoot(plan.rootDir, resolvedFilePath);
    } catch (cause) {
      if (cause instanceof PathTraversalError) {
        const skipMessage = `${file.stepName} — SKIPPED (security: path traversal blocked)`;
        opts.onStepStart?.(skipMessage);
        console.error(cause.message);
        markStepSkipped(state, file.stepName);
        await writeFile(statePath, renderStateJson(state), "utf8");
        continue;
      }
      throw cause;
    }

    opts.onStepStart?.(file.stepName);
    try {
      await writePlannedFile(plan.rootDir, file);
    } catch (cause) {
      if (cause instanceof PathTraversalError) {
        const skipMessage = `${file.stepName} — SKIPPED (security: path traversal blocked)`;
        opts.onStepStart?.(skipMessage);
        console.error(cause.message);
        markStepSkipped(state, file.stepName);
        await writeFile(statePath, renderStateJson(state), "utf8");
        continue;
      }
      markStepFailed(state, file.stepName);
      state.status = "failed";
      await writeFile(statePath, renderStateJson(state), "utf8");
      throw new ScaffoldError(
        `Failed to write ${file.path}`,
        file.stepName,
        cause,
      );
    }
    written.push(file.path);
    markStepDone(state, file.stepName);
    await writeFile(statePath, renderStateJson(state), "utf8");
    opts.onStepDone?.(file.stepName);
  }

  const completedAt = nowFn().toISOString();
  state.status = "complete";
  state.completedAt = completedAt;
  state.conversationStep = "complete";
  delete state.lastCompletedStep;
  delete state.remainingSteps;
  await writeFile(statePath, renderStateJson(state), "utf8");

  return {
    status: "complete",
    written,
    startedAt: state.startedAt,
    completedAt,
    gitInitialized,
  };
}

async function maybeInjectGeneratedSkills(
  plan: ScaffoldPlan,
  opts: ExecuteOptions,
): Promise<void> {
  const mode = plan.skillGenerationMode;
  if (mode !== "parallel" && mode !== "sequential") return;
  if (!opts.llmCall) return;
  const classifications = plan.skillClassifications ?? [];
  if (classifications.length === 0) return;

  const projectContext: ProjectContextSummary = {
    projectName: plan.projectName,
    projectType: plan.projectType,
    language: "",
    stack: [],
  };

  const generated = await generateAllSkills(
    classifications,
    projectContext,
    mode,
    opts.llmCall,
    opts.onSkillGenerationProgress,
  );

  const byName = new Map<string, GeneratedSkill>(
    generated.map((g) => [g.skillName, g]),
  );
  const skillsByName = new Map(plan.skills.map((s) => [s.name, s]));
  const classificationsByName = new Map(
    classifications.map((c) => [c.skillName, c]),
  );

  for (const file of plan.files) {
    if (!file.path.startsWith(".claude/skills/")) continue;
    const skill = skillsByName.get(fileNameToSkillName(file.path));
    if (!skill) continue;
    const gen = byName.get(skill.name);
    if (!gen) continue;
    const cls = classificationsByName.get(skill.name) ?? null;
    file.content = assembleSkillMd(
      skill.name,
      cls,
      gen.content,
      skill.allowedTools,
    );
  }
}

function fileNameToSkillName(filePath: string): string {
  const match = filePath.match(/^\.claude\/skills\/([^/]+)\/SKILL\.md$/);
  return match?.[1] ?? "";
}

async function writePlannedFile(rootDir: string, file: PlannedFile): Promise<void> {
  const fullPath = pathResolve(rootDir, file.path);
  assertWithinRoot(rootDir, fullPath);
  await mkdir(dirname(fullPath), { recursive: true });
  if (file.action === "write") {
    assertWithinRoot(rootDir, fullPath);
    await atomicWrite(fullPath, file.content);
    return;
  }
  if (file.action === "gitignore-merge") {
    const existing = (await readFileOrNull(fullPath)) ?? "";
    const merged = mergeCclGitignoreBlock(existing, file.content);
    assertWithinRoot(rootDir, fullPath);
    await atomicWrite(fullPath, merged);
    return;
  }
}

export const FILE_MODE_PRIVATE = 0o600;

async function atomicWrite(
  path: string,
  content: string,
  mode?: number,
): Promise<void> {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.ccl-tmp`;
  const opts = mode === undefined
    ? { encoding: "utf8" as const }
    : { encoding: "utf8" as const, mode };
  await writeFile(tmp, content, opts);
  await rename(tmp, path);
}

function markStepDone(state: StateContext, stepName: string): void {
  const step = findStep(state, stepName);
  if (step) step.status = "done";
  state.lastCompletedStep = stepName;
  state.remainingSteps = (state.remainingSteps ?? []).filter((n) => n !== stepName);
}

function markStepFailed(state: StateContext, stepName: string): void {
  const step = findStep(state, stepName);
  if (step) step.status = "failed";
}

function markStepSkipped(state: StateContext, stepName: string): void {
  const step = findStep(state, stepName);
  if (step) step.status = "skipped";
  state.remainingSteps = (state.remainingSteps ?? []).filter(
    (n) => n !== stepName,
  );
}

function findStep(state: StateContext, name: string): StateStep | undefined {
  return state.steps.find((s) => s.name === name);
}

// ────────────────────────────────────────────────────────────────────────────
// Gitignore merge
// ────────────────────────────────────────────────────────────────────────────

export function mergeCclGitignoreBlock(
  existing: string,
  managedBlock: string,
): string {
  const stripped = stripCclManagedBlock(existing);
  const base = stripped.length === 0 || stripped.endsWith("\n") ? stripped : stripped + "\n";
  const spacer = base.length > 0 && !base.endsWith("\n\n") ? "\n" : "";
  return base + spacer + managedBlock;
}

function stripCclManagedBlock(content: string): string {
  const startIdx = content.indexOf(CCL_GITIGNORE_MARKER_START);
  const endIdx = content.indexOf(CCL_GITIGNORE_MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return content;
  const before = content.slice(0, startIdx).replace(/\n+$/, "");
  const after = content
    .slice(endIdx + CCL_GITIGNORE_MARKER_END.length)
    .replace(/^\n+/, "");
  if (before.length === 0) return after;
  if (after.length === 0) return before + "\n";
  return before + "\n" + after;
}

// ────────────────────────────────────────────────────────────────────────────
// State recovery (§8.2)
// ────────────────────────────────────────────────────────────────────────────

export interface InterruptedScaffold {
  state: StateContext;
  lastCompletedStep: string | null;
  remainingSteps: string[];
}

export async function readScaffoldState(
  rootDir: string,
): Promise<StateContext | null> {
  const raw = await readFileOrNull(join(rootDir, ".claude", "ccl-state.json"));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeState(parsed);
  } catch {
    return null;
  }
}

export async function detectInterruptedScaffold(
  rootDir: string,
): Promise<InterruptedScaffold | null> {
  const state = await readScaffoldState(rootDir);
  if (state === null) return null;
  if (state.status === "complete") return null;
  return {
    state,
    lastCompletedStep: state.lastCompletedStep ?? null,
    remainingSteps: state.remainingSteps ?? [],
  };
}

function normalizeState(parsed: Record<string, unknown>): StateContext | null {
  const status = parsed["status"];
  if (
    status !== "complete" &&
    status !== "in_progress" &&
    status !== "failed"
  ) {
    return null;
  }
  const steps = Array.isArray(parsed["steps"])
    ? (parsed["steps"] as unknown[]).flatMap((s) => {
        if (
          typeof s === "object" &&
          s !== null &&
          typeof (s as { name?: unknown }).name === "string"
        ) {
          const stepStatus = (s as { status?: unknown }).status;
          return [
            {
              name: (s as { name: string }).name,
              status:
                stepStatus === "done" ||
                stepStatus === "failed" ||
                stepStatus === "skipped"
                  ? stepStatus
                  : ("pending" as const),
            } as StateStep,
          ];
        }
        return [];
      })
    : [];
  return {
    status,
    scaffoldVersion: asString(parsed["scaffold_version"]) ?? "1.0",
    startedAt: asString(parsed["started_at"]) ?? "",
    completedAt: asString(parsed["completed_at"]) ?? null,
    projectName: asString(parsed["project_name"]) ?? "",
    projectType: asString(parsed["project_type"]) ?? "",
    steps,
    gitSync: parsed["git_sync"] === true,
    ...(asString(parsed["last_completed_step"]) !== undefined
      ? { lastCompletedStep: asString(parsed["last_completed_step"])! }
      : {}),
    ...(Array.isArray(parsed["remaining_steps"])
      ? {
          remainingSteps: (parsed["remaining_steps"] as unknown[]).filter(
            (v): v is string => typeof v === "string",
          ),
        }
      : {}),
    ...(asString(parsed["conversation_step"]) !== undefined
      ? { conversationStep: asString(parsed["conversation_step"])! }
      : {}),
    ...(isPlainObject(parsed["guided_answers"])
      ? { guidedAnswers: asStringRecord(parsed["guided_answers"]) }
      : {}),
    ...(isPlainObject(parsed["plan_overrides"])
      ? { planOverrides: parsed["plan_overrides"] as Record<string, unknown> }
      : {}),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isPlainObject(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// File IO + git helpers
// ────────────────────────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readFileOrNull(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

function spawnGit(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

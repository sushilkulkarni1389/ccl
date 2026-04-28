import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve as pathResolve, sep as pathSep } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import type { DetectedProject, ProjectType } from "./detector.js";
import { DOC_STACK_KEYWORDS } from "./detector.js";
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

export function defaultAgents(type: ProjectType): AgentContext[] {
  const baseline: AgentContext[] = [
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
  const typeSpecific: Partial<Record<ProjectType, AgentContext[]>> = {
    "rest-api": [
      {
        name: "api-contract-checker",
        description:
          "Audit REST routes for consistent HTTP methods, status codes, request/response schemas, and error handling before a PR.",
        model: CCL_MODEL_ALIASES.haiku,
        tools: ["Read", "Grep", "Glob"],
        purpose:
          "Scan route definitions and handler implementations for API contract issues. Use before opening a PR that touches routes, controllers, or schemas.",
        outputFormat:
          'JSON: { "findings": [{ "route": string, "method": string, "issue": string, "severity": "high|medium|low" }], "summary": string }',
        constraints: [
          "Read-only — no file writes",
          "Returns structured JSON only",
          "Scope: route files, controller files, schema definitions",
        ],
        role: "",
      },
    ],
  };
  return [...baseline, ...(typeSpecific[type] ?? [])];
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
// Static doc extraction (no key) + LLM enrichment from docs (key present)
// ────────────────────────────────────────────────────────────────────────────

interface DocExtracted {
  whatIsThis?: string;
  stack?: string[];
  commands?: Partial<ProjectCommands>;
  directories?: DirectoryEntry[];
}

interface LlmEnrichment {
  whatIsThis?: string;
  stack?: string[];
  devCommand?: string;
  testCommand?: string;
  buildCommand?: string;
  lintCommand?: string;
  whereThingsLive?: DirectoryEntry[];
  codingRules?: string[];
  testingPhilosophy?: string;
  commonPitfalls?: string[];
  gotchas?: string[];
  neverDo?: string[];
}

function firstParagraphFromText(text: string): string | null {
  const lines = text.split("\n");
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") {
      if (current.length) { paragraphs.push(current.join(" ").trim()); current = []; }
      continue;
    }
    if (line.startsWith("#") || line.startsWith("!") || /^\[!\[/.test(line)) continue;
    current.push(line);
  }
  if (current.length) paragraphs.push(current.join(" ").trim());
  return paragraphs.find((p) => p.length > 20) ?? null;
}

function truncateToSentences(text: string, max: number): string {
  const sentences = text.match(/[^.!?]*[.!?]+/g) ?? [];
  if (sentences.length === 0) return text;
  return sentences.slice(0, max).join("").trim();
}

function extractStackFromText(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  const seen = new Set<string>();
  for (const { keyword, label } of DOC_STACK_KEYWORDS) {
    if (seen.has(label)) continue;
    if (lower.includes(keyword.toLowerCase())) {
      found.push(label);
      seen.add(label);
    }
  }
  return found;
}

const COMMAND_EXTRACTION_PATTERNS: Array<{
  type: keyof ProjectCommands;
  patterns: RegExp[];
}> = [
  {
    type: "dev",
    patterns: [
      /\b(npm run dev|npm start|yarn dev|pnpm dev|yarn start|pnpm start)\b/i,
      /\b(go run \.(?:\/\.\.\.)?)\b/i,
      /\b(cargo run)\b/i,
      /\b(python -m \w[\w.]*)\b/i,
      /\b(flutter run)\b/i,
      /\b(dart run)\b/i,
    ],
  },
  {
    type: "test",
    patterns: [
      /\b(npm test|npm run test|yarn test|pnpm test|pnpm run test)\b/i,
      /\b(go test \.\/\.\.\.)\b/i,
      /\b(cargo test)\b/i,
      /\b(pytest(?:\s+\S+)?)\b/i,
      /\b(flutter test)\b/i,
      /\b(dart test)\b/i,
    ],
  },
  {
    type: "build",
    patterns: [
      /\b(npm run build|yarn build|pnpm build|pnpm run build)\b/i,
      /\b(go build \.\/\.\.\.)\b/i,
      /\b(cargo build --release)\b/i,
      /\b(python -m build)\b/i,
      /\b(flutter build \w+)\b/i,
      /\b(mvn (?:package|install))\b/i,
      /\b(\.\/gradlew \w+)\b/i,
    ],
  },
  {
    type: "lint",
    patterns: [
      /\b(npm run lint|yarn lint|pnpm lint|pnpm run lint)\b/i,
      /\b(go vet \.\/\.\.\.)\b/i,
      /\b(cargo clippy)\b/i,
      /\b(ruff check \.)\b/i,
      /\b(flutter analyze)\b/i,
      /\b(dart analyze)\b/i,
      /\b(make lint)\b/i,
    ],
  },
];

function extractCommandsFromText(text: string): Partial<ProjectCommands> {
  // Prefer commands found inside fenced code blocks
  const codeBlocks: string[] = [];
  const blockRe = /```(?:sh|bash|shell|zsh|console)?\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    if (m[1]) codeBlocks.push(m[1]);
  }
  const searchText = codeBlocks.length > 0 ? codeBlocks.join("\n") : text;
  const result: Partial<ProjectCommands> = {};
  for (const { type, patterns } of COMMAND_EXTRACTION_PATTERNS) {
    for (const pat of patterns) {
      const hit = pat.exec(searchText);
      if (hit?.[1]) { result[type] = hit[1].trim(); break; }
    }
  }
  return result;
}

function extractDirectoriesFromText(text: string): DirectoryEntry[] {
  const entries: DirectoryEntry[] = [];
  const seen = new Set<string>();
  // Match "name/ — description" (em-dash or hyphen)
  const descRe = /^\s*[`*-]?\s*([a-z][a-z0-9_-]*\/)\s*[—–-]{1,3}\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = descRe.exec(text)) !== null && entries.length < 8) {
    const dir = m[1]!.trim();
    const desc = m[2]!.trim();
    if (!seen.has(dir) && desc.length > 0) { entries.push({ dir, description: desc }); seen.add(dir); }
  }
  // Supplement from tree output when fewer than 4 entries found
  if (entries.length < 4) {
    const treeRe = /[├└]──\s+([a-z][a-z0-9_-]*)\//gim;
    while ((m = treeRe.exec(text)) !== null && entries.length < 8) {
      const dir = `${m[1]!}/`;
      if (!seen.has(dir)) { entries.push({ dir, description: m[1]! }); seen.add(dir); }
    }
  }
  return entries;
}

function extractFromDocs(detected: DetectedProject): DocExtracted {
  if (detected.extraDocs.length === 0) return {};
  const allContent = detected.extraDocs.map((d) => d.content).join("\n\n");
  const result: DocExtracted = {};

  if (detected.readmeSnippet === null) {
    const firstDoc = detected.extraDocs[0];
    if (firstDoc) {
      const para = firstParagraphFromText(firstDoc.content);
      if (para !== null) result.whatIsThis = truncateToSentences(para, 3);
    }
  }

  const docStack = extractStackFromText(allContent);
  if (docStack.length > 0) result.stack = docStack;

  const docCmds = extractCommandsFromText(allContent);
  if (Object.keys(docCmds).length > 0) result.commands = docCmds;

  const docDirs = extractDirectoriesFromText(allContent);
  if (docDirs.length > 0) result.directories = docDirs;

  return result;
}

function parseLlmEnrichment(raw: string): LlmEnrichment {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const result: LlmEnrichment = {};
    if (typeof parsed["whatIsThis"] === "string") result.whatIsThis = parsed["whatIsThis"];
    const strArr = (k: string): string[] | undefined => {
      const v = parsed[k];
      return Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : undefined;
    };
    const stack = strArr("stack");
    if (stack !== undefined) result.stack = stack;
    if (typeof parsed["devCommand"] === "string") result.devCommand = parsed["devCommand"];
    if (typeof parsed["testCommand"] === "string") result.testCommand = parsed["testCommand"];
    if (typeof parsed["buildCommand"] === "string") result.buildCommand = parsed["buildCommand"];
    if (typeof parsed["lintCommand"] === "string") result.lintCommand = parsed["lintCommand"];
    if (Array.isArray(parsed["whereThingsLive"])) {
      const dirs: DirectoryEntry[] = [];
      for (const item of parsed["whereThingsLive"] as unknown[]) {
        const it = item as Record<string, unknown>;
        if (typeof it["dir"] === "string" && typeof it["description"] === "string") {
          dirs.push({ dir: it["dir"] as string, description: it["description"] as string });
        }
      }
      if (dirs.length > 0) result.whereThingsLive = dirs;
    }
    const codingRules = strArr("codingRules");
    if (codingRules !== undefined) result.codingRules = codingRules;
    if (typeof parsed["testingPhilosophy"] === "string") result.testingPhilosophy = parsed["testingPhilosophy"];
    const commonPitfalls = strArr("commonPitfalls");
    if (commonPitfalls !== undefined) result.commonPitfalls = commonPitfalls;
    const gotchas = strArr("gotchas");
    if (gotchas !== undefined) result.gotchas = gotchas;
    const neverDo = strArr("neverDo");
    if (neverDo !== undefined) result.neverDo = neverDo;
    return result;
  } catch {
    return {};
  }
}

async function enrichFromDocs(
  detected: DetectedProject,
  projectName: string,
  currentStack: string[],
  currentCommands: ProjectCommands,
  llmCall: LlmCall,
): Promise<LlmEnrichment> {
  const docsText = detected.extraDocs
    .map((d) => `### ${d.filename}\n\n${d.content}`)
    .join("\n\n---\n\n");

  const alreadyKnown = [
    currentStack.length > 0 ? `Stack already detected from manifests: ${currentStack.join(", ")}` : null,
    !currentCommands.dev.startsWith("# TODO:") ? `Dev command: ${currentCommands.dev}` : null,
    !currentCommands.test.startsWith("# TODO:") ? `Test command: ${currentCommands.test}` : null,
    !currentCommands.build.startsWith("# TODO:") ? `Build command: ${currentCommands.build}` : null,
    !currentCommands.lint.startsWith("# TODO:") ? `Lint command: ${currentCommands.lint}` : null,
  ].filter(Boolean).join("\n");

  const prompt = [
    `Project: ${projectName}`,
    alreadyKnown.length > 0 ? `\nAlready detected from manifests:\n${alreadyKnown}` : "",
    "",
    "Documentation:",
    docsText,
    "",
    "From the documentation above, populate ONLY fields you can fill with HIGH CONFIDENCE.",
    "Omit any field you cannot fill confidently — do not guess or pad.",
    "Return a single JSON object with these optional keys:",
    '  "whatIsThis": string — 1-3 sentence description for a senior engineer joining cold',
    '  "stack": string[] — technology names not already detected (e.g. ["Docker", "PostgreSQL"])',
    '  "devCommand": string — exact shell command to start the dev server',
    '  "testCommand": string — exact shell command to run tests',
    '  "buildCommand": string — exact shell command to build',
    '  "lintCommand": string — exact shell command to lint',
    '  "whereThingsLive": [{"dir":"path/","description":"what it contains"}, ...] — up to 8 entries',
    '  "codingRules": string[] — 3–8 concrete coding rules for this codebase',
    '  "testingPhilosophy": string — 1 sentence describing the test strategy',
    '  "commonPitfalls": string[] — 2–5 mistakes a new engineer hits quickly',
    '  "gotchas": string[] — 2–5 non-obvious behaviours or constraints',
    '  "neverDo": string[] — 2–5 patterns that are forbidden in this codebase',
    "",
    "JSON only — no prose, no markdown fences.",
  ].filter((l) => l !== "").join("\n");

  try {
    const raw = await llmCall(prompt);
    return parseLlmEnrichment(raw);
  } catch {
    return {};
  }
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

  // Static extraction from freeform docs (runs when no API key)
  const docExtracted: DocExtracted =
    !llmCall && detected.extraDocs.length > 0 ? extractFromDocs(detected) : {};

  // Stack: merge manifest + doc findings; manifest order preserved
  const manifestStack = detected.stack;
  const docStack = docExtracted.stack ?? [];
  const manifestSet = new Set(manifestStack);
  const mergedStack = [...manifestStack, ...docStack.filter((s) => !manifestSet.has(s))];
  const stack = overrides.stack ?? mergedStack;

  // Directories: manifest > doc > empty
  const directories =
    overrides.directories ??
    (detected.directories.length > 0
      ? detected.directories
      : (docExtracted.directories ?? detected.directories));

  // Commands: fill # TODO: placeholders from doc extraction
  const baseCommands: ProjectCommands = { ...detected.commands, ...overrides.commands };
  const docCmds = docExtracted.commands ?? {};
  const commands: ProjectCommands = {
    dev: baseCommands.dev.startsWith("# TODO:") ? (docCmds.dev ?? baseCommands.dev) : baseCommands.dev,
    test: baseCommands.test.startsWith("# TODO:") ? (docCmds.test ?? baseCommands.test) : baseCommands.test,
    build: baseCommands.build.startsWith("# TODO:") ? (docCmds.build ?? baseCommands.build) : baseCommands.build,
    lint: baseCommands.lint.startsWith("# TODO:") ? (docCmds.lint ?? baseCommands.lint) : baseCommands.lint,
  };

  const whatIsThis =
    overrides.whatIsThis ??
    detected.readmeSnippet ??
    docExtracted.whatIsThis ??
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

  // LLM enrichment from docs (runs when API key is present and extraDocs exist)
  if (llmCall && detected.extraDocs.length > 0) {
    const llmEnrichment = await enrichFromDocs(detected, projectName, stack, commands, llmCall);

    // whatIsThis: only override the generated fallback, not a README snippet
    if (llmEnrichment.whatIsThis && detected.readmeSnippet === null && overrides.whatIsThis === undefined) {
      claudeCtx.whatIsThis = llmEnrichment.whatIsThis;
    }
    // Stack: append LLM additions not already present
    if (llmEnrichment.stack && llmEnrichment.stack.length > 0) {
      const existing = new Set(claudeCtx.stack);
      claudeCtx.stack = [...claudeCtx.stack, ...llmEnrichment.stack.filter((s) => !existing.has(s))];
    }
    // Commands: fill remaining # TODO: placeholders
    if (llmEnrichment.devCommand && claudeCtx.commands.dev.startsWith("# TODO:")) {
      claudeCtx.commands = { ...claudeCtx.commands, dev: llmEnrichment.devCommand };
    }
    if (llmEnrichment.testCommand && claudeCtx.commands.test.startsWith("# TODO:")) {
      claudeCtx.commands = { ...claudeCtx.commands, test: llmEnrichment.testCommand };
    }
    if (llmEnrichment.buildCommand && claudeCtx.commands.build.startsWith("# TODO:")) {
      claudeCtx.commands = { ...claudeCtx.commands, build: llmEnrichment.buildCommand };
    }
    if (llmEnrichment.lintCommand && claudeCtx.commands.lint.startsWith("# TODO:")) {
      claudeCtx.commands = { ...claudeCtx.commands, lint: llmEnrichment.lintCommand };
    }
    // Directories: only use LLM value when nothing was found by detector or doc extraction
    if (llmEnrichment.whereThingsLive && claudeCtx.directories.length === 0 && overrides.directories === undefined) {
      claudeCtx.directories = llmEnrichment.whereThingsLive;
    }
    // LLM-only fields (static extraction intentionally leaves these empty)
    if (llmEnrichment.codingRules?.length && overrides.codingRules === undefined && claudeCtx.codingRules.length === 0) {
      claudeCtx.codingRules = llmEnrichment.codingRules;
    }
    if (llmEnrichment.testingPhilosophy && overrides.testingPhilosophy === undefined) {
      claudeCtx.testingPhilosophy = llmEnrichment.testingPhilosophy;
    }
    if (llmEnrichment.commonPitfalls?.length && overrides.commonPitfalls === undefined && claudeCtx.commonPitfalls.length === 0) {
      claudeCtx.commonPitfalls = llmEnrichment.commonPitfalls;
    }
    if (llmEnrichment.gotchas?.length && overrides.gotchas === undefined && claudeCtx.gotchas.length === 0) {
      claudeCtx.gotchas = llmEnrichment.gotchas;
    }
    if (llmEnrichment.neverDo?.length && overrides.neverDo === undefined && claudeCtx.neverDo.length === 0) {
      claudeCtx.neverDo = llmEnrichment.neverDo;
    }
  }

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

  // Skills: apply static fallbacks when no API key is set
  const isStaticSkillMode = !llmCall;
  for (const skill of skills) {
    const skillCtx: SkillContext = isStaticSkillMode
      ? {
          ...skill,
          steps: skill.steps.length > 0 ? skill.steps : ["Follow the skill description above."],
          verification:
            skill.verification.length > 0
              ? skill.verification
              : ["Confirm the task completed without errors."],
          references: skill.references,
        }
      : skill;
    files.push({
      path: `.claude/skills/${skill.name}/SKILL.md`,
      stepName: `skills/${skill.name}`,
      action: "write",
      content: renderSkillMd(skillCtx),
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
    ...(isStaticSkillMode ? { skillGenerationMode: "static" as const } : {}),
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
// Compact plan summary (table form). Full file content is shown on demand
// via the drill-down handler in the plan_review step.
// ────────────────────────────────────────────────────────────────────────────

export function renderPlanSummary(plan: ScaffoldPlan): string {
  const COL1 = Math.max(...plan.files.map((f) => f.path.length + 2)) + 4;
  const DIVIDER = "─".repeat(66);
  const header = `Here's what I'll create for ${plan.projectName}:\n`;
  const colHeaders =
    "  " + "File".padEnd(COL1) + "Summary";

  const rows = plan.files.map((f) => {
    const summary = summarizeFile(f);
    const line1 = summary[0] ?? "";
    const line2 = summary[1] ?? "";
    const col1 = `  ${f.path}`.padEnd(COL1 + 2);
    if (line2) {
      return `${col1}${line1}\n${"".padEnd(COL1 + 2)}${line2}`;
    }
    return `${col1}${line1}`;
  });

  const footer = [
    "",
    'Type "ok" to proceed, a file name to see its full content,',
    "or describe any changes you want.",
  ].join("\n");

  return [header, colHeaders, DIVIDER, ...rows, DIVIDER, footer].join("\n");
}

function summarizeFile(f: PlannedFile): [string, string?] {
  const path = f.path;
  const content = f.content;

  if (path === "CLAUDE.md") {
    return summarizeClaudeMd(content);
  }
  if (path === ".claude/settings.json") {
    return summarizeSettingsJson(content);
  }
  if (path.startsWith(".claude/skills/")) {
    return summarizeSkill(content);
  }
  if (path.startsWith(".claude/agents/")) {
    return summarizeAgent(content);
  }
  if (path === ".claudeignore") {
    return [`Excludes ${parseClaudeignoreGroups(content)}`];
  }
  if (
    path === ".claude/ccl-practices.json" ||
    path === ".claude/ccl-state.json"
  ) {
    return ["CCL internal — gitignored"];
  }
  const preview = content.trim().replace(/\s+/g, " ").slice(0, 80);
  return [preview];
}

function summarizeClaudeMd(content: string): [string, string] {
  const stack = parseStackBulletSummary(content);
  const lines = content.split("\n").length;
  return [`${stack}, commands, coding rules`, `(${lines} lines)`];
}

function parseStackBulletSummary(content: string): string {
  const sectionMatch = content.match(/##\s+Stack\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (!sectionMatch) return "Stack";
  const block = sectionMatch[1] ?? "";
  const items = [...block.matchAll(/^-\s+(.+)$/gm)]
    .map((m) => (m[1] ?? "").trim())
    .filter((s) => s.length > 0 && !s.startsWith("_"));
  if (items.length === 0) return "Stack";
  return items.slice(0, 3).join(", ");
}

function summarizeSettingsJson(content: string): [string, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return ["Permissions: default", "Hooks: none"];
  }
  return [
    `Permissions: ${readAllowSummary(parsed)}`,
    `Hooks: ${readHooksSummary(parsed)}`,
  ];
}

function readAllowSummary(parsed: unknown): string {
  const allow = (parsed as { permissions?: { allow?: unknown } } | null)
    ?.permissions?.allow;
  if (!Array.isArray(allow) || allow.length === 0) return "default";
  const tools = allow
    .filter((v): v is string => typeof v === "string")
    .slice(0, 3);
  if (tools.length === 0) return "default";
  return allow.length > 3 ? `${tools.join(", ")}, ...` : tools.join(", ");
}

function readHooksSummary(parsed: unknown): string {
  const hooks = (parsed as { hooks?: Record<string, unknown> } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return "none";
  const cmds: string[] = [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const grp of groups) {
      const inner = (grp as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        const cmd = (h as { command?: unknown })?.command;
        if (typeof cmd === "string") cmds.push(cmd);
      }
    }
  }
  if (cmds.length === 0) return "none";
  return cmds.slice(0, 3).join(", ");
}

function summarizeSkill(content: string): [string, string?] {
  const desc = parseFrontmatterField(content, "description") ?? "";
  const words = desc
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
  const action = parseSkillFirstStepAction(content);
  if (action !== null) return [`Triggers on ${words}`, action];
  return [`Triggers on ${words}`];
}

function parseFrontmatterField(content: string, name: string): string | null {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const re = new RegExp(`^${name}:\\s*(.+)$`, "m");
  const m = fmMatch[1]!.match(re);
  if (!m) return null;
  return (m[1] ?? "").trim();
}

function parseSkillFirstStepAction(content: string): string | null {
  const block = extractSkillStepsBlock(content);
  if (block === null) return null;
  const code = block.match(/`([^`\n]+)`/);
  if (code && code[1]) {
    const first = code[1].trim().split(/\s+/)[0];
    if (first) return `Runs \`${first}\``;
  }
  const firstStep = block.match(/^\s*\d+\.\s+(.+)$/m);
  if (firstStep && firstStep[1]) {
    return firstStep[1].trim().split(/\s+/).slice(0, 6).join(" ");
  }
  return null;
}

function summarizeAgent(content: string): [string, string] {
  const model = parseFrontmatterField(content, "model") ?? "agent";
  const scope = parseAgentScopeSummary(content);
  return [
    `${model}, read-only scan of ${scope}`,
    "Returns structured JSON to orchestrator",
  ];
}

function parseAgentScopeSummary(content: string): string {
  const m = content.match(/Scope:\s*([^\n]+)/);
  if (m && m[1]) return m[1].trim();
  return "source files";
}

function parseClaudeignoreGroups(content: string): string {
  const groups: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) continue;
    const heading = trimmed.replace(/^#+\s*/, "").trim();
    if (heading.length > 0) groups.push(heading);
    if (groups.length === 4) break;
  }
  if (groups.length === 0) return "(no groups)";
  return groups.join(", ");
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

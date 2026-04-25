// ────────────────────────────────────────────────────────────────────────────
// CCL skill engine — §11, §18
//
// Three-step flow: classify → estimate → generate.
// Structure is deterministic (lives in core); content is LLM-generated
// (injected via LlmCall, so core stays free of MCP/SDK dependencies).
// ────────────────────────────────────────────────────────────────────────────

export type LlmCall = (
  prompt: string,
  systemPrompt?: string,
) => Promise<string>;

export interface ProjectContextSummary {
  projectName: string;
  projectType: string;
  language: string;
  stack: string[];
  commands?: {
    dev: string;
    test: string;
    build: string;
    lint: string;
  };
}

export interface SkillDimensions {
  procedural: boolean;
  persona: boolean;
  methodology: boolean;
  externalIntegration: boolean;
  generativeOutput: boolean;
  analytical: boolean;
  transformative: boolean;
  meta: boolean;
}

export interface SkillClassification {
  skillName: string;
  dimensions: SkillDimensions;
  dimensionCount: number;
  isHighRisk: boolean;
}

export interface SkillEstimate {
  skillName: string;
  dimensionCount: number;
  forecastSeconds: number;
}

export interface SkillEngineEstimates {
  classifications: SkillClassification[];
  estimates: SkillEstimate[];
  classificationLatencyMs: number;
  sequentialTotalSeconds: number;
  parallelTotalSeconds: number;
  calibrationMultiplier: number;
}

export type SkillGenerationMode = "parallel" | "sequential" | "skip";

export interface GeneratedSkill {
  skillName: string;
  content: string;
}

// ────────────────────────────────────────────────────────────────────────────
// High-risk detection
// ────────────────────────────────────────────────────────────────────────────

const HIGH_RISK_WORDS = [
  "deploy",
  "publish",
  "release",
  "migrate",
  "migration",
  "rollback",
  "delete",
  "drop",
  "destroy",
  "push",
  "overwrite",
];

export function isHighRiskSkillName(name: string): boolean {
  const lower = name.toLowerCase();
  return HIGH_RISK_WORDS.some((w) => lower.includes(w));
}

// ────────────────────────────────────────────────────────────────────────────
// Classification
// ────────────────────────────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM_PROMPT = `You classify CCL skills against 8 boolean dimensions.
Return JSON only — no prose, no markdown fences.`;

export async function classifySkills(
  skillNames: string[],
  projectContext: ProjectContextSummary,
  llmCall: LlmCall,
): Promise<{
  classifications: SkillClassification[];
  classificationLatencyMs: number;
}> {
  if (skillNames.length === 0) {
    return { classifications: [], classificationLatencyMs: 0 };
  }
  const prompt = buildClassificationPrompt(skillNames, projectContext);
  const start = Date.now();
  const raw = await llmCall(prompt, CLASSIFIER_SYSTEM_PROMPT);
  const classificationLatencyMs = Date.now() - start;
  const classifications = parseClassificationResponse(raw, skillNames);
  return { classifications, classificationLatencyMs };
}

function buildClassificationPrompt(
  skillNames: string[],
  ctx: ProjectContextSummary,
): string {
  return [
    `Project: ${ctx.projectName} (${ctx.projectType}, ${ctx.language})`,
    `Stack: ${ctx.stack.join(", ") || "(none detected)"}`,
    "",
    "Classify each skill below against these 8 boolean dimensions:",
    "  procedural           — has step-by-step executable instructions",
    "  persona              — Claude adopts a specific expert identity",
    "  methodology          — defines a thinking or working framework",
    "  externalIntegration  — depends on external tool, API, or service",
    "  generativeOutput     — produces a specific deliverable or artifact",
    "  analytical           — reads and evaluates existing artifacts",
    "  transformative       — converts one format or thing to another",
    "  meta                 — creates or manages other skills/agents/infra",
    "",
    "Skills:",
    ...skillNames.map((n) => `  - ${n}`),
    "",
    "Respond with a JSON array where each element is:",
    `{"skillName":"<name>","procedural":bool,"persona":bool,"methodology":bool,"externalIntegration":bool,"generativeOutput":bool,"analytical":bool,"transformative":bool,"meta":bool}`,
    "JSON only — no prose, no markdown fences.",
  ].join("\n");
}

export class SkillClassifierParseError extends Error {
  constructor(public readonly raw: string) {
    super(
      `Skill classifier returned non-JSON or unrecognised shape: ${raw.slice(0, 200)}`,
    );
    this.name = "SkillClassifierParseError";
  }
}

function parseClassificationResponse(
  raw: string,
  skillNames: string[],
): SkillClassification[] {
  const cleaned = stripMarkdownFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new SkillClassifierParseError(cleaned);
  }
  const rows = normalizeClassificationRows(parsed);
  if (rows === null) throw new SkillClassifierParseError(cleaned);
  const byName = new Map<string, RawRow>();
  for (const row of rows) {
    if (typeof row.skillName === "string") byName.set(row.skillName, row);
  }
  return skillNames.map((name) => {
    const row = byName.get(name);
    const dimensions: SkillDimensions = {
      procedural: toBool(row?.procedural),
      persona: toBool(row?.persona),
      methodology: toBool(row?.methodology),
      externalIntegration: toBool(row?.externalIntegration),
      generativeOutput: toBool(row?.generativeOutput),
      analytical: toBool(row?.analytical),
      transformative: toBool(row?.transformative),
      meta: toBool(row?.meta),
    };
    return {
      skillName: name,
      dimensions,
      dimensionCount: countTrueDimensions(dimensions),
      isHighRisk: isHighRiskSkillName(name),
    };
  });
}

interface RawRow {
  skillName?: unknown;
  procedural?: unknown;
  persona?: unknown;
  methodology?: unknown;
  externalIntegration?: unknown;
  generativeOutput?: unknown;
  analytical?: unknown;
  transformative?: unknown;
  meta?: unknown;
}

function normalizeClassificationRows(parsed: unknown): RawRow[] | null {
  if (Array.isArray(parsed)) return parsed as RawRow[];
  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj["skills"])) return obj["skills"] as RawRow[];
    if (Array.isArray(obj["classifications"]))
      return obj["classifications"] as RawRow[];
  }
  return null;
}

function toBool(v: unknown): boolean {
  return v === true;
}

function countTrueDimensions(d: SkillDimensions): number {
  return (
    (d.procedural ? 1 : 0) +
    (d.persona ? 1 : 0) +
    (d.methodology ? 1 : 0) +
    (d.externalIntegration ? 1 : 0) +
    (d.generativeOutput ? 1 : 0) +
    (d.analytical ? 1 : 0) +
    (d.transformative ? 1 : 0) +
    (d.meta ? 1 : 0)
  );
}

function stripMarkdownFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

// ────────────────────────────────────────────────────────────────────────────
// Estimation
// ────────────────────────────────────────────────────────────────────────────

export const CALIBRATION_MULTIPLIER = 3.5;
const MIN_EFFECTIVE_LATENCY_MS = 500;

export function buildEstimates(
  classifications: SkillClassification[],
  classificationLatencyMs: number,
): SkillEngineEstimates {
  const effectiveSeconds =
    Math.max(classificationLatencyMs, MIN_EFFECTIVE_LATENCY_MS) / 1000;
  const estimates: SkillEstimate[] = classifications.map((c) => {
    const raw =
      effectiveSeconds * CALIBRATION_MULTIPLIER * (1 + c.dimensionCount * 0.15);
    return {
      skillName: c.skillName,
      dimensionCount: c.dimensionCount,
      forecastSeconds: Math.max(1, Math.ceil(raw)),
    };
  });
  const sequentialTotalSeconds = estimates.reduce(
    (sum, e) => sum + e.forecastSeconds,
    0,
  );
  const parallelTotalSeconds = estimates.reduce(
    (m, e) => Math.max(m, e.forecastSeconds),
    0,
  );
  return {
    classifications,
    estimates,
    classificationLatencyMs,
    sequentialTotalSeconds,
    parallelTotalSeconds,
    calibrationMultiplier: CALIBRATION_MULTIPLIER,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Display
// ────────────────────────────────────────────────────────────────────────────

const BAR_WIDTH = 8;
const SKILL_COL_WIDTH = 22;

export function renderEstimatesDisplay(
  estimates: SkillEngineEstimates,
): string {
  const rows = estimates.estimates.filter((e) => e.dimensionCount > 0);
  const latencySeconds = (estimates.classificationLatencyMs / 1000).toFixed(1);

  const table: string[] = [
    `  ${"Skill".padEnd(SKILL_COL_WIDTH)}  Dimensions  Forecast`,
    `  ${"─".repeat(SKILL_COL_WIDTH + 24)}`,
  ];
  for (const row of rows) {
    table.push(formatRow(row));
  }

  const lines: string[] = [
    `I've analysed ${estimates.estimates.length} skills for your project.`,
    `Classification took ${latencySeconds}s — using this to forecast generation times.`,
    "",
    ...table,
    "",
    `  ⏱  Sequential  ~${estimates.sequentialTotalSeconds}s total`,
    `  ⚡  Parallel    ~${estimates.parallelTotalSeconds}s total  (longest skill)`,
    "",
    "  Note: forecasts are approximate — actual time may vary",
    "  based on model load and response complexity.",
    "",
    "  [1] Parallel  (recommended)",
    "  [2] Sequential",
    "  [3] Skip — use basic templates, enrich later",
  ];
  return lines.join("\n");
}

function formatRow(row: SkillEstimate): string {
  const name = row.skillName.padEnd(SKILL_COL_WIDTH);
  const bar = buildProgressBar(row.dimensionCount);
  return `  ${name}  ${bar} ${row.dimensionCount}  ~${row.forecastSeconds}s`;
}

function buildProgressBar(dimCount: number): string {
  const clamped = Math.max(0, Math.min(BAR_WIDTH, dimCount));
  return "█".repeat(clamped) + " ".repeat(BAR_WIDTH - clamped);
}

// ────────────────────────────────────────────────────────────────────────────
// Generation
// ────────────────────────────────────────────────────────────────────────────

const GENERATION_SYSTEM_PROMPT = `You write SKILL.md body content for Claude Code skills.
Write concise, project-specific content. Claude is already smart — only add context
Claude doesn't already have. Use real commands from the detected stack — never
placeholders like "[your command here]".
Return only the SKILL.md body content — no frontmatter, no markdown fences.`;

export async function generateSkill(
  classification: SkillClassification,
  projectContext: ProjectContextSummary,
  llmCall: LlmCall,
): Promise<GeneratedSkill> {
  const prompt = buildGenerationPrompt(classification, projectContext);
  const raw = await llmCall(prompt, GENERATION_SYSTEM_PROMPT);
  return {
    skillName: classification.skillName,
    content: stripMarkdownFences(raw),
  };
}

function buildGenerationPrompt(
  classification: SkillClassification,
  ctx: ProjectContextSummary,
): string {
  const active = activeSections(classification);
  const ordered = orderSections(active);
  const lines: string[] = [
    `Skill: ${classification.skillName}`,
    `Project: ${ctx.projectName} (${ctx.projectType}, ${ctx.language})`,
    `Stack: ${ctx.stack.join(", ") || "(none detected)"}`,
  ];
  if (ctx.commands) {
    lines.push(
      `Commands: dev=\`${ctx.commands.dev}\` test=\`${ctx.commands.test}\` build=\`${ctx.commands.build}\` lint=\`${ctx.commands.lint}\``,
    );
  }
  lines.push(
    "",
    "Active dimensions: " + summarizeDimensions(classification.dimensions),
    `High-risk: ${classification.isHighRisk}`,
    "",
    "Emit these sections in order, using real project details:",
    ...ordered.map((s) => `  ${s}`),
    "",
    "Rules:",
    "- Return only the body content — no YAML frontmatter, no fences.",
    "- Each section starts with `## <name>`.",
    "- Be concise. Only content Claude would not already know.",
    "- Use real commands from the stack — never placeholders.",
  );
  return lines.join("\n");
}

function summarizeDimensions(d: SkillDimensions): string {
  const on: string[] = [];
  if (d.procedural) on.push("procedural");
  if (d.persona) on.push("persona");
  if (d.methodology) on.push("methodology");
  if (d.externalIntegration) on.push("externalIntegration");
  if (d.generativeOutput) on.push("generativeOutput");
  if (d.analytical) on.push("analytical");
  if (d.transformative) on.push("transformative");
  if (d.meta) on.push("meta");
  return on.length === 0 ? "(none)" : on.join(", ");
}

function activeSections(c: SkillClassification): Set<string> {
  const out = new Set<string>();
  out.add("When to use");
  out.add("When NOT to use");
  out.add("Verification criteria");
  out.add("Reference");
  if (c.dimensions.persona) out.add("Role");
  if (c.dimensions.methodology) out.add("Framework");
  if (c.dimensions.externalIntegration) {
    out.add("Setup");
    out.add("Credentials");
  }
  if (c.dimensions.generativeOutput) out.add("Output format");
  if (c.dimensions.analytical) out.add("What to look for");
  if (c.dimensions.transformative) out.add("Input → Output");
  if (c.dimensions.meta) out.add("What it creates");
  if (c.dimensions.procedural) {
    out.add("Steps");
    if (c.isHighRisk) out.add("Failure modes");
  }
  return out;
}

const SECTION_ORDER: string[] = [
  "Role",
  "Framework",
  "Setup",
  "Credentials",
  "What to look for",
  "Input → Output",
  "What it creates",
  "When to use",
  "When NOT to use",
  "Steps",
  "Failure modes",
  "Verification criteria",
  "Reference",
];

function orderSections(active: Set<string>): string[] {
  return SECTION_ORDER.filter((s) => active.has(s));
}

// ────────────────────────────────────────────────────────────────────────────
// Orchestration
// ────────────────────────────────────────────────────────────────────────────

export async function generateAllSkills(
  classifications: SkillClassification[],
  projectContext: ProjectContextSummary,
  mode: SkillGenerationMode,
  llmCall: LlmCall,
  onProgress?: (skillName: string, index: number, total: number) => void,
): Promise<GeneratedSkill[]> {
  if (mode === "skip") {
    return classifications.map((c) => ({
      skillName: c.skillName,
      content: basicTemplateBody(c),
    }));
  }
  if (mode === "parallel") {
    const total = classifications.length;
    return Promise.all(
      classifications.map(async (c, index) => {
        const result = await generateSkill(c, projectContext, llmCall);
        onProgress?.(c.skillName, index, total);
        return result;
      }),
    );
  }
  const results: GeneratedSkill[] = [];
  const total = classifications.length;
  for (let index = 0; index < total; index += 1) {
    const c = classifications[index]!;
    const result = await generateSkill(c, projectContext, llmCall);
    results.push(result);
    onProgress?.(c.skillName, index, total);
  }
  return results;
}

export function basicTemplateBody(c: SkillClassification): string {
  const sections: string[] = [];
  sections.push("## When to use");
  sections.push(
    `Trigger this skill when working on ${c.skillName}. _(describe concrete activation criteria)_`,
  );
  sections.push("");
  sections.push("## When NOT to use");
  sections.push("_(add exclusions specific to this project)_");
  if (c.dimensions.procedural) {
    sections.push("");
    sections.push("## Steps");
    sections.push("_(add numbered steps)_");
    if (c.isHighRisk) {
      sections.push("");
      sections.push("## Failure modes");
      sections.push("_(list failure modes and recovery actions)_");
    }
  }
  sections.push("");
  sections.push("## Verification criteria");
  sections.push("_(add verification criteria)_");
  sections.push("");
  sections.push("## Reference");
  sections.push("_(add references)_");
  return sections.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Assembly
// ────────────────────────────────────────────────────────────────────────────

export function assembleSkillMd(
  skillName: string,
  classification: SkillClassification | null,
  generatedContent: string,
  allowedTools: string[],
): string {
  const description = extractDescription(generatedContent, classification);
  return [
    "---",
    `name: ${skillName}`,
    `description: ${description}`,
    `allowed-tools: [${allowedTools.join(", ")}]`,
    "---",
    "",
    generatedContent.trim(),
    "",
  ].join("\n");
}

function extractDescription(
  content: string,
  classification: SkillClassification | null,
): string {
  const match = content.match(/##\s*When to use\s*\n([\s\S]*?)(?=\n##\s|\s*$)/);
  if (match && match[1]) {
    const body = match[1].trim();
    const firstSentence = body.split(/(?<=[.!?])\s+/)[0]?.trim();
    if (firstSentence) return firstSentence;
  }
  return classification
    ? `Trigger this skill when working on ${classification.skillName}.`
    : "Trigger this skill when the situation applies.";
}

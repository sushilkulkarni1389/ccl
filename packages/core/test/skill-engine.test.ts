import { describe, it } from "node:test";
import nodeAssert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assembleSkillMd,
  buildEstimates,
  classifySkills,
  CALIBRATION_MULTIPLIER,
  generateAllSkills,
  generateSkill,
  renderEstimatesDisplay,
  type GeneratedSkill,
  type LlmCall,
  type ProjectContextSummary,
  type SkillClassification,
  type SkillDimensions,
  type SkillEngineEstimates,
} from "../src/skill-engine.js";
import {
  buildScaffoldPlan,
  executeScaffoldPlan,
  type GitRunner,
} from "../src/scaffold.js";
import { detectProject } from "../src/detector.js";

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-04-24T10:00:00.000Z");
const noopGit: GitRunner = async () => 0;

const PROJECT_CTX: ProjectContextSummary = {
  projectName: "sample",
  projectType: "rest-api",
  language: "typescript",
  stack: ["Node.js", "TypeScript", "Fastify"],
  commands: {
    dev: "npm run dev",
    test: "npm test",
    build: "npm run build",
    lint: "npm run lint",
  },
};

function emptyDims(): SkillDimensions {
  return {
    procedural: false,
    persona: false,
    methodology: false,
    externalIntegration: false,
    generativeOutput: false,
    analytical: false,
    transformative: false,
    meta: false,
  };
}

function cls(
  skillName: string,
  dims: Partial<SkillDimensions> = {},
  isHighRisk = false,
): SkillClassification {
  const full: SkillDimensions = { ...emptyDims(), ...dims };
  const dimensionCount = Object.values(full).filter((v) => v === true).length;
  return { skillName, dimensions: full, dimensionCount, isHighRisk };
}

function classificationJson(rows: Array<Record<string, unknown>>): string {
  return JSON.stringify(rows);
}

async function mkFixture(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function write(root: string, rel: string, body: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await writeFile(full, body, "utf8");
}

async function setupNodeFixture(): Promise<string> {
  const root = await mkFixture("ccl-skill-engine-");
  await write(
    root,
    "package.json",
    JSON.stringify({
      name: "auth-service",
      scripts: { dev: "node dist/index.js", test: "vitest", build: "tsc", lint: "eslint ." },
      dependencies: { fastify: "^4.0.0" },
      devDependencies: { typescript: "^5.0.0", vitest: "^1.0.0" },
    }),
  );
  await write(root, "tsconfig.json", "{}");
  return root;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// classifySkills
// ──────────────────────────────────────────────────────────────────────────

describe("classifySkills", () => {
  it("populates all dimension fields from LLM JSON response", async () => {
    const llmCall: LlmCall = async () =>
      classificationJson([
        {
          skillName: "deploy",
          procedural: true,
          persona: false,
          methodology: false,
          externalIntegration: true,
          generativeOutput: false,
          analytical: false,
          transformative: false,
          meta: false,
        },
      ]);
    const { classifications } = await classifySkills(["deploy"], PROJECT_CTX, llmCall);
    nodeAssert.equal(classifications.length, 1);
    const d = classifications[0]!;
    nodeAssert.equal(d.skillName, "deploy");
    nodeAssert.equal(d.dimensions.procedural, true);
    nodeAssert.equal(d.dimensions.externalIntegration, true);
    nodeAssert.equal(d.dimensions.persona, false);
    nodeAssert.equal(d.dimensions.meta, false);
    nodeAssert.equal(d.dimensionCount, 2);
    nodeAssert.equal(d.isHighRisk, true);
  });

  it("maps deploy skill to procedural + externalIntegration", async () => {
    const llmCall: LlmCall = async () =>
      classificationJson([
        {
          skillName: "deploy",
          procedural: true,
          externalIntegration: true,
        },
      ]);
    const { classifications } = await classifySkills(["deploy"], PROJECT_CTX, llmCall);
    nodeAssert.equal(classifications[0]!.dimensions.procedural, true);
    nodeAssert.equal(classifications[0]!.dimensions.externalIntegration, true);
  });

  it("maps brainstorming to persona + methodology + generativeOutput", async () => {
    const llmCall: LlmCall = async () =>
      classificationJson([
        {
          skillName: "brainstorming",
          persona: true,
          methodology: true,
          generativeOutput: true,
        },
      ]);
    const { classifications } = await classifySkills(
      ["brainstorming"],
      PROJECT_CTX,
      llmCall,
    );
    const d = classifications[0]!;
    nodeAssert.equal(d.dimensions.persona, true);
    nodeAssert.equal(d.dimensions.methodology, true);
    nodeAssert.equal(d.dimensions.generativeOutput, true);
    nodeAssert.equal(d.dimensionCount, 3);
    nodeAssert.equal(d.isHighRisk, false);
  });

  it("records latency > 0", async () => {
    const llmCall: LlmCall = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return classificationJson([{ skillName: "x" }]);
    };
    const { classificationLatencyMs } = await classifySkills(
      ["x"],
      PROJECT_CTX,
      llmCall,
    );
    nodeAssert.ok(
      classificationLatencyMs > 0,
      `expected latency > 0, got ${classificationLatencyMs}`,
    );
  });

  it("returns zero latency + empty when given no skills (no LLM call)", async () => {
    let called = 0;
    const llmCall: LlmCall = async () => {
      called++;
      return "[]";
    };
    const result = await classifySkills([], PROJECT_CTX, llmCall);
    nodeAssert.equal(result.classifications.length, 0);
    nodeAssert.equal(result.classificationLatencyMs, 0);
    nodeAssert.equal(called, 0);
  });

  it("tolerates JSON wrapped in ```json fences", async () => {
    const llmCall: LlmCall = async () =>
      "```json\n" + classificationJson([{ skillName: "x", procedural: true }]) + "\n```";
    const { classifications } = await classifySkills(["x"], PROJECT_CTX, llmCall);
    nodeAssert.equal(classifications[0]!.dimensions.procedural, true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// buildEstimates
// ──────────────────────────────────────────────────────────────────────────

describe("buildEstimates", () => {
  it("produces forecasts > 0 even when latency is 0ms (floor)", () => {
    const classifications = [cls("a"), cls("b", { procedural: true })];
    const est = buildEstimates(classifications, 0);
    for (const row of est.estimates) {
      nodeAssert.ok(
        row.forecastSeconds > 0,
        `expected > 0, got ${row.forecastSeconds}`,
      );
    }
  });

  it("higher dimension count yields higher forecast", () => {
    const classifications = [
      cls("low"),
      cls("mid", { procedural: true, persona: true }),
      cls("high", {
        procedural: true,
        persona: true,
        methodology: true,
        externalIntegration: true,
        generativeOutput: true,
        analytical: true,
        transformative: true,
        meta: true,
      }),
    ];
    const est = buildEstimates(classifications, 1000);
    const [low, mid, high] = est.estimates;
    nodeAssert.ok(low!.forecastSeconds <= mid!.forecastSeconds);
    nodeAssert.ok(mid!.forecastSeconds < high!.forecastSeconds);
  });

  it("parallelTotalSeconds = max(forecastSeconds), sequentialTotalSeconds = sum", () => {
    const classifications = [
      cls("a", { procedural: true }),
      cls("b", {
        procedural: true,
        persona: true,
        methodology: true,
        externalIntegration: true,
      }),
      cls("c"),
    ];
    const est = buildEstimates(classifications, 2000);
    const max = Math.max(...est.estimates.map((e) => e.forecastSeconds));
    const sum = est.estimates.reduce((s, e) => s + e.forecastSeconds, 0);
    nodeAssert.equal(est.parallelTotalSeconds, max);
    nodeAssert.equal(est.sequentialTotalSeconds, sum);
    nodeAssert.equal(est.calibrationMultiplier, CALIBRATION_MULTIPLIER);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// renderEstimatesDisplay
// ──────────────────────────────────────────────────────────────────────────

describe("renderEstimatesDisplay", () => {
  const classifications = [
    cls("deploy", {
      procedural: true,
      persona: true,
      methodology: true,
      externalIntegration: true,
      generativeOutput: true,
      analytical: true,
      transformative: true,
      meta: true,
    }),
    cls("run-migrations", {
      procedural: true,
      externalIntegration: true,
      analytical: true,
      methodology: true,
      meta: true,
    }),
    cls("empty-skill"),
  ];

  it("includes 'forecasts are approximate' note", () => {
    const est: SkillEngineEstimates = buildEstimates(classifications, 1234);
    const out = renderEstimatesDisplay(est);
    nodeAssert.match(out, /forecasts are approximate/);
  });

  it("includes classification latency in seconds", () => {
    const est: SkillEngineEstimates = buildEstimates(classifications, 1234);
    const out = renderEstimatesDisplay(est);
    nodeAssert.match(out, /Classification took 1\.2s/);
  });

  it("renders progress bars of correct width (8 chars)", () => {
    const est: SkillEngineEstimates = buildEstimates(classifications, 1000);
    const out = renderEstimatesDisplay(est);
    const deployRow = out.split("\n").find((l) => l.includes("deploy"))!;
    nodeAssert.ok(deployRow, "deploy row present");
    const bar = deployRow.match(/([█ ]{8})/);
    nodeAssert.ok(bar, `bar not found in: "${deployRow}"`);
    nodeAssert.equal(bar![1]!.length, 8);
    const migRow = out.split("\n").find((l) => l.includes("run-migrations"))!;
    const migBar = migRow.match(/([█ ]{8})/);
    nodeAssert.ok(migBar);
    nodeAssert.equal(migBar![1]!.length, 8);
  });

  it("skips rows for skills with 0 dimensions", () => {
    const est: SkillEngineEstimates = buildEstimates(classifications, 1000);
    const out = renderEstimatesDisplay(est);
    nodeAssert.doesNotMatch(out, /empty-skill/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// generateSkill + generateAllSkills
// ──────────────────────────────────────────────────────────────────────────

describe("generateAllSkills", () => {
  const classifications = [
    cls("deploy", { procedural: true, externalIntegration: true }, true),
    cls("onboard", { procedural: true, persona: true }),
    cls("run-pipeline", { procedural: true, externalIntegration: true }),
  ];

  it("skip mode returns basic template content without calling llmCall", async () => {
    let calls = 0;
    const llmCall: LlmCall = async () => {
      calls++;
      return "body";
    };
    const result = await generateAllSkills(
      classifications,
      PROJECT_CTX,
      "skip",
      llmCall,
    );
    nodeAssert.equal(calls, 0);
    nodeAssert.equal(result.length, 3);
    for (const g of result) {
      nodeAssert.match(g.content, /## When to use/);
    }
  });

  it("sequential mode calls llmCall N times and invokes onProgress N times", async () => {
    let calls = 0;
    const llmCall: LlmCall = async () => {
      calls++;
      return `## When to use\nTrigger content.`;
    };
    const progressCalls: Array<[string, number, number]> = [];
    const result = await generateAllSkills(
      classifications,
      PROJECT_CTX,
      "sequential",
      llmCall,
      (name, idx, total) => progressCalls.push([name, idx, total]),
    );
    nodeAssert.equal(calls, 3);
    nodeAssert.equal(progressCalls.length, 3);
    nodeAssert.equal(result.length, 3);
    nodeAssert.deepEqual(
      progressCalls.map((c) => c[0]),
      ["deploy", "onboard", "run-pipeline"],
    );
    nodeAssert.equal(progressCalls[0]![2], 3);
  });

  it("parallel mode starts all llmCall invocations before any resolves", async () => {
    let started = 0;
    const total = classifications.length;
    let releaseAll!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const llmCall: LlmCall = async () => {
      started++;
      if (started === total) releaseAll();
      await allStarted;
      return `## When to use\nDo the thing.`;
    };
    const result = await generateAllSkills(
      classifications,
      PROJECT_CTX,
      "parallel",
      llmCall,
    );
    nodeAssert.equal(started, total);
    nodeAssert.equal(result.length, total);
  });
});

describe("generateSkill", () => {
  it("passes skill name + stack into the prompt", async () => {
    let captured = "";
    const llmCall: LlmCall = async (prompt) => {
      captured = prompt;
      return "## When to use\nTrigger this skill when deploying.";
    };
    const result = await generateSkill(
      cls("deploy", { procedural: true, externalIntegration: true }, true),
      PROJECT_CTX,
      llmCall,
    );
    nodeAssert.match(captured, /deploy/);
    nodeAssert.match(captured, /Fastify/);
    nodeAssert.match(captured, /High-risk: true/);
    nodeAssert.equal(result.skillName, "deploy");
    nodeAssert.match(result.content, /## When to use/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// assembleSkillMd
// ──────────────────────────────────────────────────────────────────────────

describe("assembleSkillMd", () => {
  it("extracts description from first sentence of When to use", () => {
    const body = [
      "## When to use",
      "Trigger when the user says 'deploy'. Then run the pipeline.",
      "",
      "## Steps",
      "1. Run tests.",
    ].join("\n");
    const out = assembleSkillMd("deploy", null, body, ["Read", "Bash"]);
    nodeAssert.match(
      out,
      /description: Trigger when the user says 'deploy'\./,
    );
  });

  it("produces valid YAML frontmatter with name, description, allowed-tools", () => {
    const body = "## When to use\nTrigger this skill.";
    const out = assembleSkillMd("publish", null, body, ["Read", "Bash"]);
    nodeAssert.match(out, /^---\nname: publish\n/);
    nodeAssert.match(out, /description: Trigger this skill\./);
    nodeAssert.match(out, /allowed-tools: \[Read, Bash\]/);
    nodeAssert.match(out, /\n---\n\n## When to use\n/);
  });

  it("falls back to a sensible description when When to use is missing", () => {
    const out = assembleSkillMd(
      "onboard",
      cls("onboard", { persona: true }),
      "## Role\nYou are the onboarding guide.",
      ["Read"],
    );
    nodeAssert.match(out, /description: Trigger this skill when working on onboard\./);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Scaffold integration
// ──────────────────────────────────────────────────────────────────────────

describe("buildScaffoldPlan + skill engine", () => {
  it("populates skillEstimates and skillClassifications when llmCall is provided", async () => {
    const root = await setupNodeFixture();
    try {
      const detected = await detectProject(root);
      const llmCall: LlmCall = async () =>
        JSON.stringify([
          { skillName: "onboard", procedural: true, persona: true },
          { skillName: "deploy", procedural: true, externalIntegration: true },
          { skillName: "run-migrations", procedural: true, externalIntegration: true },
        ]);
      const plan = await buildScaffoldPlan({
        detected,
        gitSync: true,
        now: FIXED_NOW,
        llmCall,
      });
      nodeAssert.ok(plan.skillClassifications);
      nodeAssert.ok(plan.skillEstimates);
      nodeAssert.equal(
        plan.skillClassifications!.length,
        plan.skills.length,
      );
      nodeAssert.equal(
        plan.skillEstimates!.estimates.length,
        plan.skills.length,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves skillEstimates undefined when llmCall is absent", async () => {
    const root = await setupNodeFixture();
    try {
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({
        detected,
        gitSync: true,
        now: FIXED_NOW,
      });
      nodeAssert.equal(plan.skillEstimates, undefined);
      nodeAssert.equal(plan.skillClassifications, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("executeScaffoldPlan + skill engine", () => {
  it("mode=skip writes skill files without calling llmCall", async () => {
    const root = await setupNodeFixture();
    try {
      const detected = await detectProject(root);
      let genCalls = 0;
      const llmCall: LlmCall = async () => {
        genCalls++;
        return "[]";
      };
      const plan = await buildScaffoldPlan({
        detected,
        gitSync: true,
        now: FIXED_NOW,
      });
      plan.skillGenerationMode = "skip";

      const beforeCalls = genCalls;
      await executeScaffoldPlan(plan, {
        now: () => FIXED_NOW,
        initGit: false,
        runGitCommand: noopGit,
        llmCall,
      });
      nodeAssert.equal(
        genCalls - beforeCalls,
        0,
        "skip mode must not call llmCall",
      );

      nodeAssert.ok(
        await pathExists(join(root, ".claude/skills/onboard/SKILL.md")),
      );
      const onboardContent = await readFile(
        join(root, ".claude/skills/onboard/SKILL.md"),
        "utf8",
      );
      // Static-template fallback retains the original renderSkillMd output.
      nodeAssert.match(onboardContent, /^---\nname: onboard\n/);
      nodeAssert.match(onboardContent, /## Steps/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("mode=parallel writes skill files with generated content", async () => {
    const root = await setupNodeFixture();
    try {
      const detected = await detectProject(root);

      const llmCall: LlmCall = async (prompt) => {
        // Classification call → return JSON
        if (prompt.includes("Classify each skill")) {
          const names = Array.from(
            prompt.matchAll(/^\s+-\s+(\S+)$/gm),
            (m) => m[1]!,
          );
          return JSON.stringify(
            names.map((n) => ({
              skillName: n,
              procedural: true,
              externalIntegration: n === "deploy" || n === "run-migrations",
            })),
          );
        }
        // Generation call → return rich body content
        const skillMatch = prompt.match(/^Skill:\s+(\S+)$/m);
        const name = skillMatch ? skillMatch[1] : "skill";
        return [
          "## When to use",
          `Trigger ${name} when ready to ship.`,
          "",
          "## Steps",
          "1. Run tests.",
          "2. Apply.",
          "",
          "## Verification criteria",
          "- All tests pass.",
          "",
          "## Reference",
          "- CLAUDE.md",
        ].join("\n");
      };

      const plan = await buildScaffoldPlan({
        detected,
        gitSync: true,
        now: FIXED_NOW,
        llmCall,
      });
      nodeAssert.ok(plan.skillClassifications);
      plan.skillGenerationMode = "parallel";

      await executeScaffoldPlan(plan, {
        now: () => FIXED_NOW,
        initGit: false,
        runGitCommand: noopGit,
        llmCall,
      });

      const onboardContent = await readFile(
        join(root, ".claude/skills/onboard/SKILL.md"),
        "utf8",
      );
      nodeAssert.match(onboardContent, /^---\nname: onboard\n/);
      nodeAssert.match(
        onboardContent,
        /description: Trigger onboard when ready to ship\./,
      );
      nodeAssert.match(onboardContent, /## When to use/);
      nodeAssert.match(onboardContent, /## Steps/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Guard: GeneratedSkill shape stays stable
// ──────────────────────────────────────────────────────────────────────────

describe("GeneratedSkill", () => {
  it("has skillName + content fields", () => {
    const g: GeneratedSkill = { skillName: "x", content: "y" };
    nodeAssert.equal(g.skillName, "x");
    nodeAssert.equal(g.content, "y");
  });
});

import { describe, it, before, after } from "node:test";
import nodeAssert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { detectProject } from "../src/detector.js";
import {
  buildScaffoldPlan,
  detectInterruptedScaffold,
  executeScaffoldPlan,
  mergeCclGitignoreBlock,
  readScaffoldState,
  renderPlanPreview,
  ScaffoldError,
  type GitRunner,
  type ScaffoldPlan,
} from "../src/scaffold.js";
import {
  CCL_GITIGNORE_MARKER_END,
  CCL_GITIGNORE_MARKER_START,
} from "../src/templates/gitignore.js";

async function mkFixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ccl-scaffold-"));
}

async function write(root: string, rel: string, body: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await writeFile(full, body, "utf8");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const noopGit: GitRunner = async () => 0;
const FIXED_NOW = new Date("2026-04-24T10:00:00.000Z");

async function setupNodeFixture(): Promise<string> {
  const root = await mkFixture();
  await write(
    root,
    "package.json",
    JSON.stringify({
      name: "auth-service",
      scripts: {
        dev: "node dist/index.js",
        test: "vitest",
        build: "tsc",
        lint: "eslint .",
      },
      dependencies: { fastify: "^4.0.0", "@prisma/client": "^5.0.0" },
      devDependencies: { typescript: "^5.0.0", vitest: "^1.0.0" },
    }),
  );
  await write(root, "tsconfig.json", "{}");
  await write(root, "README.md", "# auth-service\n\nIssues JWTs for the mobile app.\n");
  return root;
}

// ──────────────────────────────────────────────────────────────────────────
// Plan construction
// ──────────────────────────────────────────────────────────────────────────

describe("buildScaffoldPlan", () => {
  let root: string;
  before(async () => {
    root = await setupNodeFixture();
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("produces the full §7 file list for a rest-api", async () => {
    const detected = await detectProject(root);
    const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });

    const paths = plan.files.map((f) => f.path);
    nodeAssert.ok(paths.includes("CLAUDE.md"));
    nodeAssert.ok(paths.includes(".claude/settings.json"));
    nodeAssert.ok(paths.includes(".claude/skills/onboard/SKILL.md"));
    nodeAssert.ok(paths.includes(".claude/skills/deploy/SKILL.md"));
    nodeAssert.ok(paths.includes(".claude/skills/run-migrations/SKILL.md"));
    nodeAssert.ok(paths.includes(".claude/agents/security-auditor.md"));
    nodeAssert.ok(paths.includes(".claude/agents/dependency-mapper.md"));
    nodeAssert.ok(paths.includes(".claudeignore"));
    nodeAssert.ok(paths.includes(".gitignore"));
    nodeAssert.ok(paths.includes(".claude/ccl-practices.json"));

    const gitignoreStep = plan.files.find((f) => f.path === ".gitignore")!;
    nodeAssert.equal(gitignoreStep.action, "gitignore-merge");
  });

  it("uses README snippet when no override is supplied", async () => {
    const detected = await detectProject(root);
    const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });
    const claudeMd = plan.files.find((f) => f.path === "CLAUDE.md")!;
    nodeAssert.match(claudeMd.content, /Issues JWTs for the mobile app\./);
  });

  it("honors overrides and hides ccl-state.json from git when gitSync=false", async () => {
    const detected = await detectProject(root);
    const plan = await buildScaffoldPlan({
      detected,
      gitSync: false,
      now: FIXED_NOW,
      overrides: {
        codingRules: ["No default exports", "Repository layer for all db access"],
        whatIsThis: "Custom description",
        testingPhilosophy: "TDD only",
      },
    });
    const claudeMd = plan.files.find((f) => f.path === "CLAUDE.md")!;
    nodeAssert.match(claudeMd.content, /Custom description/);
    nodeAssert.match(claudeMd.content, /- No default exports/);
    nodeAssert.match(claudeMd.content, /TDD only/);
    const gi = plan.files.find((f) => f.path === ".gitignore")!;
    nodeAssert.match(gi.content, /\.claude\/ccl-state\.json/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Plan preview
// ──────────────────────────────────────────────────────────────────────────

describe("renderPlanPreview", () => {
  it("includes every section with a divider and the footer prompt", async () => {
    const root = await setupNodeFixture();
    try {
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });
      const preview = renderPlanPreview(plan);
      nodeAssert.match(preview, /^Here's what I'll create for auth-service:/);
      nodeAssert.match(preview, /CLAUDE\.md/);
      nodeAssert.match(preview, /\.claude\/settings\.json/);
      nodeAssert.match(preview, /\.claude\/skills\/deploy\/SKILL\.md/);
      nodeAssert.match(preview, /\.gitignore additions/);
      nodeAssert.match(preview, /Does this look right\?/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Gitignore merge
// ──────────────────────────────────────────────────────────────────────────

describe("mergeCclGitignoreBlock", () => {
  const block =
    CCL_GITIGNORE_MARKER_START +
    "\n.claude/settings.local.json\n" +
    CCL_GITIGNORE_MARKER_END +
    "\n";

  it("creates a new file when none exists", () => {
    const out = mergeCclGitignoreBlock("", block);
    nodeAssert.equal(out, block);
  });

  it("appends cleanly to an existing .gitignore", () => {
    const existing = "node_modules/\ndist/\n";
    const out = mergeCclGitignoreBlock(existing, block);
    nodeAssert.match(out, /node_modules\//);
    nodeAssert.match(out, /dist\//);
    nodeAssert.match(out, /\.claude\/settings\.local\.json/);
    nodeAssert.ok(out.indexOf("dist/") < out.indexOf(".claude/settings.local.json"));
  });

  it("replaces a pre-existing CCL block idempotently", () => {
    const staleBlock =
      CCL_GITIGNORE_MARKER_START + "\nOLD\n" + CCL_GITIGNORE_MARKER_END + "\n";
    const existing = "node_modules/\n\n" + staleBlock;
    const out = mergeCclGitignoreBlock(existing, block);
    nodeAssert.doesNotMatch(out, /OLD/);
    nodeAssert.match(out, /\.claude\/settings\.local\.json/);
    // Running twice should be idempotent
    const out2 = mergeCclGitignoreBlock(out, block);
    nodeAssert.equal(out2, out);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Executor — happy path
// ──────────────────────────────────────────────────────────────────────────

describe("executeScaffoldPlan", () => {
  let root: string;
  let plan: ScaffoldPlan;
  before(async () => {
    root = await setupNodeFixture();
    const detected = await detectProject(root);
    plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes every planned file to disk and marks status=complete", async () => {
    const result = await executeScaffoldPlan(plan, {
      now: () => FIXED_NOW,
      initGit: false,
      runGitCommand: noopGit,
    });

    nodeAssert.equal(result.status, "complete");
    nodeAssert.ok(result.written.includes("CLAUDE.md"));
    nodeAssert.ok(result.written.includes(".claude/agents/security-auditor.md"));

    nodeAssert.ok(await pathExists(join(root, "CLAUDE.md")));
    nodeAssert.ok(await pathExists(join(root, ".claude/settings.json")));
    nodeAssert.ok(
      await pathExists(join(root, ".claude/skills/onboard/SKILL.md")),
    );
    nodeAssert.ok(
      await pathExists(join(root, ".claude/skills/deploy/SKILL.md")),
    );
    nodeAssert.ok(
      await pathExists(join(root, ".claude/agents/security-auditor.md")),
    );
    nodeAssert.ok(await pathExists(join(root, ".claude/ccl-state.json")));

    const state = (await readScaffoldState(root))!;
    nodeAssert.equal(state.status, "complete");
    nodeAssert.equal(state.completedAt, FIXED_NOW.toISOString());
    nodeAssert.equal(state.lastCompletedStep, undefined);
    nodeAssert.equal(state.remainingSteps, undefined);
    nodeAssert.ok(state.steps.every((s) => s.status === "done"));
  });

  it("merged .gitignore is idempotent across re-runs", async () => {
    const first = await readFile(join(root, ".gitignore"), "utf8");
    await executeScaffoldPlan(plan, {
      now: () => FIXED_NOW,
      initGit: false,
      runGitCommand: noopGit,
    });
    const second = await readFile(join(root, ".gitignore"), "utf8");
    nodeAssert.equal(first, second);
  });

  it("leaves no <path>.*.ccl-tmp residue anywhere under the project", async () => {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const tmpResidue = entries
      .filter((e) => e.isFile() && /\.ccl-tmp$/.test(e.name))
      .map((e) => e.name);
    nodeAssert.deepEqual(
      tmpResidue,
      [],
      "atomicWrite must rename its randomized temp file before returning",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Executor — step tracking + git init
// ──────────────────────────────────────────────────────────────────────────

describe("executor incremental state + git init", () => {
  it("invokes onStepStart/onStepDone in order and runs git init", async () => {
    const root = await setupNodeFixture();
    try {
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });

      const started: string[] = [];
      const done: string[] = [];
      const gitCalls: string[][] = [];
      const runGitCommand: GitRunner = async (args) => {
        gitCalls.push(args);
        return 0;
      };

      const result = await executeScaffoldPlan(plan, {
        now: () => FIXED_NOW,
        initGit: true,
        runGitCommand,
        onStepStart: (s) => started.push(s),
        onStepDone: (s) => done.push(s),
      });

      nodeAssert.equal(result.gitInitialized, true);
      nodeAssert.deepEqual(gitCalls, [["init", "--quiet"]]);
      nodeAssert.deepEqual(started, plan.files.map((f) => f.stepName));
      nodeAssert.deepEqual(done, plan.files.map((f) => f.stepName));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips git init when .git already exists", async () => {
    const root = await setupNodeFixture();
    try {
      await mkdir(join(root, ".git"), { recursive: true });
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });

      let called = false;
      const runGitCommand: GitRunner = async () => {
        called = true;
        return 0;
      };
      const result = await executeScaffoldPlan(plan, {
        now: () => FIXED_NOW,
        initGit: true,
        runGitCommand,
      });
      nodeAssert.equal(called, false);
      nodeAssert.equal(result.gitInitialized, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Executor — failure mid-scaffold (§8.2)
// ──────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────
// Stack-aware agent roles (Patch 2)
// ──────────────────────────────────────────────────────────────────────────

async function setupPythonFastapiFixture(): Promise<string> {
  const root = await mkFixture();
  await write(
    root,
    "pyproject.toml",
    `[project]
name = "billing-api"
dependencies = ["fastapi>=0.100", "sqlalchemy>=2", "pydantic>=2"]
`,
  );
  await write(root, "README.md", "# billing-api\n\nFastAPI billing service.\n");
  return root;
}

async function setupNextjsFixture(): Promise<string> {
  const root = await mkFixture();
  await write(
    root,
    "package.json",
    JSON.stringify({
      name: "storefront",
      scripts: { dev: "next dev", build: "next build", test: "vitest", lint: "next lint" },
      dependencies: { next: "^14.0.0", react: "^18.0.0" },
      devDependencies: { typescript: "^5.0.0", vitest: "^1.0.0" },
    }),
  );
  await write(root, "tsconfig.json", "{}");
  return root;
}

async function setupUnknownStackFixture(): Promise<string> {
  const root = await mkFixture();
  await write(root, "NOTES.txt", "nothing here");
  return root;
}

const WRITE_VERB_RE = /\b(write|writes|writing|create|creates|creating|generate|generates|generating)\b/i;

function countSentences(s: string): number {
  return s
    .split(/(?<=[.!?])\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0).length;
}

describe("stack-aware agent roles", () => {
  it("TypeScript + Next.js project generates roles containing TypeScript and Next.js", async () => {
    const root = await setupNextjsFixture();
    try {
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });
      nodeAssert.ok(plan.agents.length > 0);
      for (const agent of plan.agents) {
        nodeAssert.ok(agent.role.length > 0, `agent ${agent.name} has non-empty role`);
        nodeAssert.match(agent.role, /TypeScript/);
        nodeAssert.match(agent.role, /Next\.js/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Python + FastAPI project security agent role contains Python and FastAPI", async () => {
    const root = await setupPythonFastapiFixture();
    try {
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });
      const security = plan.agents.find((a) => a.name.includes("security"))!;
      nodeAssert.ok(security, "security agent present");
      nodeAssert.match(security.role, /Python/);
      nodeAssert.match(security.role, /FastAPI/);
      nodeAssert.match(security.role, /vulnerabilit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("unknown stack falls back to generic role with precision constraint", async () => {
    const root = await setupUnknownStackFixture();
    try {
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });
      for (const agent of plan.agents) {
        nodeAssert.match(agent.role, /senior software engineer/);
        nodeAssert.match(agent.role, /never speculate/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("all agent roles are at most 3 sentences and read-only framed", async () => {
    const fixtures = [
      setupNextjsFixture,
      setupPythonFastapiFixture,
      setupUnknownStackFixture,
      setupNodeFixture,
    ];
    for (const setup of fixtures) {
      const root = await setup();
      try {
        const detected = await detectProject(root);
        const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });
        for (const agent of plan.agents) {
          const sentences = countSentences(agent.role);
          nodeAssert.ok(
            sentences <= 3,
            `${agent.name} role has ${sentences} sentences (>3): "${agent.role}"`,
          );
          nodeAssert.doesNotMatch(
            agent.role,
            WRITE_VERB_RE,
            `${agent.name} role contains a write/create/generate verb: "${agent.role}"`,
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("renders role into the agent markdown frontmatter", async () => {
    const root = await setupNextjsFixture();
    try {
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });
      const securityFile = plan.files.find(
        (f) => f.path === ".claude/agents/security-auditor.md",
      )!;
      nodeAssert.match(securityFile.content, /\nrole: You audit TypeScript/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("agent with disallowed tool is skipped", () => {
  it("does not write the file, marks step skipped, scaffold still completes", async () => {
    const root = await setupNodeFixture();
    try {
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({
        detected,
        gitSync: true,
        now: FIXED_NOW,
        overrides: {
          agents: [
            {
              name: "writer-agent",
              description: "d",
              model: "claude-haiku-4-5",
              tools: ["Read", "Write"],
              purpose: "review code",
              outputFormat: "JSON",
              constraints: [],
              role: "",
            },
          ],
        },
      });

      const writerStepName = "agents/writer-agent";
      nodeAssert.ok(
        plan.files.some((f) => f.stepName === writerStepName),
        "plan must include the writer-agent step",
      );

      const startedNames: string[] = [];
      const result = await executeScaffoldPlan(plan, {
        now: () => FIXED_NOW,
        initGit: false,
        runGitCommand: noopGit,
        onStepStart: (s) => startedNames.push(s),
      });

      nodeAssert.equal(result.status, "complete");
      nodeAssert.ok(
        !(await pathExists(join(root, ".claude/agents/writer-agent.md"))),
        "skipped agent file must not be on disk",
      );
      nodeAssert.ok(
        !result.written.includes(".claude/agents/writer-agent.md"),
        "skipped agent must not appear in written list",
      );

      const skipMessage = startedNames.find((n) =>
        n.startsWith(`${writerStepName} — SKIPPED`),
      );
      nodeAssert.ok(
        skipMessage,
        `expected SKIPPED message for ${writerStepName} in onStepStart names: ${JSON.stringify(startedNames)}`,
      );
      nodeAssert.match(skipMessage!, /security:/);
      nodeAssert.match(skipMessage!, /Write/);

      const state = (await readScaffoldState(root))!;
      nodeAssert.equal(state.status, "complete");
      const writerStep = state.steps.find((s) => s.name === writerStepName);
      nodeAssert.equal(writerStep?.status, "skipped");

      const otherSteps = state.steps.filter((s) => s.name !== writerStepName);
      for (const step of otherSteps) {
        nodeAssert.equal(
          step.status,
          "done",
          `step ${step.name} should be done, was ${step.status}`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("executor failure recovery (§8.2)", () => {
  it("persists status=failed with last_completed_step when a write throws", async () => {
    const root = await setupNodeFixture();
    try {
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });

      // Sabotage: after the first file succeeds, replace the target of the
      // second planned file with a directory of the same path. The write will
      // fail because you can't overwrite a non-empty directory with a file.
      const failStep = plan.files[1]!;
      const sabotagePath = join(root, failStep.path);
      await mkdir(sabotagePath, { recursive: true });
      await writeFile(join(sabotagePath, "placeholder"), "x");

      await nodeAssert.rejects(
        () =>
          executeScaffoldPlan(plan, {
            now: () => FIXED_NOW,
            initGit: false,
            runGitCommand: noopGit,
          }),
        (err: unknown) => err instanceof ScaffoldError && err.stepName === failStep.stepName,
      );

      const state = (await readScaffoldState(root))!;
      nodeAssert.equal(state.status, "failed");
      nodeAssert.equal(state.lastCompletedStep, plan.files[0]!.stepName);
      nodeAssert.ok(state.remainingSteps!.includes(failStep.stepName));

      const interrupted = await detectInterruptedScaffold(root);
      nodeAssert.ok(interrupted, "interrupted scaffold should be detectable");
      nodeAssert.equal(interrupted!.state.status, "failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Path traversal guard (Fix 7)
// ──────────────────────────────────────────────────────────────────────────

describe("path traversal guard", () => {
  it("permits paths inside the root and writes successfully", async () => {
    const root = await setupNodeFixture();
    try {
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });

      const result = await executeScaffoldPlan(plan, {
        now: () => FIXED_NOW,
        initGit: false,
        runGitCommand: noopGit,
      });

      nodeAssert.equal(result.status, "complete");
      nodeAssert.ok(await pathExists(join(root, "CLAUDE.md")));
      nodeAssert.ok(await pathExists(join(root, ".claude/settings.json")));

      const state = (await readScaffoldState(root))!;
      nodeAssert.ok(state.steps.every((s) => s.status === "done"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks single-level traversal: outside.txt never written, step skipped, others done", async () => {
    const root = await setupNodeFixture();
    try {
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });

      const malicious = {
        path: join(root, "..", "outside.txt"),
        stepName: "malicious/traversal",
        action: "write" as const,
        content: "pwned",
      };
      plan.files.push(malicious);

      const startedNames: string[] = [];
      const result = await executeScaffoldPlan(plan, {
        now: () => FIXED_NOW,
        initGit: false,
        runGitCommand: noopGit,
        onStepStart: (s) => startedNames.push(s),
      });

      const escapedPath = join(dirname(root), "outside.txt");
      nodeAssert.equal(
        await pathExists(escapedPath),
        false,
        "traversal target must not be written",
      );

      nodeAssert.equal(result.status, "complete");
      const state = (await readScaffoldState(root))!;
      const malStep = state.steps.find((s) => s.name === malicious.stepName);
      nodeAssert.equal(malStep?.status, "skipped");
      const others = state.steps.filter((s) => s.name !== malicious.stepName);
      for (const step of others) {
        nodeAssert.equal(
          step.status,
          "done",
          `step ${step.name} should be done, was ${step.status}`,
        );
      }

      const skipMessage = startedNames.find((n) =>
        n.startsWith(`${malicious.stepName} — SKIPPED`),
      );
      nodeAssert.ok(skipMessage, "expected SKIPPED onStepStart for traversal");
      nodeAssert.match(skipMessage!, /security: path traversal blocked/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks deep traversal: /etc/passwd target never written, step skipped, others done", async () => {
    const root = await setupNodeFixture();
    try {
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });

      const malicious = {
        path: join(root, "..", "..", "etc", "passwd"),
        stepName: "malicious/deep",
        action: "write" as const,
        content: "root::0:0:::",
      };
      plan.files.push(malicious);

      const result = await executeScaffoldPlan(plan, {
        now: () => FIXED_NOW,
        initGit: false,
        runGitCommand: noopGit,
      });

      const escapedPath = join(dirname(dirname(root)), "etc", "passwd");
      // Note: /etc/passwd may exist on the host system; assert that the *content*
      // we tried to write is not present, instead of asserting absence outright.
      let observedContent: string | null = null;
      try {
        observedContent = await readFile(escapedPath, "utf8");
      } catch {
        observedContent = null;
      }
      nodeAssert.notEqual(
        observedContent,
        malicious.content,
        "traversal must not have overwritten the target",
      );

      nodeAssert.equal(result.status, "complete");
      const state = (await readScaffoldState(root))!;
      const malStep = state.steps.find((s) => s.name === malicious.stepName);
      nodeAssert.equal(malStep?.status, "skipped");
      const others = state.steps.filter((s) => s.name !== malicious.stepName);
      for (const step of others) {
        nodeAssert.equal(step.status, "done");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a path resolving to root itself (cannot write a directory path)", async () => {
    const root = await setupNodeFixture();
    try {
      const detected = await detectProject(root);
      const plan = await buildScaffoldPlan({ detected, gitSync: true, now: FIXED_NOW });

      const malicious = {
        path: ".",
        stepName: "malicious/root-equal",
        action: "write" as const,
        content: "should never be written",
      };
      plan.files.push(malicious);

      const result = await executeScaffoldPlan(plan, {
        now: () => FIXED_NOW,
        initGit: false,
        runGitCommand: noopGit,
      });

      nodeAssert.equal(result.status, "complete");
      const state = (await readScaffoldState(root))!;
      const malStep = state.steps.find((s) => s.name === malicious.stepName);
      nodeAssert.equal(malStep?.status, "skipped");
      const others = state.steps.filter((s) => s.name !== malicious.stepName);
      for (const step of others) {
        nodeAssert.equal(step.status, "done");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});

// ────────────────────────────────────────────────────────────────────────────
// Phase 8 — End-to-end integration tests.
// Exercise the full CCL pipeline (runSetup + runCcl) against real tmpdir
// fixtures. Black-box assertions on observable disk state.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it } from "node:test";
import nodeAssert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  readFile,
  rm,
  writeFile,
  stat,
  mkdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  defaultPracticesContext,
  loadPractices,
  savePractices,
  type PracticeEntry,
} from "@ccl/core";
import { OfflineError, runCcl } from "../src/commands/ccl.js";
import { runSetup } from "../src/setup.js";

import {
  assertBaselineScaffold,
  assertFileExists,
  assertScaffoldStatus,
  autoDetectScript,
  buildDefaultLlmCall,
  buildReviewLoopLlmCall,
  buildScriptedAdapter,
  copyFixture,
  guidedSetupScript,
  mkEmptyDirSync,
  mkTmpDir,
  placeObstacleDir,
  readJson,
  readText,
} from "./integration-helpers.js";

const SERVER_DIST = resolve(
  process.cwd(),
  "dist",
  "index.js",
);

function stepNameToPath(stepName: string): string {
  if (stepName.startsWith("skills/")) {
    return `.claude/${stepName}/SKILL.md`;
  }
  if (stepName.startsWith("agents/")) {
    return `.claude/${stepName}.md`;
  }
  if (stepName === "CLAUDE.md" || stepName === ".claudeignore" || stepName === ".gitignore") {
    return stepName;
  }
  return `.claude/${stepName}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Group 1 — Setup script (runSetup) end-to-end
// ────────────────────────────────────────────────────────────────────────────

describe("Group 1 — runSetup end-to-end", () => {
  it("S1 — fresh install on node-ts-webapp writes a valid claude.json with an absolute dist/index.js path", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      const configPath = join(root, "claude.json");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exit = await runSetup({
        configPath,
        serverDistPath: SERVER_DIST,
        stdout: (m) => stdout.push(m),
        stderr: (m) => stderr.push(m),
      });
      nodeAssert.equal(exit, 0);
      nodeAssert.equal(stderr.length, 0);
      const parsed = readJson(root, "claude.json") as {
        mcpServers: { ccl: { command: string; args: string[]; type: string } };
      };
      nodeAssert.equal(parsed.mcpServers.ccl.command, "node");
      const resolvedArg = parsed.mcpServers.ccl.args[0];
      nodeAssert.ok(resolvedArg && resolvedArg.startsWith("/"), "args[0] must be absolute");
      nodeAssert.equal(parsed.mcpServers.ccl.type, "stdio");
      // The path resolves to a real file on disk (the built dist/index.js).
      const s = await stat(resolvedArg!);
      nodeAssert.ok(s.isFile());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("S2 — re-run on an already-registered config leaves it byte-identical", async () => {
    const root = await mkTmpDir();
    try {
      const configPath = join(root, "claude.json");
      // First install
      await runSetup({
        configPath,
        serverDistPath: SERVER_DIST,
        stdout: () => {},
        stderr: () => {},
      });
      const firstBytes = await readFile(configPath, "utf8");
      // Second install
      const exit = await runSetup({
        configPath,
        serverDistPath: SERVER_DIST,
        stdout: () => {},
        stderr: () => {},
      });
      nodeAssert.equal(exit, 0);
      const secondBytes = await readFile(configPath, "utf8");
      nodeAssert.equal(secondBytes, firstBytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("S3 — a pre-existing third-party MCP entry is preserved verbatim", async () => {
    const root = await mkTmpDir();
    try {
      const configPath = join(root, "claude.json");
      const prior = {
        mcpServers: {
          "third-party": {
            command: "python",
            args: ["/opt/third/server.py"],
            type: "stdio",
            env: { FOO: "bar" },
          },
        },
      };
      await writeFile(configPath, JSON.stringify(prior, null, 2) + "\n", "utf8");
      const exit = await runSetup({
        configPath,
        serverDistPath: SERVER_DIST,
        stdout: () => {},
        stderr: () => {},
      });
      nodeAssert.equal(exit, 0);
      const parsed = readJson(root, "claude.json") as {
        mcpServers: Record<string, unknown>;
      };
      nodeAssert.deepEqual(
        parsed.mcpServers["third-party"],
        prior.mcpServers["third-party"],
        "third-party entry must survive verbatim",
      );
      nodeAssert.ok(parsed.mcpServers["ccl"], "ccl entry added alongside");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Group 2 — Auto-detect flow
// ────────────────────────────────────────────────────────────────────────────

describe("Group 2 — auto-detect flow", () => {
  async function runAutoScaffold(
    fixtureOrRoot: string,
    answersOverride?: Partial<Parameters<typeof autoDetectScript>[0]>,
  ): Promise<{ root: string; sayLog: string[] }> {
    const root = fixtureOrRoot.startsWith("/")
      ? fixtureOrRoot
      : await copyFixture(fixtureOrRoot);
    const { adapter, sayLog } = buildScriptedAdapter({
      tmpDir: root,
      script: {
        inputs: autoDetectScript({
          skillMode: 2,
          reviewResponses: ["looks good"],
          gitSync: 0,
          permission: 0,
          ...answersOverride,
        }),
      },
    });
    await runCcl(adapter);
    return { root, sayLog };
  }

  it("A1 — node-ts-webapp scaffolds full §9 tree with a compliant CLAUDE.md", async () => {
    const { root } = await runAutoScaffold("node-ts-webapp");
    try {
      assertBaselineScaffold(root);
      assertFileExists(root, ".claude/settings.local.json");
      assertFileExists(root, ".claude/ccl-practices.json");
      assertFileExists(root, ".gitignore");
      // Next.js + TS stack leaked into CLAUDE.md
      nodeAssert.match(readText(root, "CLAUDE.md"), /TypeScript/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("A2 — python-fastapi fixture generates a Python stack line + valid settings.json", async () => {
    const { root } = await runAutoScaffold("python-fastapi");
    try {
      assertBaselineScaffold(root);
      const claude = readText(root, "CLAUDE.md");
      nodeAssert.match(claude, /Python/);
      nodeAssert.match(claude, /FastAPI/);
      const settings = readJson(root, ".claude/settings.json") as {
        permissions: { allow: string[]; deny: string[] };
      };
      nodeAssert.ok(Array.isArray(settings.permissions.allow));
      nodeAssert.ok(Array.isArray(settings.permissions.deny));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("A3 — go-module fixture scaffolds dependency-mapper with claude-haiku-4-5", async () => {
    const { root } = await runAutoScaffold("go-module");
    try {
      assertBaselineScaffold(root);
      const agentMd = readText(root, ".claude/agents/dependency-mapper.md");
      nodeAssert.match(agentMd, /^---\nname: dependency-mapper\n/);
      nodeAssert.match(agentMd, /model: claude-haiku-4-5/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("A4 — rust-workspace fixture scaffolds the onboard skill", async () => {
    const { root } = await runAutoScaffold("rust-workspace");
    try {
      assertBaselineScaffold(root);
      const skillMd = readText(root, ".claude/skills/onboard/SKILL.md");
      nodeAssert.match(skillMd, /^---\nname: onboard\n/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("A5 — flutter-mobile fixture produces mobile-app state + build-release skill", async () => {
    const { root } = await runAutoScaffold("flutter-mobile");
    try {
      assertBaselineScaffold(root);
      const state = readJson(root, ".claude/ccl-state.json") as {
        project_type?: string;
      };
      nodeAssert.equal(state.project_type, "mobile-app");
      assertFileExists(root, ".claude/skills/build-release/SKILL.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("A6 — monorepo fixture scaffolds run-in-workspace skill and mentions monorepo", async () => {
    const { root } = await runAutoScaffold("monorepo");
    try {
      assertBaselineScaffold(root);
      assertFileExists(root, ".claude/skills/run-in-workspace/SKILL.md");
      const state = readJson(root, ".claude/ccl-state.json") as {
        project_type?: string;
      };
      nodeAssert.equal(state.project_type, "monorepo");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("A7 — empty directory scaffolds without panic", async () => {
    const root = mkEmptyDirSync();
    try {
      await runAutoScaffold(root);
      assertBaselineScaffold(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("A8 — existing-scaffold with [1] Re-scaffold overwrites cleanly", async () => {
    const root = await copyFixture("existing-scaffold");
    try {
      const original = readText(root, "CLAUDE.md");
      const { adapter, sayLog } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: [
            0, // auto-detect
            0, // Re-scaffold
            ...autoDetectScript({
              skillMode: 2,
              reviewResponses: ["looks good"],
              gitSync: 0,
              permission: 0,
            }).slice(1), // drop the greeting choice (already consumed above)
          ],
        },
      });
      await runCcl(adapter);
      nodeAssert.ok(
        sayLog.some((s) => s.includes("found an existing CCL scaffold")),
        "re-scaffold warning shown",
      );
      assertBaselineScaffold(root);
      // New CLAUDE.md is different from the fixture's placeholder
      const after = readText(root, "CLAUDE.md");
      nodeAssert.notEqual(after, original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("A9 — existing-scaffold with [2] Skip exits cleanly and preserves files", async () => {
    const root = await copyFixture("existing-scaffold");
    try {
      const originalClaudeMd = readText(root, "CLAUDE.md");
      const { adapter, sayLog } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: [
            0, // auto-detect
            1, // Skip
          ],
        },
      });
      const result = await runCcl(adapter);
      nodeAssert.equal(result.status, "skipped");
      nodeAssert.ok(
        sayLog.some((s) => s.includes("found an existing CCL scaffold")),
      );
      nodeAssert.equal(readText(root, "CLAUDE.md"), originalClaudeMd);
      // No .claude/settings.json should have been written.
      await nodeAssert.rejects(
        () => stat(join(root, ".claude/settings.json")),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("A10 — gitSync=false adds ccl-state.json to .gitignore while keeping settings.local.json excluded", async () => {
    const { root } = await runAutoScaffold("node-ts-webapp", { gitSync: 1 });
    try {
      const gi = readText(root, ".gitignore");
      nodeAssert.match(gi, /\.claude\/ccl-state\.json/);
      nodeAssert.match(gi, /\.claude\/settings\.local\.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Group 3 — Guided setup flow
// ────────────────────────────────────────────────────────────────────────────

describe("Group 3 — guided setup flow", () => {
  it("G1 — answers propagate to CLAUDE.md (name, stack, coding rules)", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      const { adapter } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: guidedSetupScript({
            q1: "my-thing — a little tool",
            q2: "CLI tool",
            q3: "Node.js, TypeScript, Biome",
            q4: "No default exports",
            q5: "",
            skillMode: 2,
            reviewResponses: ["looks good"],
            gitSync: 0,
            permission: 0,
          }),
        },
      });
      await runCcl(adapter);
      assertBaselineScaffold(root);
      const claude = readText(root, "CLAUDE.md");
      nodeAssert.match(claude, /^# my-thing\n/);
      nodeAssert.match(claude, /a little tool/);
      nodeAssert.match(claude, /TypeScript/);
      nodeAssert.match(claude, /No default exports/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("G2 — Q5 skipped leaves the gotchas section empty", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      const { adapter } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: guidedSetupScript({
            q1: "flatland",
            q2: "web app",
            q3: "Next.js",
            q4: "",
            q5: "",
            skillMode: 2,
            reviewResponses: ["looks good"],
            gitSync: 0,
            permission: 0,
          }),
        },
      });
      await runCcl(adapter);
      assertBaselineScaffold(root);
      const claude = readText(root, "CLAUDE.md");
      // Gotchas section renders "_(none)_" marker when empty (see Phase 1 template).
      const match = claude.match(/## Gotchas\n([\s\S]*?)(\n## |\n---|$)/);
      if (match) {
        const body = match[1]!.trim();
        nodeAssert.ok(
          body === "" || body.includes("_(none)_"),
          `gotchas should be empty, got: ${body}`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("G3 — Q2 'REST API' resolves to rest-api with run-migrations skill", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      const { adapter } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: guidedSetupScript({
            q1: "billing",
            q2: "REST API",
            q3: "Node.js, Fastify",
            q4: "",
            q5: "",
            skillMode: 2,
            reviewResponses: ["looks good"],
            gitSync: 0,
            permission: 0,
          }),
        },
      });
      await runCcl(adapter);
      assertBaselineScaffold(root);
      const state = readJson(root, ".claude/ccl-state.json") as {
        project_type?: string;
      };
      nodeAssert.equal(state.project_type, "rest-api");
      assertFileExists(root, ".claude/skills/run-migrations/SKILL.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Group 4 — Review loop
// ────────────────────────────────────────────────────────────────────────────

describe("Group 4 — review loop", () => {
  it("R1 — one change request → one rebuild → approval writes updated content", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      const { llmCall, reviewCallCount } = buildReviewLoopLlmCall([
        JSON.stringify({ codingRules: ["No console.log"] }),
      ]);
      const { adapter, sayLog } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: autoDetectScript({
            skillMode: 2,
            reviewResponses: ["please add a rule about console.log", "looks good"],
            gitSync: 0,
            permission: 0,
          }),
        },
        llmCall,
      });
      await runCcl(adapter);
      const previewCount = sayLog.filter((s) =>
        s.startsWith("Here's what I'll create"),
      ).length;
      nodeAssert.ok(
        previewCount >= 2,
        `expected ≥2 plan renders, got ${previewCount}`,
      );
      nodeAssert.equal(reviewCallCount(), 1, "exactly one review-LLM call");
      nodeAssert.match(readText(root, "CLAUDE.md"), /No console\.log/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("R2 — three change rounds then approve; final plan wins", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      const { llmCall, reviewCallCount } = buildReviewLoopLlmCall([
        JSON.stringify({ projectName: "alpha" }),
        JSON.stringify({ projectName: "beta" }),
        JSON.stringify({ projectName: "gamma" }),
      ]);
      const { adapter, sayLog } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: autoDetectScript({
            skillMode: 2,
            reviewResponses: [
              "rename it alpha",
              "no make it beta",
              "actually gamma",
              "looks good",
            ],
            gitSync: 0,
            permission: 0,
          }),
        },
        llmCall,
      });
      await runCcl(adapter);
      nodeAssert.equal(reviewCallCount(), 3);
      const previewCount = sayLog.filter((s) =>
        s.startsWith("Here's what I'll create"),
      ).length;
      nodeAssert.equal(previewCount, 4, "one preview per iteration (3 changes + approval)");
      nodeAssert.match(readText(root, "CLAUDE.md"), /^# gamma\n/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Group 5 — Interruption recovery (§8.2)
// ────────────────────────────────────────────────────────────────────────────

describe("Group 5 — interruption recovery", () => {
  it("I1 — mid-scaffold failure leaves ccl-state.json in the failed state with recovery info", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      // Obstacle: turn a planned file path into a non-empty directory so the
      // atomic rename fails. Pick `.claudeignore` — it's written AFTER skills
      // + agents, so a handful of steps will succeed before the failure.
      placeObstacleDir(root, ".claudeignore");

      const { adapter } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: autoDetectScript({
            skillMode: 2,
            reviewResponses: ["looks good"],
            gitSync: 0,
            permission: 0,
          }),
        },
      });
      await nodeAssert.rejects(() => runCcl(adapter));
      assertScaffoldStatus(root, "failed");
      const state = readJson(root, ".claude/ccl-state.json") as {
        last_completed_step?: string;
        remaining_steps?: string[];
      };
      nodeAssert.ok(
        typeof state.last_completed_step === "string" &&
          state.last_completed_step.length > 0,
        "last_completed_step recorded",
      );
      nodeAssert.ok(
        Array.isArray(state.remaining_steps) && state.remaining_steps.length > 0,
        "remaining_steps is non-empty",
      );
      nodeAssert.ok(
        state.remaining_steps!.includes(".claudeignore"),
        "the failing step is in remaining_steps",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("I2 — resume with [1] Continue skips already-done steps (mtime unchanged)", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      // Phase A — cause a failure at `.claudeignore`.
      placeObstacleDir(root, ".claudeignore");
      const adapterA = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: autoDetectScript({
            skillMode: 2,
            reviewResponses: ["looks good"],
            gitSync: 0,
            permission: 0,
          }),
        },
      }).adapter;
      await nodeAssert.rejects(() => runCcl(adapterA));
      assertScaffoldStatus(root, "failed");

      // Snapshot mtimes of every file already marked done in state.json.
      // These must not be re-written by the resume.
      const stateAfterA = readJson(root, ".claude/ccl-state.json") as {
        steps: Array<{ name: string; status: string }>;
      };
      const doneFiles = stateAfterA.steps
        .filter((s) => s.status === "done")
        .map((s) => stepNameToPath(s.name));
      nodeAssert.ok(
        doneFiles.length > 0,
        "expected at least one done step after Phase A",
      );
      const mtimesBefore = new Map<string, bigint>();
      for (const rel of doneFiles) {
        const st = await stat(join(root, rel), { bigint: true });
        mtimesBefore.set(rel, st.mtimeNs);
      }

      // Remove the obstacle so the resume can write .claudeignore.
      await rm(join(root, ".claudeignore"), { recursive: true, force: true });

      // Ensure the filesystem clock has advanced past the Phase A writes.
      await new Promise((r) => setTimeout(r, 50));

      // Phase B — resume: resumeInterruptedScaffold prompts gitSync + permission only.
      const { adapter, sayLog } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: [
            0, // Continue
            0, // gitSync yes
            0, // permission yes
          ],
        },
      });
      await runCcl(adapter);
      nodeAssert.ok(
        sayLog.some((s) => s.includes("previous scaffold was interrupted")),
        "recovery prompt shown",
      );
      assertBaselineScaffold(root);

      // Core assertion: done steps were NOT re-written during resume.
      for (const [rel, beforeNs] of mtimesBefore) {
        const after = await stat(join(root, rel), { bigint: true });
        nodeAssert.equal(
          after.mtimeNs,
          beforeNs,
          `expected ${rel} mtime unchanged (step skipped during resume)`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("I3 — re-run on interrupted state with [2] Restart runs the full scaffold fresh", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      placeObstacleDir(root, ".claudeignore");
      const adapterA = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: autoDetectScript({
            skillMode: 2,
            reviewResponses: ["looks good"],
            gitSync: 0,
            permission: 0,
          }),
        },
      }).adapter;
      await nodeAssert.rejects(() => runCcl(adapterA));
      await rm(join(root, ".claudeignore"), { recursive: true, force: true });

      const { adapter, sayLog } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: [
            1,              // Restart (interrupted prompt)
            0,              // auto-detect
            0,              // §8.1 Re-scaffold (fixture artifacts still on disk from Phase A)
            2,              // skill mode: skip
            "looks good",   // review
            0,              // gitSync yes
            0,              // permission yes
          ],
        },
      });
      await runCcl(adapter);
      nodeAssert.ok(
        sayLog.some((s) => s.includes("previous scaffold was interrupted")),
      );
      nodeAssert.ok(
        sayLog.some((s) => s.includes("found an existing CCL scaffold")),
      );
      assertBaselineScaffold(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Group 6 — Best-practices refresh (§15)
// ────────────────────────────────────────────────────────────────────────────

describe("Group 6 — best-practices refresh", () => {
  async function seedOverduePractices(root: string): Promise<void> {
    // Set next_check_due in the past so isRefreshDue(ctx, NOW) returns true.
    const ctx = defaultPracticesContext(new Date("2026-04-01T10:00:00.000Z"));
    await savePractices(root, ctx);
  }

  it("P1 — refresh prompt shown when next_check_due is past", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      await seedOverduePractices(root);
      const { adapter, sayLog } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: [
            1, // Later — get past the refresh prompt
            ...autoDetectScript({
              skillMode: 2,
              reviewResponses: ["looks good"],
              gitSync: 0,
              permission: 0,
            }),
          ],
        },
      });
      await runCcl(adapter);
      nodeAssert.ok(
        sayLog.some((s) => s.includes("7 days since your best practices")),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("P2 — Accept with Yes: candidate with 1 add + 1 removal produces a version bump", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      await seedOverduePractices(root);
      const baseline = (await loadPractices(root))!;
      const removedId = baseline.practices[0]!.id; // drop the seed
      const addition: PracticeEntry = {
        id: "bp-next",
        title: "New Practice",
        description: "A fresh recommendation discovered by web search.",
        source: "https://docs.anthropic.com/best-practices/new",
        added: "2026-04-24",
        status: "active",
      };
      // Candidate list = (baseline minus removedId) ∪ {addition}
      const candidates = baseline.practices
        .filter((p) => p.id !== removedId)
        .concat(addition);

      const webSearch = async () => candidates;
      const { adapter } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: [
            0, // Refresh → Accept
            0, // Accept changes → Yes
            ...autoDetectScript({
              skillMode: 2,
              reviewResponses: ["looks good"],
              gitSync: 0,
              permission: 0,
            }),
          ],
        },
        webSearch,
      });
      await runCcl(adapter);
      const reloaded = (await loadPractices(root))!;
      nodeAssert.notEqual(
        reloaded.version,
        baseline.version,
        "version must bump when changes are applied",
      );
      nodeAssert.ok(
        reloaded.practices.some((p) => p.id === "bp-next"),
        "new practice present",
      );
      nodeAssert.ok(
        !reloaded.practices.some((p) => p.id === removedId),
        "removed practice absent",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("P3 — Later leaves ccl-practices.json byte-identical", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      await seedOverduePractices(root);
      const before = readFileSync(
        join(root, ".claude/ccl-practices.json"),
        "utf8",
      );
      const { adapter } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: [
            1, // Later
            ...autoDetectScript({
              skillMode: 2,
              reviewResponses: ["looks good"],
              gitSync: 0,
              permission: 0,
            }),
          ],
        },
      });
      await runCcl(adapter);
      const after = readFileSync(
        join(root, ".claude/ccl-practices.json"),
        "utf8",
      );
      nodeAssert.equal(after, before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("P4 — Never writes refresh:'never' and suppresses future prompts", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      await seedOverduePractices(root);
      const { adapter: a1 } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: [
            2, // Never
            ...autoDetectScript({
              skillMode: 2,
              reviewResponses: ["looks good"],
              gitSync: 0,
              permission: 0,
            }),
          ],
        },
      });
      await runCcl(a1);

      const refreshed = (await loadPractices(root))!;
      nodeAssert.equal(refreshed.refresh, "never");

      // Second invocation: the refresh prompt must not appear (no refresh choice
      // in the script — script underrun would throw if it were asked).
      // Snapshot existing-scaffold state so §8.1 warning kicks in.
      const { adapter: a2, sayLog } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: [
            0, // auto-detect
            1, // skip existing scaffold
          ],
        },
      });
      await runCcl(a2);
      nodeAssert.ok(
        !sayLog.some((s) => s.includes("7 days since your best practices")),
        "refresh prompt suppressed on subsequent invocation",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("P5 — OfflineError during refresh is silent; scaffold continues", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      await seedOverduePractices(root);
      const webSearch = async () => {
        throw new OfflineError();
      };
      const { adapter, sayLog } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: [
            0,              // Refresh → Accept → OfflineError silently skipped
            0,              // auto-detect
            0,              // §8.1 Re-scaffold (seedOverduePractices created .claude/)
            2,              // skill mode: skip
            "looks good",
            0,              // gitSync yes
            0,              // permission yes
          ],
        },
        webSearch,
      });
      await runCcl(adapter);
      nodeAssert.ok(
        !sayLog.some((s) => s.includes("Refresh failed")),
        "no failure prompt on offline",
      );
      assertBaselineScaffold(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("P6 — non-offline webSearch error surfaces Retry/Skip; Skip continues", async () => {
    const root = await copyFixture("node-ts-webapp");
    try {
      await seedOverduePractices(root);
      const webSearch = async () => {
        throw new Error("503 unavailable");
      };
      const { adapter, sayLog } = buildScriptedAdapter({
        tmpDir: root,
        script: {
          inputs: [
            0,              // Refresh → Accept
            1,              // Retry/Skip → Skip for now
            0,              // auto-detect
            0,              // §8.1 Re-scaffold (seedOverduePractices created .claude/)
            2,              // skill mode: skip
            "looks good",
            0,              // gitSync yes
            0,              // permission yes
          ],
        },
        webSearch,
      });
      await runCcl(adapter);
      nodeAssert.ok(
        sayLog.some((s) => s.includes("Refresh failed")),
        "Retry/Skip prompt shown",
      );
      assertBaselineScaffold(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Shared helpers for Phase 8 integration tests.
// Test-only — not exported from the package barrel.

import nodeAssert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { LlmCall, PracticeEntry } from "@ccl/core";

import type { CclAdapter } from "../src/commands/ccl.js";

// ──────────────────────────────────────────────────────────────────────────
// Filesystem assertions
// ──────────────────────────────────────────────────────────────────────────

export function readJson(dir: string, relPath: string): unknown {
  const raw = readFileSync(join(dir, relPath), "utf8");
  return JSON.parse(raw) as unknown;
}

export function assertFileExists(dir: string, relPath: string): void {
  const full = join(dir, relPath);
  nodeAssert.ok(existsSync(full), `expected file to exist: ${relPath}`);
  const size = statSync(full).size;
  nodeAssert.ok(size > 0, `expected ${relPath} to be non-empty (size=0)`);
}

export function assertFileAbsent(dir: string, relPath: string): void {
  const full = join(dir, relPath);
  nodeAssert.equal(
    existsSync(full),
    false,
    `expected file to be absent: ${relPath}`,
  );
}

export function lineCount(dir: string, relPath: string): number {
  return readFileSync(join(dir, relPath), "utf8").split("\n").length;
}

export function readText(dir: string, relPath: string): string {
  return readFileSync(join(dir, relPath), "utf8");
}

export type ScaffoldStatus = "complete" | "in_progress" | "failed";

export function assertScaffoldStatus(
  dir: string,
  status: ScaffoldStatus,
): void {
  const state = readJson(dir, ".claude/ccl-state.json") as { status?: string };
  nodeAssert.equal(
    state.status,
    status,
    `expected ccl-state.json status=${status}, got ${String(state.status)}`,
  );
}

export function assertBaselineScaffold(dir: string): void {
  assertFileExists(dir, "CLAUDE.md");
  const lines = lineCount(dir, "CLAUDE.md");
  nodeAssert.ok(
    lines <= 200,
    `CLAUDE.md exceeds the 200-line limit (${lines} lines)`,
  );
  assertFileExists(dir, ".claude/settings.json");
  readJson(dir, ".claude/settings.json");
  assertFileExists(dir, ".claude/ccl-state.json");
  assertScaffoldStatus(dir, "complete");
  assertFileExists(dir, ".claudeignore");
  assertFileExists(dir, ".claude/skills/onboard/SKILL.md");
  assertFileExists(dir, ".claude/agents/security-auditor.md");
}

// ──────────────────────────────────────────────────────────────────────────
// Tmpdir + fixture copying
// ──────────────────────────────────────────────────────────────────────────

export async function mkTmpDir(prefix = "ccl-integration-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

// Fixtures live alongside this file. `test/fixtures/<name>`.
// Resolved against process.cwd() which is packages/mcp during `npm test`.
export const FIXTURES_DIR = resolve(process.cwd(), "test", "fixtures");

export async function copyFixture(name: string): Promise<string> {
  const dest = await mkTmpDir(`ccl-integration-${name}-`);
  const src = join(FIXTURES_DIR, name);
  cpSync(src, dest, { recursive: true });
  return dest;
}

export function mkEmptyDirSync(prefix = "ccl-integration-empty-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ──────────────────────────────────────────────────────────────────────────
// Scripted adapter
// ──────────────────────────────────────────────────────────────────────────

export type WebSearchFn = (query: string) => Promise<PracticeEntry[]>;

export interface AdapterScript {
  inputs: Array<string | number>;
}

export interface BuildScriptedAdapterOptions {
  tmpDir: string;
  script: AdapterScript;
  llmCall?: LlmCall;
  webSearch?: WebSearchFn;
  now?: () => Date;
  initGit?: boolean;
}

export interface ScriptedAdapterHandle {
  adapter: CclAdapter;
  sayLog: string[];
  remaining: () => number;
  llmCallCount: () => number;
  webSearchCount: () => number;
}

export function buildScriptedAdapter(
  opts: BuildScriptedAdapterOptions,
): ScriptedAdapterHandle {
  const sayLog: string[] = [];
  const queue: Array<string | number> = [...opts.script.inputs];
  let llmCalls = 0;
  let webSearchCalls = 0;

  const defaultLlm: LlmCall = buildDefaultLlmCall();
  const llmCall: LlmCall = async (prompt, system) => {
    llmCalls += 1;
    return (opts.llmCall ?? defaultLlm)(prompt, system);
  };

  const baseWebSearch = opts.webSearch;
  const webSearch: WebSearchFn | undefined = baseWebSearch
    ? async (q) => {
        webSearchCalls += 1;
        return baseWebSearch(q);
      }
    : undefined;

  const adapter: CclAdapter = {
    cwd: opts.tmpDir,
    async ask() {
      const next = queue.shift();
      if (typeof next !== "string") {
        throw new Error(
          `script underrun: expected string (ask), got ${JSON.stringify(next)}`,
        );
      }
      return next;
    },
    async choose() {
      const next = queue.shift();
      if (typeof next !== "number") {
        throw new Error(
          `script underrun: expected number (choose), got ${JSON.stringify(next)}`,
        );
      }
      return next;
    },
    async say(msg) {
      sayLog.push(msg);
    },
    llmCall,
    now: opts.now ?? (() => new Date("2026-04-24T10:00:00.000Z")),
    runGitCommand: async () => 0,
    initGit: opts.initGit ?? true,
    ...(webSearch ? { webSearch } : {}),
  };

  return {
    adapter,
    sayLog,
    remaining: () => queue.length,
    llmCallCount: () => llmCalls,
    webSearchCount: () => webSearchCalls,
  };
}

export function buildDefaultLlmCall(reviewResponse: string = "{}"): LlmCall {
  return async (prompt) => {
    if (prompt.includes("Classify each skill")) {
      const names = [...prompt.matchAll(/^\s+-\s+(\S+)$/gm)].map((m) => m[1]!);
      return JSON.stringify(
        names.map((n) => ({
          skillName: n,
          procedural: true,
          externalIntegration: n === "deploy" || n === "run-migrations",
        })),
      );
    }
    if (prompt.startsWith("User said:")) {
      return reviewResponse;
    }
    return [
      "## When to use",
      "Trigger this skill when the situation applies.",
      "",
      "## Steps",
      "1. Do the thing.",
    ].join("\n");
  };
}

export function buildReviewLoopLlmCall(reviewResponses: string[]): {
  llmCall: LlmCall;
  reviewCallCount: () => number;
} {
  let reviewIdx = 0;
  const llmCall: LlmCall = async (prompt) => {
    if (prompt.includes("Classify each skill")) {
      const names = [...prompt.matchAll(/^\s+-\s+(\S+)$/gm)].map((m) => m[1]!);
      return JSON.stringify(
        names.map((n) => ({ skillName: n, procedural: true })),
      );
    }
    if (prompt.startsWith("User said:")) {
      const resp = reviewResponses[reviewIdx] ?? "{}";
      reviewIdx += 1;
      return resp;
    }
    return "## When to use\nDo the thing.";
  };
  return { llmCall, reviewCallCount: () => reviewIdx };
}

// ──────────────────────────────────────────────────────────────────────────
// Canonical scripted sequences — mirror Phase 5 prompt order in ccl.ts
// ──────────────────────────────────────────────────────────────────────────

export interface AutoDetectAnswers {
  skillMode: 0 | 1 | 2;
  reviewResponses: Array<string | number>;
  gitSync: 0 | 1;
  permission: 0 | 1;
  preSteps?: Array<string | number>;
}

export function autoDetectScript(
  a: AutoDetectAnswers,
): Array<string | number> {
  return [
    ...(a.preSteps ?? []),
    0, // greeting → auto-detect
    a.skillMode,
    ...a.reviewResponses,
    a.gitSync,
    a.permission,
  ];
}

export interface GuidedSetupAnswers {
  q1: string;
  q2: string;
  q3: string;
  q4: string;
  q5: string;
  skillMode: 0 | 1 | 2;
  reviewResponses: Array<string | number>;
  gitSync: 0 | 1;
  permission: 0 | 1;
  preSteps?: Array<string | number>;
}

export function guidedSetupScript(
  a: GuidedSetupAnswers,
): Array<string | number> {
  return [
    ...(a.preSteps ?? []),
    1, // greeting → guided
    a.q1,
    a.q2,
    a.q3,
    a.q4,
    a.q5,
    a.skillMode,
    ...a.reviewResponses,
    a.gitSync,
    a.permission,
  ];
}

// ──────────────────────────────────────────────────────────────────────────
// Filesystem mutation helpers
// ──────────────────────────────────────────────────────────────────────────

export function placeObstacleDir(dir: string, relPath: string): void {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, "placeholder"), "x", "utf8");
}

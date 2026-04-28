import { describe, it } from "node:test";
import nodeAssert from "node:assert/strict";

import {
  AGENT_READONLY_TOOLS,
  CLAUDE_MD_LINE_LIMIT,
  CLAUDEIGNORE_CONTENT,
  CCL_GITIGNORE_MARKER_END,
  CCL_GITIGNORE_MARKER_START,
  ClaudeMdTooLongError,
  InvalidAgentNameError,
  InvalidSkillNameError,
  addDays,
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
} from "../src/templates/index.js";
import { buildScaffoldPlan } from "../src/scaffold.js";
import type { DetectedProject } from "../src/detector.js";

const sampleClaudeMdCtx = {
  projectName: "auth-service",
  whatIsThis:
    "REST API that handles authentication for the mobile app. Issues JWTs, rotates refresh tokens, and brokers OAuth logins.",
  stack: ["Node.js 20", "TypeScript", "Fastify", "PostgreSQL", "Redis"],
  directories: [
    { dir: "src/", description: "API handlers, services, db layer" },
    { dir: "test/", description: "Vitest unit + integration tests" },
    { dir: "migrations/", description: "SQL migrations (node-pg-migrate)" },
  ],
  commands: {
    dev: "npm run dev",
    test: "npm test",
    build: "npm run build",
    lint: "npm run lint",
  },
  codingRules: [
    "No default exports",
    "Prefer `async/await` over raw promises",
    "All db access goes through the repository layer",
  ],
  testingPhilosophy:
    "Unit tests cover pure logic; integration tests run against a real Postgres in CI via docker-compose.",
  commonPitfalls: [
    "Do not call `bcrypt` on the hot path — use the worker pool",
  ],
  gotchas: [
    "`/auth/refresh` bypasses the rate limiter for legacy mobile clients — scheduled removal Q3",
  ],
  neverDo: [
    "Log plaintext passwords or tokens",
    "Bypass migrations via ad-hoc SQL in production",
  ],
};

describe("renderClaudeMd", () => {
  it("renders a file under the 200-line limit", () => {
    const out = renderClaudeMd(sampleClaudeMdCtx);
    const lines = out.split("\n").length;
    nodeAssert.ok(
      lines <= CLAUDE_MD_LINE_LIMIT,
      `expected ≤${CLAUDE_MD_LINE_LIMIT} lines, got ${lines}`,
    );
    nodeAssert.match(out, /^# auth-service\n/);
    nodeAssert.match(out, /## Behavioral guidelines/);
    nodeAssert.match(out, /npm run dev {6}# start dev server/);
  });

  it("throws when rendered output would exceed the 200-line limit", () => {
    const longRules = Array.from({ length: 300 }, (_, i) => `rule ${i}`);
    nodeAssert.throws(
      () => renderClaudeMd({ ...sampleClaudeMdCtx, codingRules: longRules }),
      ClaudeMdTooLongError,
    );
  });

  it("gracefully handles empty directory list", () => {
    const out = renderClaudeMd({ ...sampleClaudeMdCtx, directories: [] });
    nodeAssert.match(out, /_\(none inferred\)_/);
  });
});

describe("renderSkillMd", () => {
  it("renders valid frontmatter and sections", () => {
    const out = renderSkillMd({
      name: "deploy",
      description: "Trigger a staging deploy when the user says 'deploy'.",
      allowedTools: ["Read", "Bash"],
      steps: ["Run smoke tests", "Call deploy API", "Report status"],
      verification: ["Deploy API returns 200", "Health check passes"],
      references: ["https://internal.example.com/deploy-runbook"],
    });
    nodeAssert.match(out, /^---\nname: deploy\n/);
    nodeAssert.match(out, /allowed-tools: \[Read, Bash\]/);
    nodeAssert.match(out, /## Steps\n1\. Run smoke tests/);
  });

  it("rejects invalid skill names", () => {
    nodeAssert.throws(
      () =>
        renderSkillMd({
          name: "Bad Name",
          description: "x",
          allowedTools: [],
          steps: [],
          verification: [],
          references: [],
        }),
      InvalidSkillNameError,
    );
  });
});

describe("renderAgentMd", () => {
  it("renders valid agent frontmatter", () => {
    const out = renderAgentMd({
      name: "security-auditor",
      description: "Scan for secrets, unsafe deps, and dangerous shell usage.",
      model: "claude-haiku-4-5",
      tools: ["Read", "Grep", "Glob"],
      purpose: "Audit the repo for common security issues.",
      outputFormat: "JSON: { findings: [...], summary: string }",
      constraints: ["Read-only", "Returns JSON only"],
      role: "",
    });
    nodeAssert.match(out, /^---\nname: security-auditor\n/);
    nodeAssert.match(out, /model: claude-haiku-4-5/);
    nodeAssert.match(out, /## Purpose/);
  });

  it("rejects invalid agent names", () => {
    nodeAssert.throws(
      () =>
        renderAgentMd({
          name: "Bad_Name",
          description: "x",
          model: "claude-haiku-4-5",
          tools: [],
          purpose: "x",
          outputFormat: "x",
          constraints: [],
          role: "",
        }),
      InvalidAgentNameError,
    );
  });

  it("includes role in frontmatter when non-empty", () => {
    const out = renderAgentMd({
      name: "security-auditor",
      description: "d",
      model: "claude-haiku-4-5",
      tools: ["Read"],
      purpose: "p",
      outputFormat: "o",
      constraints: [],
      role: "You audit TypeScript code for vulnerabilities.",
    });
    nodeAssert.match(
      out,
      /role: You audit TypeScript code for vulnerabilities\./,
    );
  });

  it("omits role field entirely when empty", () => {
    const out = renderAgentMd({
      name: "security-auditor",
      description: "d",
      model: "claude-haiku-4-5",
      tools: ["Read"],
      purpose: "p",
      outputFormat: "o",
      constraints: [],
      role: "",
    });
    nodeAssert.doesNotMatch(out, /\nrole:/);
  });

  it("emits role after tools in frontmatter", () => {
    const out = renderAgentMd({
      name: "security-auditor",
      description: "d",
      model: "claude-haiku-4-5",
      tools: ["Read", "Grep"],
      purpose: "p",
      outputFormat: "o",
      constraints: [],
      role: "You audit TypeScript code.",
    });
    const toolsIdx = out.indexOf("tools:");
    const roleIdx = out.indexOf("role:");
    const endFrontmatter = out.indexOf("\n---", toolsIdx);
    nodeAssert.ok(toolsIdx >= 0 && roleIdx > toolsIdx);
    nodeAssert.ok(roleIdx < endFrontmatter, "role must be inside frontmatter");
  });
});

describe("validateAgentMd", () => {
  function buildAgent(overrides: {
    tools?: string[];
    purpose?: string;
    name?: string;
  }): string {
    return renderAgentMd({
      name: overrides.name ?? "test-agent",
      description: "d",
      model: "claude-haiku-4-5",
      tools: overrides.tools ?? ["Read"],
      purpose: overrides.purpose ?? "audit code",
      outputFormat: "JSON",
      constraints: [],
      role: "",
    });
  }

  it("accepts an agent declaring only Read + Grep", () => {
    const r = validateAgentMd(buildAgent({ tools: ["Read", "Grep"] }));
    nodeAssert.equal(r.valid, true);
    nodeAssert.deepEqual(r.violations, []);
  });

  it("rejects tools: [Write] with a violation that mentions Write", () => {
    const r = validateAgentMd(buildAgent({ tools: ["Write"] }));
    nodeAssert.equal(r.valid, false);
    nodeAssert.ok(
      r.violations.some((v) => v.includes("Write")),
      `violations should mention "Write": ${JSON.stringify(r.violations)}`,
    );
  });

  it("rejects tools: [Bash] with a violation that mentions Bash", () => {
    const r = validateAgentMd(buildAgent({ tools: ["Bash"] }));
    nodeAssert.equal(r.valid, false);
    nodeAssert.ok(r.violations.some((v) => v.includes("Bash")));
  });

  it("rejects mixed tools [Read, Write] — flags Write but not Read", () => {
    const r = validateAgentMd(buildAgent({ tools: ["Read", "Write"] }));
    nodeAssert.equal(r.valid, false);
    nodeAssert.equal(r.violations.length, 1);
    nodeAssert.ok(r.violations[0]!.includes("Write"));
    nodeAssert.ok(!r.violations[0]!.includes("'Read'"));
  });

  it("accepts the full read-only allowlist [WebFetch, Glob, LS]", () => {
    const r = validateAgentMd(buildAgent({ tools: ["WebFetch", "Glob", "LS"] }));
    nodeAssert.equal(r.valid, true);
    nodeAssert.deepEqual(r.violations, []);
  });

  it("rejects shell tokens inside the ## Purpose body", () => {
    const r = validateAgentMd(
      buildAgent({ purpose: "Audit using curl to fetch data" }),
    );
    nodeAssert.equal(r.valid, false);
    nodeAssert.ok(
      r.violations.some(
        (v) => v.includes("shell token") && v.includes("curl"),
      ),
      `violations should report a shell token: ${JSON.stringify(r.violations)}`,
    );
  });

  it("returns valid when frontmatter has no tools field", () => {
    const content = [
      "---",
      "name: test-agent",
      "description: d",
      "model: claude-haiku-4-5",
      "---",
      "",
      "## Purpose",
      "audit code",
      "",
    ].join("\n");
    const r = validateAgentMd(content);
    nodeAssert.equal(r.valid, true);
    nodeAssert.deepEqual(r.violations, []);
  });

  it("returns valid for malformed YAML frontmatter without throwing", () => {
    const content = [
      "---",
      "tools: [unclosed",
      "description: d",
      "---",
      "",
      "## Purpose",
      "audit",
      "",
    ].join("\n");
    let r: ReturnType<typeof validateAgentMd>;
    nodeAssert.doesNotThrow(() => {
      r = validateAgentMd(content);
    });
    nodeAssert.equal(r!.valid, true);
    nodeAssert.deepEqual(r!.violations, []);
  });

  it("returns valid for empty string input without throwing", () => {
    let r: ReturnType<typeof validateAgentMd>;
    nodeAssert.doesNotThrow(() => {
      r = validateAgentMd("");
    });
    nodeAssert.equal(r!.valid, true);
    nodeAssert.deepEqual(r!.violations, []);
  });

  it("returns valid for null input without throwing", () => {
    let r: ReturnType<typeof validateAgentMd>;
    nodeAssert.doesNotThrow(() => {
      r = (validateAgentMd as (x: unknown) => ReturnType<typeof validateAgentMd>)(
        null,
      );
    });
    nodeAssert.equal(r!.valid, true);
    nodeAssert.deepEqual(r!.violations, []);
  });

  it("AGENT_READONLY_TOOLS matches the documented allowlist", () => {
    nodeAssert.deepEqual(
      [...AGENT_READONLY_TOOLS].sort(),
      ["Glob", "Grep", "LS", "Read", "WebFetch"],
    );
  });

  it("treats YAML implicit booleans (yes/true/on) in tools as literal strings under failsafe schema", () => {
    const content = [
      "---",
      "name: test-agent",
      "description: d",
      "model: claude-haiku-4-5",
      "tools: [yes, true, on]",
      "---",
      "",
      "## Purpose",
      "audit code",
      "",
    ].join("\n");
    let r: ReturnType<typeof validateAgentMd>;
    nodeAssert.doesNotThrow(() => {
      r = validateAgentMd(content);
    });
    nodeAssert.equal(r!.valid, false);
    nodeAssert.ok(
      r!.violations.some(
        (v) =>
          v.includes("'yes'") || v.includes("'true'") || v.includes("'on'"),
      ),
      `expected an unrecognised-tool violation for yes/true/on: ${JSON.stringify(r!.violations)}`,
    );
  });

  it("does not throw on YAML merge keys (<<: *anchor) under failsafe schema", () => {
    const content = [
      "---",
      "anchor: &a",
      "  k: v",
      "name: test-agent",
      "description: d",
      "model: claude-haiku-4-5",
      "tools: [Read]",
      "extra:",
      "  <<: *a",
      "  k2: v2",
      "---",
      "",
      "## Purpose",
      "audit code",
      "",
    ].join("\n");
    let r: ReturnType<typeof validateAgentMd>;
    nodeAssert.doesNotThrow(() => {
      r = validateAgentMd(content);
    });
    nodeAssert.equal(typeof r!.valid, "boolean");
    nodeAssert.ok(Array.isArray(r!.violations));
  });

  it("returns valid for YAML type tags (!!python/object, !!js/undefined) without throwing under failsafe schema", () => {
    const content = [
      "---",
      "name: test-agent",
      "description: !!python/object 'x'",
      "model: claude-haiku-4-5",
      "tools: [Read]",
      "---",
      "",
      "## Purpose",
      "audit code",
      "",
    ].join("\n");
    let r: ReturnType<typeof validateAgentMd>;
    nodeAssert.doesNotThrow(() => {
      r = validateAgentMd(content);
    });
    nodeAssert.equal(r!.valid, true);
    nodeAssert.deepEqual(r!.violations, []);
  });
});

describe("renderSettingsJson", () => {
  it("produces parseable JSON with expected shape", () => {
    const out = renderSettingsJson(defaultSettingsContext());
    const parsed = JSON.parse(out) as {
      permissions: { allow: string[]; deny: string[] };
      hooks: {
        PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
        PostToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
      };
    };
    nodeAssert.ok(parsed.permissions.allow.includes("Read"));
    nodeAssert.ok(parsed.permissions.deny.includes("Bash(rm -rf:*)"));
    nodeAssert.equal(parsed.hooks.PreToolUse[0]!.matcher, "Bash");
    nodeAssert.equal(parsed.hooks.PreToolUse[0]!.hooks[0]!.command, "ccl-validate-bash");
    nodeAssert.equal(parsed.hooks.PostToolUse[0]!.hooks[0]!.command, "ccl-audit-write");
  });
});

describe("renderClaudeignore", () => {
  it("matches the canonical content", () => {
    nodeAssert.equal(renderClaudeignore(), CLAUDEIGNORE_CONTENT);
    nodeAssert.match(renderClaudeignore(), /\.claude\/ccl-practices\.json/);
    nodeAssert.match(renderClaudeignore(), /\.claude\/ccl-state\.json/);
  });
});

describe("renderPracticesJson", () => {
  it("serializes the default context with a 7-day next check", () => {
    const now = new Date("2026-04-24T10:00:00.000Z");
    const ctx = defaultPracticesContext(now);
    const out = renderPracticesJson(ctx);
    const parsed = JSON.parse(out) as {
      version: string;
      last_updated: string;
      next_check_due: string;
      practices: Array<{ id: string; title: string }>;
      archived_versions: unknown[];
    };
    nodeAssert.equal(parsed.version, "1.0");
    nodeAssert.equal(parsed.last_updated, "2026-04-24T10:00:00.000Z");
    nodeAssert.equal(parsed.next_check_due, "2026-05-01T10:00:00.000Z");
    nodeAssert.equal(parsed.practices[0]!.id, "bp-001");
    nodeAssert.deepEqual(parsed.archived_versions, []);
  });

  it("includes the 'refresh: never' flag when set", () => {
    const ctx = defaultPracticesContext(new Date("2026-04-24T10:00:00.000Z"));
    ctx.refresh = "never";
    const parsed = JSON.parse(renderPracticesJson(ctx)) as { refresh?: string };
    nodeAssert.equal(parsed.refresh, "never");
  });

  it("addDays is pure and correct", () => {
    nodeAssert.equal(
      addDays("2026-04-24T10:00:00.000Z", 7),
      "2026-05-01T10:00:00.000Z",
    );
  });
});

describe("renderStateJson", () => {
  it("includes last_completed_step + remaining_steps only while in_progress", () => {
    const ctx = initialStateContext({
      projectName: "auth-service",
      projectType: "rest-api",
      steps: ["CLAUDE.md", "settings.json", "skills/deploy"],
      gitSync: true,
      now: new Date("2026-04-24T10:00:00.000Z"),
    });
    const parsed = JSON.parse(renderStateJson(ctx)) as Record<string, unknown>;
    nodeAssert.equal(parsed["status"], "in_progress");
    nodeAssert.deepEqual(parsed["remaining_steps"], [
      "CLAUDE.md",
      "settings.json",
      "skills/deploy",
    ]);

    ctx.status = "complete";
    ctx.completedAt = "2026-04-24T10:02:00.000Z";
    const done = JSON.parse(renderStateJson(ctx)) as Record<string, unknown>;
    nodeAssert.equal(done["status"], "complete");
    nodeAssert.equal(done["remaining_steps"], undefined);
    nodeAssert.equal(done["last_completed_step"], undefined);
  });
});

describe("renderGitignoreAdditions", () => {
  it("excludes ccl-state.json when user opts out of git sync", () => {
    const out = renderGitignoreAdditions({ syncStateToGit: false });
    nodeAssert.match(out, /\.claude\/settings\.local\.json/);
    nodeAssert.match(out, /\.claude\/ccl-state\.json/);
    nodeAssert.ok(out.startsWith(CCL_GITIGNORE_MARKER_START));
    nodeAssert.ok(out.trimEnd().endsWith(CCL_GITIGNORE_MARKER_END));
  });

  it("keeps ccl-state.json tracked when user opts in", () => {
    const out = renderGitignoreAdditions({ syncStateToGit: true });
    nodeAssert.match(out, /\.claude\/settings\.local\.json/);
    nodeAssert.doesNotMatch(out, /\.claude\/ccl-state\.json/);
  });

  it("always includes .claude/settings.local.json regardless of gitSync", () => {
    nodeAssert.match(
      renderGitignoreAdditions({ syncStateToGit: true }),
      /\.claude\/settings\.local\.json/,
    );
    nodeAssert.match(
      renderGitignoreAdditions({ syncStateToGit: false }),
      /\.claude\/settings\.local\.json/,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// settings.local.json template + scaffold plan wiring
// ──────────────────────────────────────────────────────────────────────────

describe("renderSettingsLocalJson", () => {
  it("returns an empty JSON object with a trailing newline", () => {
    nodeAssert.equal(renderSettingsLocalJson(), "{}\n");
  });
});

describe("scaffold plan includes settings.local.json", () => {
  const detected: DetectedProject = {
    rootDir: "/tmp/sample",
    projectName: "sample",
    projectType: "library",
    language: "typescript",
    stack: ["TypeScript"],
    commands: {
      dev: "npm run dev",
      test: "npm test",
      build: "npm run build",
      lint: "npm run lint",
    },
    directories: [],
    readmeSnippet: null,
    extraDocs: [],
    existingCcl: { hasClaudeMd: false, hasClaudeDir: false, practices: null },
    findings: {
      manifests: [],
      hasReadme: false,
      hasDockerfile: false,
      hasEnvExample: false,
      hasCiConfig: false,
      isMonorepo: false,
    },
  };

  it("adds a settings.local.json step immediately after settings.json", async () => {
    const plan = await buildScaffoldPlan({
      detected,
      gitSync: true,
      now: new Date("2026-04-24T10:00:00.000Z"),
    });
    const paths = plan.files.map((f) => f.path);
    const settingsIdx = paths.indexOf(".claude/settings.json");
    const localIdx = paths.indexOf(".claude/settings.local.json");
    nodeAssert.ok(settingsIdx >= 0, "settings.json step present");
    nodeAssert.equal(
      localIdx,
      settingsIdx + 1,
      "settings.local.json must immediately follow settings.json",
    );

    const localStep = plan.files[localIdx]!;
    nodeAssert.equal(localStep.action, "write");
    nodeAssert.equal(localStep.stepName, "settings.local.json");
    nodeAssert.equal(localStep.content, "{}\n");
  });

  for (const gitSync of [true, false] as const) {
    it(`gitignore block includes settings.local.json when gitSync=${gitSync}`, async () => {
      const plan = await buildScaffoldPlan({
        detected,
        gitSync,
        now: new Date("2026-04-24T10:00:00.000Z"),
      });
      const gitignore = plan.files.find((f) => f.path === ".gitignore")!;
      nodeAssert.match(gitignore.content, /\.claude\/settings\.local\.json/);
    });
  }
});

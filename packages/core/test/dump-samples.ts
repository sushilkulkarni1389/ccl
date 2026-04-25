import {
  defaultPracticesContext,
  defaultSettingsContext,
  initialStateContext,
  renderAgentMd,
  renderClaudeMd,
  renderClaudeignore,
  renderGitignoreAdditions,
  renderPracticesJson,
  renderSettingsJson,
  renderSkillMd,
  renderStateJson,
} from "../src/templates/index.js";

const SAMPLE_DATE = new Date("2026-04-24T10:00:00.000Z");

function banner(title: string): void {
  console.log("\n" + "=".repeat(60));
  console.log(" " + title);
  console.log("=".repeat(60));
}

banner("CLAUDE.md");
console.log(
  renderClaudeMd({
    projectName: "auth-service",
    whatIsThis:
      "REST API that issues JWTs and brokers OAuth logins for the mobile app.",
    stack: ["Node.js 20", "TypeScript", "Fastify", "PostgreSQL"],
    directories: [
      { dir: "src/", description: "API handlers, services, db layer" },
      { dir: "test/", description: "Vitest unit + integration tests" },
      { dir: "migrations/", description: "SQL migrations" },
    ],
    commands: {
      dev: "npm run dev",
      test: "npm test",
      build: "npm run build",
      lint: "npm run lint",
    },
    codingRules: [
      "No default exports",
      "All db access goes through the repository layer",
    ],
    testingPhilosophy:
      "Unit tests cover pure logic; integration tests run against real Postgres in CI.",
    commonPitfalls: ["Do not call bcrypt on the hot path — use the worker pool"],
    gotchas: [
      "/auth/refresh bypasses the rate limiter for legacy mobile clients",
    ],
    neverDo: ["Log plaintext passwords or tokens"],
  }),
);

banner("skills/deploy/SKILL.md");
console.log(
  renderSkillMd({
    name: "deploy",
    description: "Trigger a staging deploy when the user says 'deploy'.",
    allowedTools: ["Read", "Bash"],
    steps: ["Run smoke tests", "Call deploy API", "Report status"],
    verification: ["Deploy API returns 200", "Health check passes"],
    references: ["https://internal.example.com/deploy-runbook"],
  }),
);

banner("agents/security-auditor.md");
console.log(
  renderAgentMd({
    name: "security-auditor",
    description: "Scan the repo for secrets, unsafe deps, and shell usage.",
    model: "claude-haiku-4-5",
    tools: ["Read", "Grep", "Glob"],
    purpose: "Audit the repo for common security issues before release.",
    outputFormat: "JSON: { findings: [...], summary: string }",
    constraints: [
      "Read-only — no file writes",
      "Returns structured JSON only",
      "Scope: src/** and package.json",
    ],
    role: "You audit TypeScript with Fastify code for vulnerabilities, misconfigurations, and insecure patterns. You identify vulnerabilities precisely and never speculate beyond what the code shows.",
  }),
);

banner(".claude/settings.json");
console.log(renderSettingsJson(defaultSettingsContext()));

banner(".claudeignore");
console.log(renderClaudeignore());

banner(".claude/ccl-practices.json");
console.log(renderPracticesJson(defaultPracticesContext(SAMPLE_DATE)));

banner(".claude/ccl-state.json");
console.log(
  renderStateJson(
    initialStateContext({
      projectName: "auth-service",
      projectType: "rest-api",
      steps: ["CLAUDE.md", "settings.json", "skills/deploy", "agents/security-auditor"],
      gitSync: true,
      now: SAMPLE_DATE,
    }),
  ),
);

banner(".gitignore additions (state NOT synced)");
console.log(renderGitignoreAdditions({ syncStateToGit: false }));

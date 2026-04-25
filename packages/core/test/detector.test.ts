import { describe, it, before, after } from "node:test";
import nodeAssert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectProject } from "../src/detector.js";

async function mkFixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ccl-detector-"));
}

async function write(root: string, rel: string, body: string): Promise<void> {
  const full = join(root, rel);
  const dir = full.slice(0, full.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(full, body, "utf8");
}

describe("detectProject — Node/TypeScript web app", () => {
  let root: string;
  before(async () => {
    root = await mkFixture();
    await write(
      root,
      "package.json",
      JSON.stringify({
        name: "my-web",
        scripts: {
          dev: "next dev",
          test: "vitest",
          build: "next build",
          lint: "eslint .",
        },
        dependencies: { next: "^14.0.0", react: "^18.0.0" },
        devDependencies: { typescript: "^5.0.0", vitest: "^1.0.0", tailwindcss: "^3.0.0" },
      }),
    );
    await write(root, "tsconfig.json", "{}");
    await write(root, "README.md", "# my-web\n\nA Next.js app for customer dashboards.\n");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "test"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("identifies name, language, type, and stack", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.projectName, "my-web");
    nodeAssert.equal(r.language, "typescript");
    nodeAssert.equal(r.projectType, "web-app");
    nodeAssert.ok(r.stack.includes("Node.js"));
    nodeAssert.ok(r.stack.includes("TypeScript"));
    nodeAssert.ok(r.stack.includes("Next.js"));
    nodeAssert.ok(r.stack.includes("React"));
    nodeAssert.ok(r.stack.includes("Tailwind CSS"));
    nodeAssert.ok(r.stack.includes("Vitest"));
  });

  it("uses package.json scripts for commands", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.commands.dev, "npm run dev");
    nodeAssert.equal(r.commands.test, "npm run test");
    nodeAssert.equal(r.commands.build, "npm run build");
    nodeAssert.equal(r.commands.lint, "npm run lint");
  });

  it("surfaces src/ and test/ as known dirs and ignores node_modules", async () => {
    const r = await detectProject(root);
    const names = r.directories.map((d) => d.dir);
    nodeAssert.ok(names.includes("src/"));
    nodeAssert.ok(names.includes("test/"));
    nodeAssert.ok(!names.includes("node_modules/"));
  });

  it("extracts README snippet skipping heading", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.readmeSnippet, "A Next.js app for customer dashboards.");
  });

  it("reports no existing CCL scaffold", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.existingCcl.hasClaudeMd, false);
    nodeAssert.equal(r.existingCcl.hasClaudeDir, false);
    nodeAssert.equal(r.existingCcl.practices, null);
  });
});

describe("detectProject — Node REST API (Fastify)", () => {
  let root: string;
  before(async () => {
    root = await mkFixture();
    await write(
      root,
      "package.json",
      JSON.stringify({
        name: "auth-service",
        scripts: { start: "node dist/index.js", test: "vitest" },
        dependencies: { fastify: "^4.0.0", "@prisma/client": "^5.0.0", pg: "^8.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      }),
    );
    await write(root, "tsconfig.json", "{}");
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("classifies as rest-api with Fastify + Prisma + PostgreSQL", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.projectType, "rest-api");
    nodeAssert.ok(r.stack.includes("Fastify"));
    nodeAssert.ok(r.stack.includes("Prisma"));
    nodeAssert.ok(r.stack.includes("PostgreSQL"));
  });

  it("falls back to 'start' script when 'dev' is missing", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.commands.dev, "npm run start");
    nodeAssert.equal(r.commands.build, "npm run build");
  });
});

describe("detectProject — monorepo via workspaces", () => {
  let root: string;
  before(async () => {
    root = await mkFixture();
    await write(
      root,
      "package.json",
      JSON.stringify({
        name: "my-monorepo",
        workspaces: ["packages/*"],
        devDependencies: { typescript: "^5.0.0" },
      }),
    );
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("sets projectType=monorepo", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.projectType, "monorepo");
    nodeAssert.equal(r.findings.isMonorepo, true);
  });
});

describe("detectProject — Python FastAPI", () => {
  let root: string;
  before(async () => {
    root = await mkFixture();
    await write(
      root,
      "pyproject.toml",
      `[project]
name = "ingest"
version = "0.1.0"
dependencies = ["fastapi>=0.110", "pydantic>=2", "sqlalchemy>=2"]
`,
    );
    await mkdir(join(root, "tests"), { recursive: true });
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("identifies Python REST API with FastAPI + Pydantic + SQLAlchemy", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.projectName, "ingest");
    nodeAssert.equal(r.language, "python");
    nodeAssert.equal(r.projectType, "rest-api");
    nodeAssert.ok(r.stack.includes("Python"));
    nodeAssert.ok(r.stack.includes("FastAPI"));
    nodeAssert.ok(r.stack.includes("Pydantic"));
    nodeAssert.ok(r.stack.includes("SQLAlchemy"));
    nodeAssert.equal(r.commands.test, "pytest");
    nodeAssert.equal(r.commands.lint, "ruff check .");
  });
});

describe("detectProject — Go module", () => {
  let root: string;
  before(async () => {
    root = await mkFixture();
    await write(
      root,
      "go.mod",
      "module github.com/example/datapipe\n\ngo 1.22\n",
    );
    await mkdir(join(root, "cmd"), { recursive: true });
    await mkdir(join(root, "pkg"), { recursive: true });
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("extracts module basename and Go version", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.projectName, "datapipe");
    nodeAssert.equal(r.language, "go");
    nodeAssert.ok(r.stack.includes("Go 1.22"));
    nodeAssert.equal(r.commands.test, "go test ./...");
    const dirs = r.directories.map((d) => d.dir);
    nodeAssert.ok(dirs.includes("cmd/"));
    nodeAssert.ok(dirs.includes("pkg/"));
  });
});

describe("detectProject — Rust workspace with Axum", () => {
  let root: string;
  before(async () => {
    root = await mkFixture();
    await write(
      root,
      "Cargo.toml",
      `[package]
name = "api-gateway"
version = "0.1.0"

[workspace]
members = ["crates/*"]

[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
serde = "1"
`,
    );
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("classifies as monorepo with Axum + Tokio + Serde", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.projectName, "api-gateway");
    nodeAssert.equal(r.language, "rust");
    nodeAssert.equal(r.projectType, "monorepo");
    nodeAssert.ok(r.stack.includes("Rust"));
    nodeAssert.ok(r.stack.includes("Axum"));
    nodeAssert.ok(r.stack.includes("Tokio"));
    nodeAssert.ok(r.stack.includes("Serde"));
  });
});

describe("detectProject — Flutter mobile app", () => {
  let root: string;
  before(async () => {
    root = await mkFixture();
    await write(
      root,
      "pubspec.yaml",
      `name: mobile_app
description: Customer-facing mobile app.

dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0
`,
    );
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("classifies as mobile-app with Flutter", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.projectType, "mobile-app");
    nodeAssert.equal(r.language, "dart");
    nodeAssert.ok(r.stack.includes("Flutter"));
    nodeAssert.equal(r.commands.dev, "flutter run");
  });
});

describe("detectProject — existing CCL scaffold", () => {
  let root: string;
  before(async () => {
    root = await mkFixture();
    await write(root, "package.json", JSON.stringify({ name: "x" }));
    await write(root, "CLAUDE.md", "# x\n");
    await write(
      root,
      ".claude/ccl-practices.json",
      JSON.stringify({
        version: "1.2",
        last_updated: "2026-04-21T10:00:00.000Z",
        last_checked: "2026-04-21T10:00:00.000Z",
        next_check_due: "2026-04-28T10:00:00.000Z",
        practices: [],
        archived_versions: [],
      }),
    );
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports existing scaffold and parses practices metadata", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.existingCcl.hasClaudeMd, true);
    nodeAssert.equal(r.existingCcl.hasClaudeDir, true);
    nodeAssert.deepEqual(r.existingCcl.practices, {
      version: "1.2",
      lastUpdatedIso: "2026-04-21T10:00:00.000Z",
    });
  });
});

describe("detectProject — empty directory", () => {
  let root: string;
  before(async () => {
    root = await mkFixture();
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns defaults without crashing", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.language, "unknown");
    nodeAssert.equal(r.projectType, "unknown");
    nodeAssert.deepEqual(r.stack, []);
    nodeAssert.equal(r.findings.manifests.length, 0);
    nodeAssert.equal(r.readmeSnippet, null);
  });

  it("throws when root does not exist", async () => {
    await nodeAssert.rejects(
      () => detectProject(join(root, "does-not-exist")),
      /does not exist/,
    );
  });
});

describe("detectProject — CI + Docker + env.example findings", () => {
  let root: string;
  before(async () => {
    root = await mkFixture();
    await write(root, "package.json", JSON.stringify({ name: "x" }));
    await write(root, "Dockerfile", "FROM node:20\n");
    await write(root, ".env.example", "DATABASE_URL=\n");
    await write(root, ".github/workflows/ci.yml", "name: ci\n");
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports all findings true", async () => {
    const r = await detectProject(root);
    nodeAssert.equal(r.findings.hasDockerfile, true);
    nodeAssert.equal(r.findings.hasEnvExample, true);
    nodeAssert.equal(r.findings.hasCiConfig, true);
  });
});

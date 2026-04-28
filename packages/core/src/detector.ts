import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import * as toml from "smol-toml";
import * as yaml from "yaml";

import { validateScaffoldOverrides } from "./override-validator.js";
import type {
  DirectoryEntry,
  ProjectCommands,
} from "./templates/types.js";

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "dart"
  | "unknown";

export type ProjectType =
  | "web-app"
  | "rest-api"
  | "cli"
  | "library"
  | "monorepo"
  | "mobile-app"
  | "data-pipeline"
  | "unknown";

export interface ExtraDoc {
  filename: string;
  content: string;
}

export interface DetectedProject {
  rootDir: string;
  projectName: string;
  projectType: ProjectType;
  language: Language;
  stack: string[];
  commands: ProjectCommands;
  directories: DirectoryEntry[];
  readmeSnippet: string | null;
  extraDocs: ExtraDoc[];
  existingCcl: ExistingCcl;
  findings: Findings;
}

export interface ExistingCcl {
  hasClaudeMd: boolean;
  hasClaudeDir: boolean;
  practices: {
    version: string;
    lastUpdatedIso: string;
  } | null;
}

export interface Findings {
  manifests: string[];
  hasReadme: boolean;
  hasDockerfile: boolean;
  hasEnvExample: boolean;
  hasCiConfig: boolean;
  isMonorepo: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Constants: friendly-name maps + directory descriptions
// ────────────────────────────────────────────────────────────────────────────

interface StackSignal {
  dep: string;
  label: string;
}

const JS_STACK_SIGNALS: StackSignal[] = [
  { dep: "next", label: "Next.js" },
  { dep: "react", label: "React" },
  { dep: "vue", label: "Vue" },
  { dep: "svelte", label: "Svelte" },
  { dep: "@sveltejs/kit", label: "SvelteKit" },
  { dep: "astro", label: "Astro" },
  { dep: "fastify", label: "Fastify" },
  { dep: "express", label: "Express" },
  { dep: "@nestjs/core", label: "NestJS" },
  { dep: "hono", label: "Hono" },
  { dep: "@prisma/client", label: "Prisma" },
  { dep: "drizzle-orm", label: "Drizzle ORM" },
  { dep: "pg", label: "PostgreSQL" },
  { dep: "mongodb", label: "MongoDB" },
  { dep: "ioredis", label: "Redis" },
  { dep: "tailwindcss", label: "Tailwind CSS" },
  { dep: "vitest", label: "Vitest" },
  { dep: "jest", label: "Jest" },
];

const PY_STACK_SIGNALS: StackSignal[] = [
  { dep: "fastapi", label: "FastAPI" },
  { dep: "django", label: "Django" },
  { dep: "flask", label: "Flask" },
  { dep: "starlette", label: "Starlette" },
  { dep: "pydantic", label: "Pydantic" },
  { dep: "sqlalchemy", label: "SQLAlchemy" },
  { dep: "pytest", label: "pytest" },
];

const RUST_STACK_SIGNALS: StackSignal[] = [
  { dep: "axum", label: "Axum" },
  { dep: "actix-web", label: "Actix Web" },
  { dep: "rocket", label: "Rocket" },
  { dep: "tokio", label: "Tokio" },
  { dep: "serde", label: "Serde" },
];

const JS_FRONTEND_MARKERS = new Set([
  "next",
  "react",
  "vue",
  "svelte",
  "@sveltejs/kit",
  "astro",
  "vite",
]);

const JS_API_MARKERS = new Set([
  "fastify",
  "express",
  "@nestjs/core",
  "hono",
  "koa",
]);

const PY_API_MARKERS = new Set(["fastapi", "django", "flask", "starlette"]);
const RUST_API_MARKERS = new Set(["axum", "actix-web", "rocket"]);

const KNOWN_DIRS: Record<string, string> = {
  src: "Source code",
  lib: "Library code",
  app: "Application code",
  test: "Tests",
  tests: "Tests",
  __tests__: "Tests",
  spec: "Specs / tests",
  cmd: "Entry points",
  pkg: "Shared packages",
  internal: "Internal (non-exported) packages",
  migrations: "Database migrations",
  public: "Static assets",
  static: "Static assets",
  assets: "Assets",
  pages: "Page routes",
  routes: "Route handlers",
  components: "UI components",
  hooks: "React hooks",
  scripts: "Build and dev scripts",
  docs: "Documentation",
  examples: "Examples",
  packages: "Monorepo packages",
  apps: "Monorepo applications",
  server: "Server-side code",
  client: "Client-side code",
};

const IGNORED_TOP_LEVEL_DIRS = new Set([
  ".git",
  ".github",
  ".gitlab",
  ".vscode",
  ".idea",
  ".claude",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  ".turbo",
  ".cache",
]);

// ────────────────────────────────────────────────────────────────────────────
// Doc-based stack keyword list (exported for use in scaffold.ts)
// ────────────────────────────────────────────────────────────────────────────

export interface DocStackKeyword {
  keyword: string;
  label: string;
}

export const DOC_STACK_KEYWORDS: DocStackKeyword[] = [
  // Languages
  { keyword: "typescript", label: "TypeScript" },
  { keyword: "javascript", label: "JavaScript" },
  { keyword: "python", label: "Python" },
  { keyword: "golang", label: "Go" },
  { keyword: "rust", label: "Rust" },
  { keyword: "flutter", label: "Flutter" },
  { keyword: "dart", label: "Dart" },
  // Node / JS ecosystem
  { keyword: "node.js", label: "Node.js" },
  { keyword: "nodejs", label: "Node.js" },
  { keyword: "next.js", label: "Next.js" },
  { keyword: "nextjs", label: "Next.js" },
  { keyword: "react", label: "React" },
  { keyword: "vue.js", label: "Vue" },
  { keyword: "vuejs", label: "Vue" },
  { keyword: "svelte", label: "Svelte" },
  { keyword: "sveltekit", label: "SvelteKit" },
  { keyword: "astro", label: "Astro" },
  { keyword: "fastify", label: "Fastify" },
  { keyword: "express.js", label: "Express" },
  { keyword: "expressjs", label: "Express" },
  { keyword: "nestjs", label: "NestJS" },
  { keyword: "nest.js", label: "NestJS" },
  { keyword: "hono", label: "Hono" },
  { keyword: "prisma", label: "Prisma" },
  { keyword: "drizzle orm", label: "Drizzle ORM" },
  { keyword: "tailwind css", label: "Tailwind CSS" },
  { keyword: "tailwindcss", label: "Tailwind CSS" },
  { keyword: "vitest", label: "Vitest" },
  { keyword: "jest", label: "Jest" },
  // Python ecosystem
  { keyword: "fastapi", label: "FastAPI" },
  { keyword: "django", label: "Django" },
  { keyword: "flask", label: "Flask" },
  { keyword: "starlette", label: "Starlette" },
  { keyword: "pydantic", label: "Pydantic" },
  { keyword: "sqlalchemy", label: "SQLAlchemy" },
  { keyword: "pytest", label: "pytest" },
  // Rust ecosystem
  { keyword: "axum", label: "Axum" },
  { keyword: "actix-web", label: "Actix Web" },
  { keyword: "actix web", label: "Actix Web" },
  { keyword: "tokio", label: "Tokio" },
  { keyword: "serde", label: "Serde" },
  // Databases
  { keyword: "postgresql", label: "PostgreSQL" },
  { keyword: "postgres", label: "PostgreSQL" },
  { keyword: "mongodb", label: "MongoDB" },
  { keyword: "redis", label: "Redis" },
  { keyword: "mysql", label: "MySQL" },
  { keyword: "sqlite", label: "SQLite" },
  { keyword: "elasticsearch", label: "Elasticsearch" },
  { keyword: "kafka", label: "Kafka" },
  { keyword: "rabbitmq", label: "RabbitMQ" },
  // Cloud / infra
  { keyword: "docker", label: "Docker" },
  { keyword: "kubernetes", label: "Kubernetes" },
  { keyword: "graphql", label: "GraphQL" },
  { keyword: "grpc", label: "gRPC" },
  { keyword: "amazon web services", label: "AWS" },
  { keyword: "google cloud platform", label: "GCP" },
  { keyword: "google cloud", label: "GCP" },
  { keyword: "azure", label: "Azure" },
];

// ────────────────────────────────────────────────────────────────────────────
// Stack label → project type fallback map
//
// Used when inferProjectType() returns "unknown" (no recognised manifest
// dependencies) but stack labels derived from docs identify a framework.
// Keys are lowercase; values must match ProjectType exactly.
// Precedence order when multiple types match: rest-api > web-app > cli > library
// ────────────────────────────────────────────────────────────────────────────

export const STACK_LABEL_PROJECT_TYPE_MAP: Record<string, ProjectType> = {
  // REST API frameworks
  fastify: "rest-api",
  express: "rest-api",
  nestjs: "rest-api",
  "nest.js": "rest-api",
  hapi: "rest-api",
  koa: "rest-api",
  hono: "rest-api",
  django: "rest-api",
  fastapi: "rest-api",
  flask: "rest-api",
  starlette: "rest-api",
  rails: "rest-api",
  "spring boot": "rest-api",
  "asp.net": "rest-api",
  gin: "rest-api",
  fiber: "rest-api",
  actix: "rest-api",
  "actix web": "rest-api",
  axum: "rest-api",
  // Web app frameworks
  react: "web-app",
  "next.js": "web-app",
  nextjs: "web-app",
  vue: "web-app",
  "vue.js": "web-app",
  nuxt: "web-app",
  angular: "web-app",
  svelte: "web-app",
  sveltekit: "web-app",
  remix: "web-app",
  gatsby: "web-app",
  astro: "web-app",
  // CLI libraries
  commander: "cli",
  yargs: "cli",
  click: "cli",
  cobra: "cli",
  clap: "cli",
  oclif: "cli",
  // Library bundlers
  rollup: "library",
  tsup: "library",
  microbundle: "library",
};

const PROJECT_TYPE_PRECEDENCE: ProjectType[] = [
  "rest-api",
  "web-app",
  "cli",
  "library",
];

// ────────────────────────────────────────────────────────────────────────────
// Extra-doc scanner (freeform markdown docs beyond README)
// ────────────────────────────────────────────────────────────────────────────

const EXTRA_DOC_PRIORITY_NAMES = [
  "ARCHITECTURE.md",
  "ARCHITECTURE.MD",
  "CONTRIBUTING.md",
  "DESIGN.md",
  "SPEC.md",
  "OVERVIEW.md",
];

const README_FILE_NAMES = new Set([
  "README.md",
  "README.MD",
  "readme.md",
  "README",
]);

function truncateAtLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  return lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
}

async function readExtraDocs(root: string): Promise<ExtraDoc[]> {
  const SKIP_DIRS = new Set([".git", ".claude"]);

  async function collectPaths(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const results: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          const sub = await collectPaths(join(dir, entry.name));
          results.push(...sub);
        }
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        results.push(join(dir, entry.name));
      }
    }
    return results;
  }

  let allPaths: string[];
  try {
    allPaths = await collectPaths(root);
  } catch {
    return [];
  }

  const candidates = allPaths.filter((p) => !README_FILE_NAMES.has(basename(p)));

  const priorityIndex = new Map(EXTRA_DOC_PRIORITY_NAMES.map((name, i) => [name, i]));
  candidates.sort((a, b) => {
    const pa = priorityIndex.get(basename(a)) ?? EXTRA_DOC_PRIORITY_NAMES.length;
    const pb = priorityIndex.get(basename(b)) ?? EXTRA_DOC_PRIORITY_NAMES.length;
    if (pa !== pb) return pa - pb;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const PER_FILE_CAP = 4000;
  const TOTAL_CAP = 16000;
  const docs: ExtraDoc[] = [];
  let totalChars = 0;

  for (const filePath of candidates) {
    if (totalChars >= TOTAL_CAP) break;
    const raw = await readText(filePath);
    if (raw === null) continue;

    let content = truncateAtLine(raw, PER_FILE_CAP);
    if (totalChars + content.length > TOTAL_CAP) {
      content = truncateAtLine(content, TOTAL_CAP - totalChars);
    }
    if (content.length === 0) break;

    docs.push({ filename: filePath.slice(root.length + 1), content });
    totalChars += content.length;
  }

  return docs;
}

// ────────────────────────────────────────────────────────────────────────────
// Manifest readers
// ────────────────────────────────────────────────────────────────────────────

interface PackageJsonData {
  name: string | null;
  scripts: Record<string, string>;
  dependencies: string[];
  hasBin: boolean;
  hasWorkspaces: boolean;
  hasMainOrExports: boolean;
}

interface PyprojectData {
  name: string | null;
  dependencies: string[];
}

interface GoModData {
  module: string | null;
}

interface CargoData {
  name: string | null;
  dependencies: string[];
  isWorkspace: boolean;
}

interface PubspecData {
  name: string | null;
  usesFlutter: boolean;
  dependencies: string[];
}

interface Manifests {
  pkg: PackageJsonData | null;
  py: PyprojectData | null;
  go: GoModData | null;
  rust: CargoData | null;
  dart: PubspecData | null;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(root: string): Promise<PackageJsonData | null> {
  const raw = await readText(join(root, "package.json"));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const scripts = isStringRecord(parsed["scripts"]) ? parsed["scripts"] : {};
    const deps = {
      ...asStringRecord(parsed["dependencies"]),
      ...asStringRecord(parsed["devDependencies"]),
      ...asStringRecord(parsed["peerDependencies"]),
    };
    return {
      name: typeof parsed["name"] === "string" ? parsed["name"] : null,
      scripts,
      dependencies: Object.keys(deps),
      hasBin: parsed["bin"] !== undefined,
      hasWorkspaces:
        Array.isArray(parsed["workspaces"]) ||
        (isObject(parsed["workspaces"]) &&
          Array.isArray((parsed["workspaces"] as Record<string, unknown>)["packages"])),
      hasMainOrExports:
        typeof parsed["main"] === "string" || parsed["exports"] !== undefined,
    };
  } catch {
    return null;
  }
}

async function readPyproject(root: string): Promise<PyprojectData | null> {
  const raw = await readText(join(root, "pyproject.toml"));
  if (raw === null) return null;
  try {
    const parsed = toml.parse(raw) as Record<string, unknown>;
    const project = asRecord(parsed["project"]);
    const poetry = asRecord(asRecord(parsed["tool"])["poetry"]);
    const name =
      (typeof project["name"] === "string" ? project["name"] : null) ??
      (typeof poetry["name"] === "string" ? poetry["name"] : null);
    const pep621Deps = Array.isArray(project["dependencies"])
      ? (project["dependencies"] as unknown[]).filter(isString)
      : [];
    const poetryDepsRec = asRecord(poetry["dependencies"]);
    const poetryDeps = Object.keys(poetryDepsRec).filter((k) => k !== "python");
    const deps = [...pep621Deps.map(parseDepName), ...poetryDeps];
    return {
      name,
      dependencies: dedupe(deps),
    };
  } catch {
    return null;
  }
}

async function readGoMod(root: string): Promise<GoModData | null> {
  const raw = await readText(join(root, "go.mod"));
  if (raw === null) return null;
  const line = raw.split("\n").find((l) => l.trim().startsWith("module "));
  if (!line) return { module: null };
  const mod = line.trim().slice("module ".length).trim();
  return { module: mod || null };
}

async function readCargoToml(root: string): Promise<CargoData | null> {
  const raw = await readText(join(root, "Cargo.toml"));
  if (raw === null) return null;
  try {
    const parsed = toml.parse(raw) as Record<string, unknown>;
    const pkg = asRecord(parsed["package"]);
    const name = typeof pkg["name"] === "string" ? pkg["name"] : null;
    const deps = Object.keys(asRecord(parsed["dependencies"]));
    const isWorkspace = parsed["workspace"] !== undefined;
    return { name, dependencies: deps, isWorkspace };
  } catch {
    return null;
  }
}

async function readPubspecYaml(root: string): Promise<PubspecData | null> {
  const raw = await readText(join(root, "pubspec.yaml"));
  if (raw === null) return null;
  try {
    const parsed = yaml.parse(raw) as unknown;
    if (!isObject(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    const deps = asRecord(rec["dependencies"]);
    return {
      name: typeof rec["name"] === "string" ? rec["name"] : null,
      usesFlutter: "flutter" in deps || "flutter" in asRecord(rec["dev_dependencies"]),
      dependencies: Object.keys(deps),
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Inference
// ────────────────────────────────────────────────────────────────────────────

function inferLanguage(m: Manifests, hasTsconfig: boolean): Language {
  if (m.pkg) return hasTsconfig ? "typescript" : "javascript";
  if (m.py) return "python";
  if (m.go) return "go";
  if (m.rust) return "rust";
  if (m.dart) return "dart";
  return "unknown";
}

function inferStack(
  m: Manifests,
  hasTsconfig: boolean,
  goVersion: string | null,
): string[] {
  const out: string[] = [];
  if (m.pkg) {
    out.push("Node.js");
    if (hasTsconfig || m.pkg.dependencies.includes("typescript")) {
      out.push("TypeScript");
    } else {
      out.push("JavaScript");
    }
    collectSignals(m.pkg.dependencies, JS_STACK_SIGNALS, out);
  }
  if (m.py) {
    out.push("Python");
    collectSignals(m.py.dependencies, PY_STACK_SIGNALS, out);
  }
  if (m.go) {
    out.push(goVersion ? `Go ${goVersion}` : "Go");
  }
  if (m.rust) {
    out.push("Rust");
    collectSignals(m.rust.dependencies, RUST_STACK_SIGNALS, out);
  }
  if (m.dart) {
    out.push(m.dart.usesFlutter ? "Flutter" : "Dart");
  }
  return dedupe(out);
}

function collectSignals(
  deps: string[],
  signals: StackSignal[],
  out: string[],
): void {
  const set = new Set(deps);
  for (const s of signals) {
    if (set.has(s.dep)) out.push(s.label);
  }
}

function inferCommands(m: Manifests): ProjectCommands {
  if (m.pkg) {
    const s = m.pkg.scripts;
    return {
      dev: pickScript(s, ["dev", "start", "serve"]) ?? "npm run dev",
      test: pickScript(s, ["test"]) ?? "npm test",
      build: pickScript(s, ["build"]) ?? "npm run build",
      lint: pickScript(s, ["lint", "check"]) ?? "npm run lint",
    };
  }
  if (m.py) {
    return {
      dev: "python -m app",
      test: "pytest",
      build: "python -m build",
      lint: "ruff check .",
    };
  }
  if (m.go) {
    return {
      dev: "go run .",
      test: "go test ./...",
      build: "go build ./...",
      lint: "go vet ./...",
    };
  }
  if (m.rust) {
    return {
      dev: "cargo run",
      test: "cargo test",
      build: "cargo build --release",
      lint: "cargo clippy -- -D warnings",
    };
  }
  if (m.dart) {
    return m.dart.usesFlutter
      ? {
          dev: "flutter run",
          test: "flutter test",
          build: "flutter build",
          lint: "flutter analyze",
        }
      : {
          dev: "dart run",
          test: "dart test",
          build: "dart compile exe bin/main.dart",
          lint: "dart analyze",
        };
  }
  return {
    dev: "# TODO: dev command",
    test: "# TODO: test command",
    build: "# TODO: build command",
    lint: "# TODO: lint command",
  };
}

function pickScript(
  scripts: Record<string, string>,
  candidates: string[],
): string | null {
  for (const name of candidates) {
    if (typeof scripts[name] === "string") return `npm run ${name}`;
  }
  return null;
}

function inferProjectType(m: Manifests): ProjectType {
  if (m.dart?.usesFlutter) return "mobile-app";
  if (m.pkg?.hasWorkspaces) return "monorepo";
  if (m.rust?.isWorkspace) return "monorepo";
  if (m.pkg) {
    const deps = new Set(m.pkg.dependencies);
    if (any(deps, JS_FRONTEND_MARKERS)) return "web-app";
    if (any(deps, JS_API_MARKERS)) return "rest-api";
    if (m.pkg.hasBin) return "cli";
    if (m.pkg.hasMainOrExports) return "library";
    return "unknown";
  }
  if (m.py) {
    if (any(new Set(m.py.dependencies), PY_API_MARKERS)) return "rest-api";
    return "library";
  }
  if (m.rust) {
    if (any(new Set(m.rust.dependencies), RUST_API_MARKERS)) return "rest-api";
    return "library";
  }
  if (m.go) return "cli";
  return "unknown";
}

function any<T>(source: Set<T>, needles: Set<T>): boolean {
  for (const n of needles) if (source.has(n)) return true;
  return false;
}

function refineProjectType(
  stack: string[],
  extraDocs: ExtraDoc[],
): ProjectType {
  const matched = new Set<ProjectType>();

  for (const label of stack) {
    const type = STACK_LABEL_PROJECT_TYPE_MAP[label.toLowerCase()];
    if (type !== undefined) matched.add(type);
  }

  if (extraDocs.length > 0) {
    const content = extraDocs.map((d) => d.content).join("\n").toLowerCase();
    for (const [key, type] of Object.entries(STACK_LABEL_PROJECT_TYPE_MAP)) {
      if (content.includes(key)) matched.add(type);
    }
  }

  for (const type of PROJECT_TYPE_PRECEDENCE) {
    if (matched.has(type)) return type;
  }

  return "unknown";
}

async function scanDirectories(root: string): Promise<DirectoryEntry[]> {
  let entries: string[] = [];
  try {
    const raw = await readdir(root, { withFileTypes: true });
    entries = raw.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const result: DirectoryEntry[] = [];
  for (const name of entries.sort()) {
    if (IGNORED_TOP_LEVEL_DIRS.has(name) || name.startsWith(".")) continue;
    const desc = KNOWN_DIRS[name];
    if (desc !== undefined) {
      result.push({ dir: `${name}/`, description: desc });
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// README + CI + existing CCL state
// ────────────────────────────────────────────────────────────────────────────

async function readReadmeSnippet(root: string): Promise<string | null> {
  for (const name of ["README.md", "README.MD", "readme.md", "README"]) {
    const raw = await readText(join(root, name));
    if (raw === null) continue;
    return firstParagraph(raw);
  }
  return null;
}

function firstParagraph(md: string): string | null {
  const lines = md.split("\n");
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") {
      if (current.length) {
        paragraphs.push(current.join(" ").trim());
        current = [];
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    if (line.startsWith("!")) continue;
    if (/^\[!\[/.test(line)) continue;
    current.push(line);
  }
  if (current.length) paragraphs.push(current.join(" ").trim());
  const first = paragraphs.find((p) => p.length > 0);
  return first ?? null;
}

async function detectCiConfig(root: string): Promise<boolean> {
  const candidates = [
    ".github/workflows",
    ".gitlab-ci.yml",
    ".circleci/config.yml",
    "azure-pipelines.yml",
    ".travis.yml",
  ];
  for (const c of candidates) {
    if (await pathExists(join(root, c))) return true;
  }
  return false;
}

async function detectExistingCcl(root: string): Promise<ExistingCcl> {
  const hasClaudeMd = await pathExists(join(root, "CLAUDE.md"));
  const hasClaudeDir = await pathExists(join(root, ".claude"));
  let practices: ExistingCcl["practices"] = null;
  const practicesRaw = await readText(join(root, ".claude", "ccl-practices.json"));
  if (practicesRaw !== null) {
    try {
      const parsed = JSON.parse(practicesRaw) as Record<string, unknown>;
      const version = typeof parsed["version"] === "string" ? parsed["version"] : null;
      const lastUpdated =
        typeof parsed["last_updated"] === "string" ? parsed["last_updated"] : null;
      if (version && lastUpdated) {
        practices = { version, lastUpdatedIso: lastUpdated };
      }
    } catch {
      // ignore malformed practices file
    }
  }
  return { hasClaudeMd, hasClaudeDir, practices };
}

async function detectMonorepoMarker(root: string): Promise<boolean> {
  if (await pathExists(join(root, "pnpm-workspace.yaml"))) return true;
  if (await pathExists(join(root, "lerna.json"))) return true;
  if (await pathExists(join(root, "nx.json"))) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Main entry
// ────────────────────────────────────────────────────────────────────────────

export interface DetectOptions {
  now?: Date;
}

export async function detectProject(
  rootDir: string,
  _opts: DetectOptions = {},
): Promise<DetectedProject> {
  if (!(await pathExists(rootDir))) {
    throw new Error(`detectProject: directory does not exist: ${rootDir}`);
  }

  const [pkg, py, go, rust, dart, hasTsconfig, rawReadmeSnippet, ccl, ciConfig, extraMonorepo, extraDocs] =
    await Promise.all([
      readPackageJson(rootDir),
      readPyproject(rootDir),
      readGoMod(rootDir),
      readCargoToml(rootDir),
      readPubspecYaml(rootDir),
      pathExists(join(rootDir, "tsconfig.json")),
      readReadmeSnippet(rootDir),
      detectExistingCcl(rootDir),
      detectCiConfig(rootDir),
      detectMonorepoMarker(rootDir),
      readExtraDocs(rootDir),
    ]);

  // Sanitize the README snippet via the same boundary that guards LLM-supplied
  // ScaffoldOverrides — the snippet flows into CLAUDE.md, so untrusted README
  // content must not bypass that filter. If sanitization strips the field or
  // the validator throws, surface "" rather than the raw input.
  let readmeSnippet: string | null = null;
  if (rawReadmeSnippet !== null) {
    try {
      const result = validateScaffoldOverrides({ whatIsThis: rawReadmeSnippet });
      readmeSnippet = result.overrides.whatIsThis ?? "";
    } catch {
      readmeSnippet = "";
    }
  }

  const manifests: Manifests = { pkg, py, go, rust, dart };
  const goVersion = go ? await readGoVersion(rootDir) : null;

  const language = inferLanguage(manifests, hasTsconfig);
  const stack = inferStack(manifests, hasTsconfig, goVersion);
  const commands = inferCommands(manifests);
  let projectType = inferProjectType(manifests);
  if (extraMonorepo) projectType = "monorepo";
  if (projectType === "unknown") {
    projectType = refineProjectType(stack, extraDocs);
  }

  const directories = await scanDirectories(rootDir);

  const projectName =
    pkg?.name ??
    py?.name ??
    (go?.module ? basename(go.module) : null) ??
    rust?.name ??
    dart?.name ??
    basename(rootDir);

  const manifestNames: string[] = [];
  if (pkg) manifestNames.push("package.json");
  if (py) manifestNames.push("pyproject.toml");
  if (go) manifestNames.push("go.mod");
  if (rust) manifestNames.push("Cargo.toml");
  if (dart) manifestNames.push("pubspec.yaml");

  const findings: Findings = {
    manifests: manifestNames,
    hasReadme: readmeSnippet !== null,
    hasDockerfile: await pathExists(join(rootDir, "Dockerfile")),
    hasEnvExample: await pathExists(join(rootDir, ".env.example")),
    hasCiConfig: ciConfig,
    isMonorepo: projectType === "monorepo",
  };

  return {
    rootDir,
    projectName,
    projectType,
    language,
    stack,
    commands,
    directories,
    readmeSnippet,
    extraDocs,
    existingCcl: ccl,
    findings,
  };
}

async function readGoVersion(root: string): Promise<string | null> {
  const raw = await readText(join(root, "go.mod"));
  if (raw === null) return null;
  const line = raw.split("\n").find((l) => /^\s*go\s+\d/.test(l));
  if (!line) return null;
  const match = line.match(/go\s+(\S+)/);
  return match && match[1] ? match[1] : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ────────────────────────────────────────────────────────────────────────────

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!isObject(v)) return false;
  for (const val of Object.values(v)) {
    if (typeof val !== "string") return false;
  }
  return true;
}

function asRecord(v: unknown): Record<string, unknown> {
  return isObject(v) ? v : {};
}

function asStringRecord(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function parseDepName(spec: string): string {
  const match = spec.match(/^([A-Za-z0-9_.\-]+)/);
  return match && match[1] ? match[1].toLowerCase() : spec.toLowerCase();
}

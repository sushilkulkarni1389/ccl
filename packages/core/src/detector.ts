import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import * as toml from "smol-toml";
import * as yaml from "yaml";

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

export interface DetectedProject {
  rootDir: string;
  projectName: string;
  projectType: ProjectType;
  language: Language;
  stack: string[];
  commands: ProjectCommands;
  directories: DirectoryEntry[];
  readmeSnippet: string | null;
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

  const [pkg, py, go, rust, dart, hasTsconfig, readmeSnippet, ccl, ciConfig, extraMonorepo] =
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
    ]);

  const manifests: Manifests = { pkg, py, go, rust, dart };
  const goVersion = go ? await readGoVersion(rootDir) : null;

  const language = inferLanguage(manifests, hasTsconfig);
  const stack = inferStack(manifests, hasTsconfig, goVersion);
  const commands = inferCommands(manifests);
  let projectType = inferProjectType(manifests);
  if (extraMonorepo) projectType = "monorepo";

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

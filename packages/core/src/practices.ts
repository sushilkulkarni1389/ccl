import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { normalizeCclField, SHELL_TOKENS } from "./override-validator.js";
import {
  addDays,
  REFRESH_INTERVAL_DAYS,
  renderPracticesJson,
} from "./templates/ccl-practices-json.js";
import type {
  ArchivedVersion,
  PracticeEntry,
  PracticesContext,
} from "./templates/types.js";

// ────────────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────────────

export interface PracticesDiff {
  added: PracticeEntry[];
  removed: PracticeEntry[];
  modified: Array<{ before: PracticeEntry; after: PracticeEntry }>;
  unchanged: PracticeEntry[];
}

export interface RefreshResult {
  diff: PracticesDiff;
  next: PracticesContext;
  versionBumped: boolean;
}

export class MalformedPracticesVersionError extends Error {
  constructor(public readonly version: string) {
    super(`Unable to bump malformed practices version: "${version}". Expected "<major>.<minor>".`);
    this.name = "MalformedPracticesVersionError";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// I/O
// ────────────────────────────────────────────────────────────────────────────

export function practicesFilePath(rootDir: string): string {
  return join(rootDir, ".claude", "ccl-practices.json");
}

export async function loadPractices(
  rootDir: string,
): Promise<PracticesContext | null> {
  let raw: string;
  try {
    raw = await readFile(practicesFilePath(rootDir), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizePractices(parsed);
  } catch {
    return null;
  }
}

export async function savePractices(
  rootDir: string,
  ctx: PracticesContext,
): Promise<void> {
  const path = practicesFilePath(rootDir);
  await mkdir(join(rootDir, ".claude"), { recursive: true });
  const tmp = `${path}.${randomBytes(8).toString("hex")}.ccl-tmp`;
  await writeFile(tmp, renderPracticesJson(ctx), "utf8");
  await rename(tmp, path);
}

// ────────────────────────────────────────────────────────────────────────────
// Refresh gating (§15)
// ────────────────────────────────────────────────────────────────────────────

export function isRefreshDisabled(ctx: PracticesContext): boolean {
  return ctx.refresh === "never";
}

export function isRefreshDue(ctx: PracticesContext, now: Date): boolean {
  if (isRefreshDisabled(ctx)) return false;
  const dueAt = Date.parse(ctx.nextCheckDue);
  if (Number.isNaN(dueAt)) return true;
  return now.getTime() >= dueAt;
}

export function disableRefresh(ctx: PracticesContext): PracticesContext {
  return { ...ctx, refresh: "never" };
}

// ────────────────────────────────────────────────────────────────────────────
// Diff
// ────────────────────────────────────────────────────────────────────────────

export function computePracticesDiff(
  current: PracticeEntry[],
  candidates: PracticeEntry[],
): PracticesDiff {
  const currentById = new Map(current.map((p) => [p.id, p]));
  const candidateIds = new Set(candidates.map((p) => p.id));

  const added: PracticeEntry[] = [];
  const removed: PracticeEntry[] = [];
  const modified: Array<{ before: PracticeEntry; after: PracticeEntry }> = [];
  const unchanged: PracticeEntry[] = [];

  for (const cand of candidates) {
    const existing = currentById.get(cand.id);
    if (!existing) {
      added.push(cand);
      continue;
    }
    if (practicesEqual(existing, cand)) {
      unchanged.push(existing);
    } else {
      modified.push({ before: existing, after: cand });
    }
  }
  for (const cur of current) {
    if (!candidateIds.has(cur.id)) removed.push(cur);
  }
  return { added, removed, modified, unchanged };
}

function practicesEqual(a: PracticeEntry, b: PracticeEntry): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.description === b.description &&
    a.source === b.source &&
    a.status === b.status
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Diff display (§15 — Phase 5)
// ────────────────────────────────────────────────────────────────────────────

export function renderDiffSummary(diff: PracticesDiff): string {
  const addedCount = diff.added.length;
  const modifiedCount = diff.modified.length;
  const removedCount = diff.removed.length;
  const unchangedCount = diff.unchanged.length;

  const summaryLines: string[] = [];
  if (addedCount > 0) {
    summaryLines.push(
      `✦ ${addedCount} new ${pluralize("practice", addedCount)} found`,
    );
  }
  if (modifiedCount > 0) {
    summaryLines.push(
      `✦ ${modifiedCount} ${pluralize("practice", modifiedCount)} updated`,
    );
  }
  if (removedCount > 0) {
    summaryLines.push(
      `✦ ${removedCount} outdated ${pluralize("practice", removedCount)} to remove`,
    );
  }
  summaryLines.push(
    `✦ ${unchangedCount} ${pluralize("practice", unchangedCount)} unchanged`,
  );

  const sections: string[] = [];

  if (addedCount > 0) {
    const lines = ["NEW:"];
    for (const p of diff.added) {
      lines.push(`+ ${p.title} — ${p.source}`);
    }
    sections.push(lines.join("\n"));
  }

  if (modifiedCount > 0) {
    const lines = ["UPDATED:"];
    for (const { before, after } of diff.modified) {
      lines.push(`~ ${after.title} — ${describeChange(before, after)}`);
    }
    sections.push(lines.join("\n"));
  }

  if (removedCount > 0) {
    const lines = ["REMOVE:"];
    for (const p of diff.removed) {
      lines.push(`- ${p.title} — no longer recommended`);
    }
    sections.push(lines.join("\n"));
  }

  const parts: string[] = [summaryLines.join("\n")];
  if (sections.length > 0) parts.push(sections.join("\n\n"));
  return parts.join("\n\n");
}

function describeChange(before: PracticeEntry, after: PracticeEntry): string {
  const descChanged = before.description !== after.description;
  const sourceChanged = before.source !== after.source;
  if (descChanged && sourceChanged) return "content updated";
  if (sourceChanged) return "source updated";
  return "description updated";
}

function pluralize(word: string, n: number): string {
  return n === 1 ? word : `${word}s`;
}

// ────────────────────────────────────────────────────────────────────────────
// applyRefresh
// ────────────────────────────────────────────────────────────────────────────

export function applyRefresh(
  current: PracticesContext,
  candidates: PracticeEntry[],
  now: Date,
): RefreshResult {
  const diff = computePracticesDiff(current.practices, candidates);
  const hasChanges =
    diff.added.length > 0 ||
    diff.removed.length > 0 ||
    diff.modified.length > 0;

  const nowIso = now.toISOString();
  const nextCheckDue = addDays(nowIso, REFRESH_INTERVAL_DAYS);

  if (!hasChanges) {
    return {
      diff,
      versionBumped: false,
      next: {
        ...current,
        lastChecked: nowIso,
        lastUpdated: nowIso,
        nextCheckDue,
      },
    };
  }

  const mergedPractices = mergePractices(current.practices, candidates, nowIso);
  const archive: ArchivedVersion = {
    version: current.version,
    archivedAt: nowIso,
    practices: current.practices,
  };
  const archivedVersions = capArchives([
    ...current.archivedVersions,
    archive,
  ]);

  return {
    diff,
    versionBumped: true,
    next: {
      ...current,
      version: bumpMinorVersion(current.version),
      lastChecked: nowIso,
      lastUpdated: nowIso,
      nextCheckDue,
      practices: mergedPractices,
      archivedVersions,
    },
  };
}

function mergePractices(
  current: PracticeEntry[],
  candidates: PracticeEntry[],
  nowIso: string,
): PracticeEntry[] {
  const byId = new Map(current.map((p) => [p.id, p]));
  const today = nowIso.slice(0, 10);
  return candidates.map((cand) => {
    const existing = byId.get(cand.id);
    return {
      ...cand,
      added: existing?.added ?? cand.added ?? today,
    };
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Version bump + archive cap
// ────────────────────────────────────────────────────────────────────────────

const VERSION_RE = /^(\d+)\.(\d+)$/;

export function bumpMinorVersion(version: string): string {
  const match = VERSION_RE.exec(version);
  if (!match) throw new MalformedPracticesVersionError(version);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return `${major}.${minor + 1}`;
}

// Blueprint §13: archived_versions holds at most 1 entry. Anything older is
// deleted permanently.
export function capArchives(archives: ArchivedVersion[]): ArchivedVersion[] {
  if (archives.length <= 1) return archives;
  return archives.slice(-1);
}

// ────────────────────────────────────────────────────────────────────────────
// Parsing / normalization
// ────────────────────────────────────────────────────────────────────────────

function normalizePractices(raw: unknown): PracticesContext | null {
  if (!isObject(raw)) return null;
  const version = asString(raw["version"]);
  const lastUpdated = asString(raw["last_updated"]);
  const lastChecked = asString(raw["last_checked"]);
  const nextCheckDue = asString(raw["next_check_due"]);
  if (!version || !lastUpdated || !lastChecked || !nextCheckDue) return null;

  const practices = parsePracticeList(raw["practices"]);
  if (!practices) return null;

  const archivedVersions = parseArchives(raw["archived_versions"]);
  if (!archivedVersions) return null;

  const ctx: PracticesContext = {
    version,
    lastUpdated,
    lastChecked,
    nextCheckDue,
    practices,
    archivedVersions,
  };
  if (raw["refresh"] === "never") ctx.refresh = "never";
  return ctx;
}

function parsePracticeList(v: unknown): PracticeEntry[] | null {
  if (!Array.isArray(v)) return null;
  const out: PracticeEntry[] = [];
  for (const item of v) {
    const entry = parsePractice(item);
    if (!entry) return null;
    out.push(entry);
  }
  return out;
}

function parsePractice(v: unknown): PracticeEntry | null {
  if (!isObject(v)) return null;
  const id = asString(v["id"]);
  const title = asString(v["title"]);
  const description = asString(v["description"]);
  const source = asString(v["source"]);
  const added = asString(v["added"]);
  const status = v["status"];
  if (!id || !title || !description || !source || !added) return null;
  if (status !== "active" && status !== "deprecated") return null;
  return { id, title, description, source, added, status };
}

function parseArchives(v: unknown): ArchivedVersion[] | null {
  if (!Array.isArray(v)) return null;
  const out: ArchivedVersion[] = [];
  for (const item of v) {
    if (!isObject(item)) return null;
    const version = asString(item["version"]);
    const archivedAt = asString(item["archived_at"]);
    const practices = parsePracticeList(item["practices"]);
    if (!version || !archivedAt || !practices) return null;
    out.push({ version, archivedAt, practices });
  }
  return out;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ────────────────────────────────────────────────────────────────────────────
// Candidate validation (§15 — security gate on incoming web-search results)
//
// Incoming PracticeEntry candidates are untrusted JSON from the open web.
// Before they reach computePracticesDiff / applyRefresh we run pure string
// checks on every field and filter any entry whose source domain is not on
// TRUSTED_PRACTICE_DOMAINS. Violations are surfaced to the user; rejected
// entries never persist to ccl-practices.json.
// ────────────────────────────────────────────────────────────────────────────

export const TRUSTED_PRACTICE_DOMAINS: readonly string[] = [
  "github.com",
  "docs.anthropic.com",
  "anthropic.com",
  "modelcontextprotocol.io",
  "docs.github.com",
  "npmjs.com",
  "nodejs.org",
  "www.typescriptlang.org",
  "developer.mozilla.org",
];

const PRACTICE_ID_RE = /^[a-z0-9-]+$/;
const PRACTICE_ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRACTICE_SHELL_TOKEN_RE = new RegExp(
  `\\b(${SHELL_TOKENS.join("|")})\\b`,
  "i",
);

export interface PracticeValidationResult {
  entry: PracticeEntry | null;
  violations: string[];
}

export function validatePracticeCandidate(
  raw: unknown,
  now: Date = new Date(),
): PracticeValidationResult {
  const violations: string[] = [];

  if (!isObject(raw)) {
    violations.push("candidate: not an object");
    return { entry: null, violations };
  }

  const idVal = raw["id"];
  if (
    typeof idVal !== "string" ||
    idVal.length === 0 ||
    idVal.length > 30 ||
    !PRACTICE_ID_RE.test(idVal)
  ) {
    violations.push("candidate: id missing or invalid");
    return { entry: null, violations };
  }

  const titleReject = checkTextField(raw["title"], 80);
  if (titleReject !== null) {
    violations.push(`${idVal}: title ${titleReject}`);
    return { entry: null, violations };
  }

  const descReject = checkTextField(raw["description"], 400);
  if (descReject !== null) {
    violations.push(`${idVal}: description ${descReject}`);
    return { entry: null, violations };
  }

  const srcVal = raw["source"];
  if (typeof srcVal !== "string" || !isTrustedPracticeSource(srcVal)) {
    violations.push(`${idVal}: source missing or untrusted domain`);
    return { entry: null, violations };
  }

  const rawAdded = raw["added"];
  const addedStr =
    typeof rawAdded === "string" && PRACTICE_ISO_DATE_RE.test(rawAdded)
      ? rawAdded
      : now.toISOString().slice(0, 10);

  const rawStatus = raw["status"];
  const statusVal: "active" | "deprecated" =
    rawStatus === "deprecated" ? "deprecated" : "active";

  const entry: PracticeEntry = {
    id: idVal,
    title: raw["title"] as string,
    description: raw["description"] as string,
    source: srcVal,
    added: addedStr,
    status: statusVal,
  };
  return { entry, violations };
}

function checkTextField(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") return "missing";
  const normalized = normalizeCclField(v);
  if (normalized.length > maxLen) return `exceeds ${maxLen} chars`;
  if (PRACTICE_SHELL_TOKEN_RE.test(normalized)) return "contains shell token";
  if (normalized.includes("`")) return "contains backtick";
  if (normalized.includes("$(")) return "contains $( substitution";
  return null;
}

export function isTrustedPracticeSource(source: string): boolean {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return TRUSTED_PRACTICE_DOMAINS.some(
    (d) => host === d || host.endsWith(`.${d}`),
  );
}

export interface PracticeBatchValidationResult {
  valid: PracticeEntry[];
  rejected: number;
  totalViolations: string[];
}

export function validatePracticeCandidates(
  raws: unknown,
  now: Date,
): PracticeBatchValidationResult {
  if (!Array.isArray(raws)) {
    return { valid: [], rejected: 0, totalViolations: [] };
  }
  const valid: PracticeEntry[] = [];
  let rejected = 0;
  const totalViolations: string[] = [];
  for (const raw of raws) {
    const { entry, violations } = validatePracticeCandidate(raw, now);
    totalViolations.push(...violations);
    if (entry === null) {
      rejected += 1;
    } else {
      valid.push(entry);
    }
  }
  return { valid, rejected, totalViolations };
}

export function renderCandidateValidationSummary(
  rejected: number,
  totalViolations: string[],
): string | null {
  if (rejected === 0 && totalViolations.length === 0) return null;
  const lines = [
    `⚠  ${rejected} candidate(s) discarded — failed source or content validation.`,
  ];
  if (totalViolations.length > 0) {
    lines.push("");
    const shown = totalViolations.slice(0, 5);
    for (const v of shown) lines.push(`  • ${v}`);
    if (totalViolations.length > 5) {
      lines.push(`  … and ${totalViolations.length - 5} more`);
    }
  }
  return lines.join("\n");
}

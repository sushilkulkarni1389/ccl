import { describe, it } from "node:test";
import nodeAssert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyRefresh,
  bumpMinorVersion,
  capArchives,
  computePracticesDiff,
  disableRefresh,
  isRefreshDisabled,
  isRefreshDue,
  loadPractices,
  MalformedPracticesVersionError,
  practicesFilePath,
  renderDiffSummary,
  savePractices,
} from "../src/practices.js";
import {
  defaultPracticesContext,
  renderPracticesJson,
} from "../src/templates/ccl-practices-json.js";
import type {
  PracticeEntry,
  PracticesContext,
} from "../src/templates/types.js";

const FIXED_NOW = new Date("2026-04-24T10:00:00.000Z");
const WEEK_LATER = new Date("2026-05-01T10:00:00.000Z");
const TWO_WEEKS_LATER = new Date("2026-05-08T10:00:00.000Z");

function practice(
  id: string,
  overrides: Partial<PracticeEntry> = {},
): PracticeEntry {
  return {
    id,
    title: `Practice ${id}`,
    description: `Description for ${id}`,
    source: `https://example.com/${id}`,
    added: "2026-04-24",
    status: "active",
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// I/O
// ──────────────────────────────────────────────────────────────────────────

describe("loadPractices + savePractices", () => {
  it("returns null when the file does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccl-practices-"));
    try {
      nodeAssert.equal(await loadPractices(root), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips the default context", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccl-practices-"));
    try {
      const ctx = defaultPracticesContext(FIXED_NOW);
      await savePractices(root, ctx);
      const loaded = await loadPractices(root);
      nodeAssert.ok(loaded);
      nodeAssert.equal(loaded!.version, ctx.version);
      nodeAssert.equal(loaded!.lastUpdated, ctx.lastUpdated);
      nodeAssert.equal(loaded!.nextCheckDue, ctx.nextCheckDue);
      nodeAssert.equal(loaded!.practices.length, ctx.practices.length);
      nodeAssert.equal(loaded!.practices[0]!.id, "bp-001");
      nodeAssert.deepEqual(loaded!.archivedVersions, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns null when the file is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccl-practices-"));
    try {
      await mkdir(join(root, ".claude"), { recursive: true });
      await writeFile(practicesFilePath(root), "{ not json", "utf8");
      nodeAssert.equal(await loadPractices(root), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns null when required fields are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccl-practices-"));
    try {
      await mkdir(join(root, ".claude"), { recursive: true });
      await writeFile(
        practicesFilePath(root),
        JSON.stringify({ version: "1.0" }),
        "utf8",
      );
      nodeAssert.equal(await loadPractices(root), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves refresh:never on round-trip", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccl-practices-"));
    try {
      const ctx = defaultPracticesContext(FIXED_NOW);
      ctx.refresh = "never";
      await savePractices(root, ctx);
      const loaded = await loadPractices(root);
      nodeAssert.equal(loaded!.refresh, "never");

      // Serialized form should contain the field too
      const raw = await readFile(practicesFilePath(root), "utf8");
      nodeAssert.match(raw, /"refresh": "never"/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Refresh gating
// ──────────────────────────────────────────────────────────────────────────

describe("refresh gating", () => {
  it("is not due before next_check_due", () => {
    const ctx = defaultPracticesContext(FIXED_NOW);
    nodeAssert.equal(isRefreshDue(ctx, FIXED_NOW), false);
    nodeAssert.equal(
      isRefreshDue(ctx, new Date("2026-04-30T09:59:59Z")),
      false,
    );
  });

  it("is due on or after next_check_due", () => {
    const ctx = defaultPracticesContext(FIXED_NOW);
    nodeAssert.equal(isRefreshDue(ctx, WEEK_LATER), true);
    nodeAssert.equal(isRefreshDue(ctx, TWO_WEEKS_LATER), true);
  });

  it("is never due when refresh is disabled", () => {
    const ctx = disableRefresh(defaultPracticesContext(FIXED_NOW));
    nodeAssert.equal(isRefreshDisabled(ctx), true);
    nodeAssert.equal(isRefreshDue(ctx, TWO_WEEKS_LATER), false);
  });

  it("disableRefresh is non-destructive", () => {
    const ctx = defaultPracticesContext(FIXED_NOW);
    const disabled = disableRefresh(ctx);
    nodeAssert.equal(disabled.refresh, "never");
    nodeAssert.equal(ctx.refresh, undefined);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Diff
// ──────────────────────────────────────────────────────────────────────────

describe("computePracticesDiff", () => {
  it("detects added, removed, modified, and unchanged", () => {
    const current = [
      practice("bp-001"),
      practice("bp-002"),
      practice("bp-003"),
    ];
    const candidates = [
      practice("bp-001"), // unchanged
      practice("bp-002", { description: "Updated description" }), // modified
      practice("bp-004"), // added
      // bp-003 removed
    ];
    const diff = computePracticesDiff(current, candidates);
    nodeAssert.equal(diff.added.length, 1);
    nodeAssert.equal(diff.added[0]!.id, "bp-004");
    nodeAssert.equal(diff.removed.length, 1);
    nodeAssert.equal(diff.removed[0]!.id, "bp-003");
    nodeAssert.equal(diff.modified.length, 1);
    nodeAssert.equal(diff.modified[0]!.before.id, "bp-002");
    nodeAssert.equal(diff.modified[0]!.after.description, "Updated description");
    nodeAssert.equal(diff.unchanged.length, 1);
    nodeAssert.equal(diff.unchanged[0]!.id, "bp-001");
  });

  it("treats empty candidates as 'remove everything'", () => {
    const diff = computePracticesDiff([practice("bp-001")], []);
    nodeAssert.equal(diff.removed.length, 1);
    nodeAssert.equal(diff.added.length, 0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// renderDiffSummary
// ──────────────────────────────────────────────────────────────────────────

describe("renderDiffSummary", () => {
  it("renders only the summary line when all buckets are empty", () => {
    const out = renderDiffSummary({
      added: [],
      removed: [],
      modified: [],
      unchanged: [],
    });
    nodeAssert.ok(out.includes("0 practices unchanged"));
    nodeAssert.doesNotMatch(out, /NEW:/);
    nodeAssert.doesNotMatch(out, /UPDATED:/);
    nodeAssert.doesNotMatch(out, /REMOVE:/);
    nodeAssert.doesNotMatch(out, /```/);
  });

  it("omits UPDATED and REMOVE sections when only added entries present", () => {
    const out = renderDiffSummary({
      added: [practice("bp-010")],
      removed: [],
      modified: [],
      unchanged: [practice("bp-001"), practice("bp-002")],
    });
    nodeAssert.match(out, /1 new practice found/);
    nodeAssert.match(out, /2 practices unchanged/);
    nodeAssert.match(out, /NEW:/);
    nodeAssert.match(out, /\+ Practice bp-010 — https:\/\/example\.com\/bp-010/);
    nodeAssert.doesNotMatch(out, /UPDATED:/);
    nodeAssert.doesNotMatch(out, /REMOVE:/);
  });

  it("renders UPDATED section with `~` prefix and change reason", () => {
    const before = practice("bp-002");
    const afterDesc = practice("bp-002", { description: "new description" });
    const out = renderDiffSummary({
      added: [],
      removed: [],
      modified: [{ before, after: afterDesc }],
      unchanged: [],
    });
    nodeAssert.match(out, /1 practice updated/);
    nodeAssert.match(out, /UPDATED:\n~ Practice bp-002 — description updated/);

    const afterSource = practice("bp-002", { source: "https://other.example" });
    const sourceOut = renderDiffSummary({
      added: [],
      removed: [],
      modified: [{ before, after: afterSource }],
      unchanged: [],
    });
    nodeAssert.match(sourceOut, /~ Practice bp-002 — source updated/);

    const afterBoth = practice("bp-002", {
      description: "new description",
      source: "https://other.example",
    });
    const bothOut = renderDiffSummary({
      added: [],
      removed: [],
      modified: [{ before, after: afterBoth }],
      unchanged: [],
    });
    nodeAssert.match(bothOut, /~ Practice bp-002 — content updated/);
  });

  it("renders all four sections in order: NEW, UPDATED, REMOVE", () => {
    const before = practice("bp-002");
    const afterMod = practice("bp-002", { description: "updated" });
    const out = renderDiffSummary({
      added: [practice("bp-010")],
      removed: [practice("bp-099")],
      modified: [{ before, after: afterMod }],
      unchanged: [practice("bp-001")],
    });
    nodeAssert.match(out, /1 new practice found/);
    nodeAssert.match(out, /1 practice updated/);
    nodeAssert.match(out, /1 outdated practice to remove/);
    nodeAssert.match(out, /1 practice unchanged/);

    const newIdx = out.indexOf("NEW:");
    const updatedIdx = out.indexOf("UPDATED:");
    const removeIdx = out.indexOf("REMOVE:");
    nodeAssert.ok(newIdx >= 0 && updatedIdx > newIdx && removeIdx > updatedIdx);

    nodeAssert.match(out, /\+ Practice bp-010/);
    nodeAssert.match(out, /~ Practice bp-002 — description updated/);
    nodeAssert.match(out, /- Practice bp-099 — no longer recommended/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// applyRefresh
// ──────────────────────────────────────────────────────────────────────────

describe("applyRefresh — no changes", () => {
  it("updates timestamps but does not bump version or archive", () => {
    const current: PracticesContext = {
      ...defaultPracticesContext(FIXED_NOW),
      practices: [practice("bp-001")],
    };
    const result = applyRefresh(current, [practice("bp-001")], WEEK_LATER);
    nodeAssert.equal(result.versionBumped, false);
    nodeAssert.equal(result.next.version, current.version);
    nodeAssert.equal(result.next.lastChecked, WEEK_LATER.toISOString());
    nodeAssert.equal(result.next.lastUpdated, WEEK_LATER.toISOString());
    nodeAssert.equal(result.next.nextCheckDue, "2026-05-08T10:00:00.000Z");
    nodeAssert.deepEqual(result.next.archivedVersions, []);
  });
});

describe("applyRefresh — with changes", () => {
  const baseCurrent: PracticesContext = {
    ...defaultPracticesContext(FIXED_NOW),
    practices: [
      practice("bp-001", { added: "2026-01-01" }),
      practice("bp-002", { added: "2026-02-15" }),
    ],
  };

  it("bumps version, archives current, preserves added dates on carry-over", () => {
    const candidates = [
      practice("bp-001", { added: "2026-04-24" }), // carry-over: should keep 2026-01-01
      practice("bp-003"), // new
    ];
    const result = applyRefresh(baseCurrent, candidates, WEEK_LATER);

    nodeAssert.equal(result.versionBumped, true);
    nodeAssert.equal(result.next.version, "1.1");
    const bp001 = result.next.practices.find((p) => p.id === "bp-001")!;
    nodeAssert.equal(bp001.added, "2026-01-01", "carries over original added date");

    nodeAssert.equal(result.next.archivedVersions.length, 1);
    nodeAssert.equal(result.next.archivedVersions[0]!.version, "1.0");
    nodeAssert.equal(
      result.next.archivedVersions[0]!.archivedAt,
      WEEK_LATER.toISOString(),
    );
    nodeAssert.equal(result.next.archivedVersions[0]!.practices.length, 2);
  });

  it("caps archived_versions at 1 — oldest is dropped on second bump", () => {
    const afterFirstBump = applyRefresh(
      baseCurrent,
      [practice("bp-003")],
      WEEK_LATER,
    ).next;
    nodeAssert.equal(afterFirstBump.version, "1.1");
    nodeAssert.equal(afterFirstBump.archivedVersions.length, 1);
    nodeAssert.equal(afterFirstBump.archivedVersions[0]!.version, "1.0");

    const afterSecondBump = applyRefresh(
      afterFirstBump,
      [practice("bp-004")],
      TWO_WEEKS_LATER,
    ).next;
    nodeAssert.equal(afterSecondBump.version, "1.2");
    nodeAssert.equal(
      afterSecondBump.archivedVersions.length,
      1,
      "archive list stays at size 1",
    );
    nodeAssert.equal(
      afterSecondBump.archivedVersions[0]!.version,
      "1.1",
      "the newer archive (1.1) is kept; 1.0 is permanently dropped",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Version + archive helpers
// ──────────────────────────────────────────────────────────────────────────

describe("bumpMinorVersion", () => {
  it("bumps the minor component", () => {
    nodeAssert.equal(bumpMinorVersion("1.0"), "1.1");
    nodeAssert.equal(bumpMinorVersion("1.9"), "1.10");
    nodeAssert.equal(bumpMinorVersion("2.0"), "2.1");
  });

  it("throws on malformed versions", () => {
    nodeAssert.throws(
      () => bumpMinorVersion("1.0.0"),
      MalformedPracticesVersionError,
    );
    nodeAssert.throws(() => bumpMinorVersion("x"), MalformedPracticesVersionError);
  });
});

describe("capArchives", () => {
  it("keeps ≤1 archive", () => {
    const a = { version: "1.0", archivedAt: "x", practices: [] };
    const b = { version: "1.1", archivedAt: "y", practices: [] };
    const c = { version: "1.2", archivedAt: "z", practices: [] };
    nodeAssert.deepEqual(capArchives([]), []);
    nodeAssert.deepEqual(capArchives([a]), [a]);
    nodeAssert.deepEqual(capArchives([a, b]), [b]);
    nodeAssert.deepEqual(capArchives([a, b, c]), [c]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// End-to-end: save → load → refresh → save → load
// ──────────────────────────────────────────────────────────────────────────

describe("end-to-end refresh cycle", () => {
  it("persists version bump + archive to disk and survives reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccl-practices-"));
    try {
      const initial: PracticesContext = {
        ...defaultPracticesContext(FIXED_NOW),
        practices: [practice("bp-001")],
      };
      await savePractices(root, initial);

      const loaded = (await loadPractices(root))!;
      const result = applyRefresh(
        loaded,
        [practice("bp-001"), practice("bp-002")],
        WEEK_LATER,
      );
      await savePractices(root, result.next);

      const reloaded = (await loadPractices(root))!;
      nodeAssert.equal(reloaded.version, "1.1");
      nodeAssert.equal(reloaded.practices.length, 2);
      nodeAssert.equal(reloaded.archivedVersions.length, 1);
      nodeAssert.equal(reloaded.archivedVersions[0]!.version, "1.0");

      // Serialized form uses the blueprint's snake_case keys
      const raw = await readFile(practicesFilePath(root), "utf8");
      nodeAssert.match(raw, /"archived_versions"/);
      nodeAssert.match(raw, /"archived_at"/);
      nodeAssert.match(raw, /"next_check_due"/);

      // Sanity: file is valid JSON matching what we wrote
      nodeAssert.equal(raw.trimEnd(), renderPracticesJson(result.next).trimEnd());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Practice candidate validation (§15 — untrusted-web-source gate)
// ──────────────────────────────────────────────────────────────────────────

import {
  TRUSTED_PRACTICE_DOMAINS,
  isTrustedPracticeSource,
  renderCandidateValidationSummary,
  validatePracticeCandidate,
  validatePracticeCandidates,
} from "../src/practices.js";

describe("practice candidate validation", () => {
  const NOW = new Date("2026-04-24T10:00:00.000Z");

  function cleanCandidate(overrides: Partial<PracticeEntry> = {}): unknown {
    return {
      id: "bp-next",
      title: "Prefer atomic writes for ccl-state.json",
      description: "Atomic writes keep the state file consistent on crash.",
      source: "https://docs.anthropic.com/en/docs/claude-code/state",
      added: "2026-04-20",
      status: "active",
      ...overrides,
    };
  }

  it("1. clean candidate passes through unchanged with empty violations", () => {
    const { entry, violations } = validatePracticeCandidate(cleanCandidate(), NOW);
    nodeAssert.ok(entry !== null);
    nodeAssert.equal(violations.length, 0);
    nodeAssert.equal(entry!.id, "bp-next");
    nodeAssert.equal(entry!.added, "2026-04-20");
    nodeAssert.equal(entry!.status, "active");
  });

  it("2. source with untrusted domain → entry null with violation", () => {
    const { entry, violations } = validatePracticeCandidate(
      cleanCandidate({ source: "https://evil.example.com/steal" }),
      NOW,
    );
    nodeAssert.equal(entry, null);
    nodeAssert.equal(violations.length, 1);
    nodeAssert.match(violations[0]!, /untrusted domain/);
  });

  it("3. source missing https scheme (http://) → entry null", () => {
    const { entry } = validatePracticeCandidate(
      cleanCandidate({ source: "http://docs.anthropic.com/foo" }),
      NOW,
    );
    nodeAssert.equal(entry, null);
  });

  it("4. title containing a SHELL_TOKENS word → entry null", () => {
    const { entry, violations } = validatePracticeCandidate(
      cleanCandidate({ title: "Always use curl for health checks" }),
      NOW,
    );
    nodeAssert.equal(entry, null);
    nodeAssert.ok(violations.some((v) => v.includes("title")));
  });

  it("4b. title containing fullwidth ｃｕｒｌ → entry null after NFKC normalization", () => {
    const { entry, violations } = validatePracticeCandidate(
      cleanCandidate({ title: "Always use ｃｕｒｌ for health checks" }),
      NOW,
    );
    nodeAssert.equal(entry, null);
    nodeAssert.ok(violations.some((v) => v.includes("title")));
    nodeAssert.ok(violations.some((v) => v.includes("shell token")));
  });

  it("5. title > 80 chars → entry null", () => {
    const longTitle = "x".repeat(81);
    const { entry } = validatePracticeCandidate(
      cleanCandidate({ title: longTitle }),
      NOW,
    );
    nodeAssert.equal(entry, null);
  });

  it("6. description > 400 chars → entry null", () => {
    const longDesc = "x".repeat(401);
    const { entry } = validatePracticeCandidate(
      cleanCandidate({ description: longDesc }),
      NOW,
    );
    nodeAssert.equal(entry, null);
  });

  it("7. id with invalid chars → entry null", () => {
    const { entry, violations } = validatePracticeCandidate(
      cleanCandidate({ id: "BP_WITH_UPPERCASE" }),
      NOW,
    );
    nodeAssert.equal(entry, null);
    nodeAssert.ok(violations.some((v) => v.includes("id")));
  });

  it("8. missing `added` → coerced to today's YYYY-MM-DD, no violation", () => {
    const { added: _drop, ...rest } = cleanCandidate() as Record<string, unknown>;
    const { entry, violations } = validatePracticeCandidate(rest, NOW);
    nodeAssert.ok(entry !== null);
    nodeAssert.equal(violations.length, 0);
    nodeAssert.equal(entry!.added, "2026-04-24");
  });

  it("9. missing `status` → defaults to 'active'", () => {
    const { status: _drop, ...rest } = cleanCandidate() as Record<string, unknown>;
    const { entry } = validatePracticeCandidate(rest, NOW);
    nodeAssert.equal(entry?.status, "active");
  });

  it("10. unknown extra fields are silently dropped", () => {
    const { entry, violations } = validatePracticeCandidate(
      { ...(cleanCandidate() as object), extraField: "ignored", nested: { x: 1 } },
      NOW,
    );
    nodeAssert.ok(entry !== null);
    nodeAssert.equal(violations.length, 0);
    nodeAssert.equal(
      (entry as Record<string, unknown>)["extraField"],
      undefined,
    );
  });

  it("11. null input → entry null, does not throw", () => {
    nodeAssert.doesNotThrow(() => validatePracticeCandidate(null, NOW));
    const { entry } = validatePracticeCandidate(null, NOW);
    nodeAssert.equal(entry, null);
  });

  it("12. batch: 3 valid + 2 invalid → valid.length===3, rejected===2", () => {
    const raws: unknown[] = [
      cleanCandidate({ id: "bp-a" }),
      cleanCandidate({ id: "bp-b" }),
      cleanCandidate({ id: "bp-c" }),
      cleanCandidate({ id: "bp-d", source: "https://evil.example.com/" }),
      cleanCandidate({ id: "bp-e", title: "use bash as default" }),
    ];
    const { valid, rejected, totalViolations } = validatePracticeCandidates(
      raws,
      NOW,
    );
    nodeAssert.equal(valid.length, 3);
    nodeAssert.equal(rejected, 2);
    nodeAssert.ok(totalViolations.length >= 2);
  });

  it("13. renderCandidateValidationSummary: all clean → returns null", () => {
    nodeAssert.equal(renderCandidateValidationSummary(0, []), null);
  });

  it("14. renderCandidateValidationSummary: rejected + violations → ⚠ with bullets", () => {
    const out = renderCandidateValidationSummary(2, [
      "bp-foo: source missing or untrusted domain",
      "bp-bar: title contains shell token",
    ]);
    nodeAssert.ok(out !== null);
    nodeAssert.match(out!, /⚠/);
    nodeAssert.match(out!, /2 candidate/);
    nodeAssert.match(out!, /source missing or untrusted domain/);
  });

  it("batch: never throws for arbitrary/garbage input", () => {
    const cases: unknown[] = [
      null,
      undefined,
      42,
      "string",
      {},
      [null, undefined, {}, { id: 1 }, [1, 2, 3]],
    ];
    for (const c of cases) {
      nodeAssert.doesNotThrow(() => validatePracticeCandidates(c, NOW));
    }
  });

  it("source: exact-match and subdomain of trusted domain both pass", () => {
    nodeAssert.equal(isTrustedPracticeSource("https://github.com/foo"), true);
    nodeAssert.equal(isTrustedPracticeSource("https://gist.github.com/foo"), true);
    nodeAssert.equal(isTrustedPracticeSource("https://notgithub.com/foo"), false);
  });

  it("TRUSTED_PRACTICE_DOMAINS is the single source of truth", () => {
    nodeAssert.ok(TRUSTED_PRACTICE_DOMAINS.includes("github.com"));
    nodeAssert.ok(TRUSTED_PRACTICE_DOMAINS.includes("docs.anthropic.com"));
  });
});

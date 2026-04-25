import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const INDEX_TS = join(__dirname, "..", "src", "index.ts");
const SECURITY_MD = join(REPO_ROOT, "SECURITY.md");

describe("security canaries — index.ts + SECURITY.md", () => {
  const indexSource = readFileSync(INDEX_TS, "utf8");

  it("index.ts emits the [ccl:elicit] audit prefix", () => {
    assert.ok(
      indexSource.includes("[ccl:elicit]"),
      "expected '[ccl:elicit]' prefix in index.ts — audit logging may have been removed",
    );
  });

  it("index.ts defines the truncate guard with ellipsis overflow", () => {
    assert.ok(
      indexSource.includes("truncate("),
      "expected 'truncate(' helper usage in index.ts",
    );
    assert.ok(
      indexSource.includes("…"),
      "expected ellipsis (U+2026) in index.ts truncate helper",
    );
  });

  it("SECURITY.md exists at the repo root", () => {
    assert.ok(
      existsSync(SECURITY_MD),
      `expected SECURITY.md at ${SECURITY_MD}`,
    );
  });

  it("SECURITY.md documents the [ccl:elicit] audit trail", () => {
    const securitySource = readFileSync(SECURITY_MD, "utf8");
    assert.ok(
      securitySource.includes("[ccl:elicit]"),
      "expected '[ccl:elicit]' reference in SECURITY.md — audit trail section may have been truncated",
    );
  });
});

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import {
  __setKeyringStoreForTesting,
  resolveApiKey,
  type KeyringStore,
} from "../src/setup.js";
import { buildLlmCall, scrubSecrets } from "../src/index.js";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const INDEX_TS = join(__dirname, "..", "src", "index.ts");
const SECURITY_MD = join(REPO_ROOT, "SECURITY.md");

// In-memory keychain shim — same pattern as setup.test.ts. Installed at
// module load so importing index.ts cannot reach the real keychain.
const mockKeychain = new Map<string, string>();
const mockKeyringStore: KeyringStore = {
  async get(service, account) {
    return mockKeychain.get(`${service}:${account}`) ?? null;
  },
  async set(service, account, value) {
    mockKeychain.set(`${service}:${account}`, value);
  },
  async delete(service, account) {
    mockKeychain.delete(`${service}:${account}`);
  },
};
__setKeyringStoreForTesting(mockKeyringStore);

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

// ──────────────────────────────────────────────────────────────────────────
// API key resolution + Anthropic client wiring
// ──────────────────────────────────────────────────────────────────────────

describe("API key resolution → Anthropic client", () => {
  beforeEach(() => {
    mockKeychain.clear();
  });

  it("key present in keychain → passed verbatim to the Anthropic constructor", async () => {
    mockKeychain.set("ccl:anthropic-api-key", "sk-ant-from-keychain-zzz");
    const captured: Array<{ apiKey?: string }> = [];
    class FakeAnthropic {
      messages = {
        create: async () => ({ content: [{ type: "text", text: "" }] }),
      };
      constructor(opts: { apiKey: string }) {
        captured.push(opts);
      }
    }
    const key = await resolveApiKey();
    const llmCall = buildLlmCall(
      key,
      FakeAnthropic as unknown as new (opts: { apiKey: string }) => never,
    );
    assert.equal(captured[0]?.apiKey, "sk-ant-from-keychain-zzz");
    assert.ok(llmCall, "buildLlmCall returned a function when key was provided");
  });

  it("keychain absent + env var set → env var used as fallback", async () => {
    const prev = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-from-env-fallback";
    try {
      const key = await resolveApiKey();
      assert.equal(
        key,
        "sk-ant-from-env-fallback",
        "env var must be returned when keychain is empty",
      );
    } finally {
      if (prev === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = prev;
    }
  });

  it("both absent → resolveApiKey returns undefined and buildLlmCall returns undefined", async () => {
    const prev = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const key = await resolveApiKey();
      assert.equal(key, undefined);
      const llmCall = buildLlmCall(key);
      assert.equal(llmCall, undefined, "no key → no LLM call constructed");
    } finally {
      if (prev !== undefined) process.env["ANTHROPIC_API_KEY"] = prev;
    }
  });
});

describe("scrubSecrets", () => {
  it("redacts Anthropic API key pattern", () => {
    const key = "sk-ant-abc123DEF456ghi789JKL0";
    const out = scrubSecrets(`key=${key}`);
    assert.ok(out.includes("[REDACTED]"), "expected [REDACTED] in output");
    assert.ok(!out.includes(key), "raw Anthropic key must not survive");
  });

  it("redacts base64 blobs >= 40 chars", () => {
    const blob = "A".repeat(40);
    const out = scrubSecrets(`payload=${blob}`);
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes(blob), "raw base64 blob must not survive");
  });

  it("redacts hex strings >= 40 chars", () => {
    const hex = "0123456789abcdef0123456789abcdef01234567"; // 40 hex chars
    const out = scrubSecrets(`commit ${hex}`);
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes(hex), "raw hex string must not survive");
  });

  it("redacts Bearer tokens", () => {
    const token = "abcdefghij-klmnopqrst"; // 21 non-whitespace chars, contains '-' so not pure base64
    const input = `Authorization: Bearer ${token}`;
    const out = scrubSecrets(input);
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes(token), "Bearer token must not survive");
  });

  it("redacts GitHub PATs", () => {
    const pat = "ghp_" + "A".repeat(36);
    const out = scrubSecrets(`token=${pat}`);
    assert.ok(out.includes("[REDACTED]"));
    assert.ok(!out.includes(pat), "raw GitHub PAT must not survive");
  });

  it("does not redact short strings (< 40 chars)", () => {
    const input = "short non-secret value";
    assert.equal(scrubSecrets(input), input);
  });

  it("does not redact prompt text 'what is your name?'", () => {
    const input = "what is your name?";
    assert.equal(
      scrubSecrets(input),
      input,
      "scrubber must not touch ordinary prompt text",
    );
  });

  it("clean response 'looks good' passes through unchanged", () => {
    assert.equal(scrubSecrets("looks good"), "looks good");
  });
});

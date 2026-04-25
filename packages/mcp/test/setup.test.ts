import { describe, it } from "node:test";
import nodeAssert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSetup, type SetupOptions } from "../src/setup.js";

// ──────────────────────────────────────────────────────────────────────────
// Harness
// ──────────────────────────────────────────────────────────────────────────

const SERVER_DIST_PATH = "/opt/ccl/dist/index.js";

async function mkFixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ccl-setup-"));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface HarnessResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

async function run(opts: SetupOptions): Promise<HarnessResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode = -1;
  const code = await runSetup({
    ...opts,
    stdout: (msg) => stdout.push(msg),
    stderr: (msg) => stderr.push(msg),
    exit: (c) => {
      exitCode = c;
    },
  });
  return {
    exitCode: exitCode === -1 ? code : exitCode,
    stdout,
    stderr,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Fresh install — no claude.json exists
// ──────────────────────────────────────────────────────────────────────────

describe("fresh install", () => {
  it("creates the config file and writes the CCL entry", async () => {
    const root = await mkFixture();
    try {
      const configPath = join(root, "claude.json");
      const { exitCode, stdout, stderr } = await run({
        configPath,
        serverDistPath: SERVER_DIST_PATH,
      });
      nodeAssert.equal(exitCode, 0);
      nodeAssert.equal(stderr.length, 0);
      nodeAssert.ok(
        stdout.some((m) => m.includes("CCL registered")),
        "success message present",
      );
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as {
        mcpServers: Record<string, { command: string; args: string[]; type: string }>;
      };
      nodeAssert.equal(parsed.mcpServers["ccl"]!.command, "node");
      nodeAssert.deepEqual(parsed.mcpServers["ccl"]!.args, [SERVER_DIST_PATH]);
      nodeAssert.equal(parsed.mcpServers["ccl"]!.type, "stdio");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves no .ccl-tmp residue alongside claude.json", async () => {
    const root = await mkFixture();
    try {
      const configPath = join(root, "claude.json");
      const { exitCode } = await run({
        configPath,
        serverDistPath: SERVER_DIST_PATH,
      });
      nodeAssert.equal(exitCode, 0);

      const tmpResidue = (await readdir(root)).filter((n) =>
        n.endsWith(".ccl-tmp"),
      );
      nodeAssert.deepEqual(
        tmpResidue,
        [],
        "atomicWriteJson must rename its randomized temp file before returning",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 2. Config directory does not yet exist
// ──────────────────────────────────────────────────────────────────────────

describe("nested config directory", () => {
  it("creates missing parent directories recursively", async () => {
    const root = await mkFixture();
    try {
      const configPath = join(root, "nested/deeper/claude.json");
      nodeAssert.equal(await pathExists(join(root, "nested")), false);
      const { exitCode } = await run({
        configPath,
        serverDistPath: SERVER_DIST_PATH,
      });
      nodeAssert.equal(exitCode, 0);
      nodeAssert.ok(await pathExists(configPath));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 3. Already registered — file untouched byte-for-byte
// ──────────────────────────────────────────────────────────────────────────

describe("already registered", () => {
  it("exits 0 without modifying the config", async () => {
    const root = await mkFixture();
    try {
      const configPath = join(root, "claude.json");
      const body =
        JSON.stringify(
          {
            mcpServers: {
              ccl: {
                command: "node",
                args: ["/prior/path/dist/index.js"],
                type: "stdio",
              },
            },
          },
          null,
          2,
        ) + "\n";
      await writeFile(configPath, body, "utf8");

      const before = await readFile(configPath, "utf8");
      const { exitCode, stdout, stderr } = await run({
        configPath,
        serverDistPath: SERVER_DIST_PATH,
      });
      const after = await readFile(configPath, "utf8");

      nodeAssert.equal(exitCode, 0);
      nodeAssert.equal(stderr.length, 0);
      nodeAssert.ok(
        stdout.some((m) => m.includes("already registered")),
        "already-registered message present",
      );
      nodeAssert.equal(after, before, "config file must be byte-identical");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 4. Existing config with other MCP servers
// ──────────────────────────────────────────────────────────────────────────

describe("existing config with other MCP servers", () => {
  it("preserves other entries and adds CCL", async () => {
    const root = await mkFixture();
    try {
      const configPath = join(root, "claude.json");
      const initial = {
        theme: "dark",
        mcpServers: {
          other: {
            command: "node",
            args: ["/opt/other/bin.js"],
            type: "stdio",
          },
        },
      };
      await writeFile(configPath, JSON.stringify(initial, null, 2) + "\n", "utf8");

      const { exitCode } = await run({
        configPath,
        serverDistPath: SERVER_DIST_PATH,
      });
      nodeAssert.equal(exitCode, 0);

      const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
        theme: string;
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      nodeAssert.equal(parsed.theme, "dark", "unrelated top-level keys preserved");
      nodeAssert.equal(
        parsed.mcpServers["other"]!.args[0],
        "/opt/other/bin.js",
        "other MCP server preserved",
      );
      nodeAssert.deepEqual(parsed.mcpServers["ccl"]!.args, [SERVER_DIST_PATH]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 5. Malformed JSON — stderr + exit 1 + file untouched
// ──────────────────────────────────────────────────────────────────────────

describe("malformed JSON", () => {
  it("reports path, exits 1, leaves the file as-is", async () => {
    const root = await mkFixture();
    try {
      const configPath = join(root, "claude.json");
      const original = "{ this is not valid json";
      await writeFile(configPath, original, "utf8");

      const { exitCode, stdout, stderr } = await run({
        configPath,
        serverDistPath: SERVER_DIST_PATH,
      });
      nodeAssert.equal(exitCode, 1);
      nodeAssert.equal(stdout.length, 0);
      nodeAssert.ok(
        stderr.some((m) => m.includes(configPath)),
        "stderr mentions the path",
      );
      nodeAssert.ok(
        stderr.some((m) => m.includes("Could not parse")),
        "stderr has the malformed-config message",
      );
      const after = await readFile(configPath, "utf8");
      nodeAssert.equal(after, original, "file must be untouched");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 6. Config exists but mcpServers key is absent
// ──────────────────────────────────────────────────────────────────────────

describe("missing mcpServers key", () => {
  it("creates mcpServers and registers CCL", async () => {
    const root = await mkFixture();
    try {
      const configPath = join(root, "claude.json");
      await writeFile(
        configPath,
        JSON.stringify({ theme: "dark" }, null, 2) + "\n",
        "utf8",
      );

      const { exitCode } = await run({
        configPath,
        serverDistPath: SERVER_DIST_PATH,
      });
      nodeAssert.equal(exitCode, 0);

      const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
        theme: string;
        mcpServers: Record<string, { args: string[] }>;
      };
      nodeAssert.equal(parsed.theme, "dark");
      nodeAssert.deepEqual(parsed.mcpServers["ccl"]!.args, [SERVER_DIST_PATH]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 7. Atomic write — .ccl-tmp does not linger after success
// ──────────────────────────────────────────────────────────────────────────

describe("atomic write", () => {
  it("leaves no .ccl-tmp residue after a successful write", async () => {
    const root = await mkFixture();
    try {
      const configPath = join(root, "claude.json");
      const { exitCode } = await run({
        configPath,
        serverDistPath: SERVER_DIST_PATH,
      });
      nodeAssert.equal(exitCode, 0);

      const entries = await readdir(root);
      const tmpResidue = entries.filter((name) => name.endsWith(".ccl-tmp"));
      nodeAssert.deepEqual(tmpResidue, [], "no temp files should remain");
      nodeAssert.ok(entries.includes("claude.json"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("two back-to-back writes both succeed and produce identical content", async () => {
    const root = await mkFixture();
    try {
      const configPath = join(root, "claude.json");

      const first = await run({ configPath, serverDistPath: SERVER_DIST_PATH });
      nodeAssert.equal(first.exitCode, 0);
      const firstBytes = await readFile(configPath, "utf8");

      await unlink(configPath);

      const second = await run({ configPath, serverDistPath: SERVER_DIST_PATH });
      nodeAssert.equal(second.exitCode, 0);
      const secondBytes = await readFile(configPath, "utf8");

      nodeAssert.equal(
        secondBytes,
        firstBytes,
        "two consecutive writes should produce identical content",
      );

      const tmpResidue = (await readdir(root)).filter((n) =>
        n.endsWith(".ccl-tmp"),
      );
      nodeAssert.deepEqual(
        tmpResidue,
        [],
        "no temp files should remain after either write",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Security — file permissions on claude.json
// ──────────────────────────────────────────────────────────────────────────

describe("security — claude.json permissions", () => {
  it("fresh install writes claude.json with mode 0o600", async () => {
    const root = await mkFixture();
    try {
      const configPath = join(root, "claude.json");
      const { exitCode } = await run({
        configPath,
        serverDistPath: SERVER_DIST_PATH,
      });
      nodeAssert.equal(exitCode, 0);
      if (process.platform === "win32") return; // mode bits not meaningful
      const st = await stat(configPath);
      nodeAssert.equal(
        st.mode & 0o777,
        0o600,
        `expected mode 0o600, got 0o${(st.mode & 0o777).toString(8)}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns on pre-existing world-readable config and remediates it to 0o600", async () => {
    const root = await mkFixture();
    try {
      const configPath = join(root, "claude.json");
      await writeFile(
        configPath,
        JSON.stringify({ theme: "dark" }, null, 2) + "\n",
        "utf8",
      );
      if (process.platform !== "win32") {
        await chmod(configPath, 0o644);
      }
      const { exitCode, stderr } = await run({
        configPath,
        serverDistPath: SERVER_DIST_PATH,
      });
      nodeAssert.equal(exitCode, 0);
      if (process.platform === "win32") return; // skip mode assertions on Windows
      nodeAssert.ok(
        stderr.some((m) => m.includes("⚠") && m.includes("world-readable")),
        `expected world-readable warning on stderr, got ${JSON.stringify(stderr)}`,
      );
      const st = await stat(configPath);
      nodeAssert.equal(
        st.mode & 0o777,
        0o600,
        `expected mode 0o600 after remediation, got 0o${(st.mode & 0o777).toString(8)}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("swallows fs.stat failures and completes setup successfully", async () => {
    const root = await mkFixture();
    try {
      // Config path inside a nested dir that does not yet exist — stat will
      // throw ENOENT before the write path creates the parent. The warn helper
      // must swallow that error and setup must still complete.
      const configPath = join(root, "nested/does-not-yet-exist/claude.json");
      const { exitCode, stderr } = await run({
        configPath,
        serverDistPath: SERVER_DIST_PATH,
      });
      nodeAssert.equal(exitCode, 0);
      nodeAssert.ok(
        !stderr.some((m) => m.includes("world-readable")),
        "no warning when the file does not yet exist",
      );
      // Sanity: the file got created.
      nodeAssert.ok(await pathExists(configPath));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Bonus — Node version guard
// ──────────────────────────────────────────────────────────────────────────

describe("node version guard", () => {
  it("exits 1 with the node-version error on Node < 18", async () => {
    const root = await mkFixture();
    try {
      const configPath = join(root, "claude.json");
      const { exitCode, stderr, stdout } = await run({
        configPath,
        serverDistPath: SERVER_DIST_PATH,
        nodeVersion: "v16.20.0",
      });
      nodeAssert.equal(exitCode, 1);
      nodeAssert.equal(stdout.length, 0);
      nodeAssert.ok(
        stderr.some((m) => m.includes("Node.js 18 or higher")),
      );
      nodeAssert.equal(await pathExists(configPath), false, "no file should be created");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

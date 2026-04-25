#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────────
// Phase 7 — `npx ccl` setup script.
// Registers CCL as an MCP server in Claude Code's config (§3, §19, §20).
//
// All interactive surface-area is dependency-injected for testability:
//   configPath / nodeVersion / serverDistPath / exit / stdout / stderr.
// ────────────────────────────────────────────────────────────────────────────

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

import { FILE_MODE_PRIVATE } from "@ccl/core";

// ────────────────────────────────────────────────────────────────────────────
// User-facing strings
// ────────────────────────────────────────────────────────────────────────────

const MSG_SUCCESS =
  "✓ CCL registered. Open Claude Code and type /ccl to get started.";

const MSG_ALREADY_REGISTERED =
  "✓ CCL is already registered. Open Claude Code and type /ccl to get started.";

const ERR_NODE_VERSION =
  "✗ CCL requires Node.js 18 or higher. Download it at https://nodejs.org";

const ERR_MALFORMED_CONFIG = (path: string): string =>
  `✗ Could not parse Claude Code config at ${path}. ` +
  `Fix or delete the file and run npx ccl again.`;

const ERR_PERMISSION = (path: string): string =>
  `✗ Permission denied writing to ${path}. ` +
  `Check file permissions and run npx ccl again.`;

const ERR_UNEXPECTED = (msg: string): string =>
  `✗ Unexpected error during CCL setup: ${msg}`;

const WARN_WORLD_READABLE = (path: string): string =>
  `⚠  ${path} is world-readable. CCL will restrict it to 0600.`;

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface SetupOptions {
  configPath?: string;
  exit?: (code: number) => void;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  nodeVersion?: string;
  serverDistPath?: string;
}

interface CclServerEntry {
  command: string;
  args: string[];
  type: "stdio";
}

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

const CONFIG_ATOMIC_SUFFIX = ".ccl-tmp";
const MIN_NODE_MAJOR = 18;
const CCL_KEY = "ccl";

// ────────────────────────────────────────────────────────────────────────────
// Default config-path resolver (§3, §8.3)
// Priority:
//   1. ~/.claude/claude.json if it exists.
//   2. Platform-specific equivalent if it exists.
//   3. ~/.claude/claude.json (will be created).
// ────────────────────────────────────────────────────────────────────────────

export function defaultConfigPath(): string {
  const primary = resolve(homedir(), ".claude", "claude.json");
  if (existsSync(primary)) return primary;

  const platformPath = platformSpecificPath();
  if (platformPath && existsSync(platformPath)) return platformPath;

  return primary;
}

function platformSpecificPath(): string | null {
  if (process.platform === "darwin") {
    return resolve(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude.json",
    );
  }
  if (process.platform === "win32") {
    const appData = process.env["APPDATA"];
    if (!appData) return null;
    return resolve(appData, "Claude", "claude.json");
  }
  // Linux / other: XDG fallback
  const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? resolve(homedir(), ".config");
  return resolve(xdgConfig, "Claude", "claude.json");
}

// ────────────────────────────────────────────────────────────────────────────
// Main entry
// ────────────────────────────────────────────────────────────────────────────

export async function runSetup(opts: SetupOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((msg: string) => process.stdout.write(msg + "\n"));
  const stderr = opts.stderr ?? ((msg: string) => process.stderr.write(msg + "\n"));

  const nodeVersion = opts.nodeVersion ?? process.version;
  if (!meetsMinNodeVersion(nodeVersion)) {
    stderr(ERR_NODE_VERSION);
    return 1;
  }

  const configPath = opts.configPath ?? defaultConfigPath();
  const serverDistPath = opts.serverDistPath ?? resolve(__dirname, "index.js");

  let existing: ClaudeConfig = {};
  let configExisted = false;
  if (existsSync(configPath)) {
    configExisted = true;
    try {
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as ClaudeConfig;
      } else {
        stderr(ERR_MALFORMED_CONFIG(configPath));
        return 1;
      }
    } catch {
      stderr(ERR_MALFORMED_CONFIG(configPath));
      return 1;
    }
  }

  const mcpServers = normalizeMcpServers(existing.mcpServers);
  if (Object.prototype.hasOwnProperty.call(mcpServers, CCL_KEY)) {
    stdout(MSG_ALREADY_REGISTERED);
    return 0;
  }

  const entry: CclServerEntry = {
    command: "node",
    args: [serverDistPath],
    type: "stdio",
  };

  const updated: ClaudeConfig = {
    ...existing,
    mcpServers: {
      ...mcpServers,
      [CCL_KEY]: entry,
    },
  };

  try {
    if (!configExisted) {
      mkdirSync(dirname(configPath), { recursive: true });
    }
    warnIfWorldReadable(configPath, stderr);
    atomicWriteJson(configPath, updated, FILE_MODE_PRIVATE);
  } catch (err) {
    if (isPermissionError(err)) {
      stderr(ERR_PERMISSION(configPath));
      return 1;
    }
    stderr(ERR_UNEXPECTED(errorMessage(err)));
    return 1;
  }

  stdout(MSG_SUCCESS);
  return 0;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function meetsMinNodeVersion(version: string): boolean {
  const match = version.match(/^v?(\d+)/);
  if (!match || !match[1]) return false;
  const major = Number.parseInt(match[1], 10);
  return !Number.isNaN(major) && major >= MIN_NODE_MAJOR;
}

function normalizeMcpServers(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, unknown>) };
}

function atomicWriteJson(path: string, data: unknown, mode?: number): void {
  const tmp = `${path}.${randomBytes(8).toString("hex")}${CONFIG_ATOMIC_SUFFIX}`;
  const body = JSON.stringify(data, null, 2) + "\n";
  const opts =
    mode === undefined
      ? { encoding: "utf8" as const }
      : { encoding: "utf8" as const, mode };
  writeFileSync(tmp, body, opts);
  renameSync(tmp, path);
}

function warnIfWorldReadable(
  path: string,
  stderr: (msg: string) => void,
): void {
  try {
    const st = statSync(path);
    if ((st.mode & 0o004) !== 0) {
      stderr(WARN_WORLD_READABLE(path));
    }
  } catch {
    // File absent or un-stattable — nothing to warn about. Setup continues.
  }
}

function isPermissionError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return code === "EACCES" || code === "EPERM";
  }
  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ────────────────────────────────────────────────────────────────────────────
// CLI entry — only runs when invoked as the bin script, not when imported.
// ────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  runSetup()
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(ERR_UNEXPECTED(errorMessage(err)) + "\n");
      process.exit(1);
    });
}

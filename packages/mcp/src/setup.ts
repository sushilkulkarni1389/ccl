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

const MSG_RESTART =
  "Restart Claude Code to apply any config changes.";

const MSG_NO_KEY_HINT =
  "\nℹ️  For skill generation and plan customization, set your API key:\n" +
  "     npx ccl --set-key sk-ant-...\n" +
  "     Without it, CCL scaffolds everything using static templates.";

const MSG_KEY_AUTO_WIRED =
  "\n✓ API key detected and configured automatically.";

const MSG_KEY_SET_CLI = "✓ API key saved to system keychain.";

const MSG_KEY_REMOVED_CLI = "✓ API key removed.";

const MSG_NO_KEY_LIST =
  "No key set. Run: npx ccl --set-key sk-ant-...";

const MSG_ENV_ONLY =
  "Key set via environment variable (ANTHROPIC_API_KEY) — keychain not used";

const MSG_BOTH_WARNING =
  "⚠  Both ANTHROPIC_API_KEY env var and a keychain entry exist — env var takes precedence";

const MSG_KEY_MIGRATED =
  "✓ Migrated API key from claude.json to system keychain.";

const MSG_HELP = [
  "Usage:",
  "  npx ccl                    Register CCL as an MCP server",
  "  npx ccl --set-key <key>    Set your Anthropic API key",
  "  npx ccl --remove-key       Remove your Anthropic API key",
  "  npx ccl --list-key         Show the masked active key + storage location",
  "  npx ccl --help             Show this help",
].join("\n");

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

const ERR_KEY_FORMAT_INVALID =
  "CCL error: key format invalid. Expected sk-ant-... (20+ chars).";

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

export interface KeyCommandOptions {
  configPath?: string;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

interface CclServerEntry {
  command: string;
  args: string[];
  type: "stdio";
  env?: Record<string, string>;
}

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

const CONFIG_ATOMIC_SUFFIX = ".ccl-tmp";
const MIN_NODE_MAJOR = 18;
const CCL_KEY = "ccl";
const ANTHROPIC_KEY_ENV = "ANTHROPIC_API_KEY";
const KEY_PREFIX = "sk-ant-";
const KEY_MIN_LENGTH = 20;
const KEYRING_SERVICE = "ccl";
const KEYRING_ACCOUNT = "anthropic-api-key";

// ────────────────────────────────────────────────────────────────────────────
// Keyring abstraction
//
// The default store dynamic-imports @napi-rs/keyring so that systems without
// a usable keychain backend (e.g. headless Linux without libsecret) can still
// load this module — failures surface only when a key op is attempted, where
// they are caught and degraded to the env-var fallback.
//
// __setKeyringStoreForTesting replaces the live store with an in-memory shim;
// it is the seam used by setup.test.ts and index.test.ts. Marked with the __
// prefix to make accidental production use visually obvious.
// ────────────────────────────────────────────────────────────────────────────

export interface KeyringStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

const realKeyringStore: KeyringStore = {
  async get(service, account) {
    const mod = await import("@napi-rs/keyring");
    const entry = new mod.AsyncEntry(service, account);
    const v = await entry.getPassword();
    return v ?? null;
  },
  async set(service, account, value) {
    const mod = await import("@napi-rs/keyring");
    const entry = new mod.AsyncEntry(service, account);
    await entry.setPassword(value);
  },
  async delete(service, account) {
    const mod = await import("@napi-rs/keyring");
    const entry = new mod.AsyncEntry(service, account);
    try {
      await entry.deletePassword();
    } catch {
      // No entry — idempotent delete.
    }
  },
};

let keyringStore: KeyringStore = realKeyringStore;

export function __setKeyringStoreForTesting(store: KeyringStore | null): void {
  keyringStore = store ?? realKeyringStore;
}

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
// Main entry — register CCL
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
  const existingCclEntry = mcpServers[CCL_KEY];
  const isAlreadyRegistered = isPlainObject(existingCclEntry);

  // Detect a pre-existing plaintext key under mcpServers.ccl.env so we can
  // migrate it into the keychain and strip it from disk in one pass.
  const legacyKey = isAlreadyRegistered
    ? extractLegacyKey(existingCclEntry as Record<string, unknown>)
    : null;

  let migrated = false;
  if (legacyKey !== null) {
    try {
      await keyringStore.set(KEYRING_SERVICE, KEYRING_ACCOUNT, legacyKey);
      migrated = true;
    } catch {
      // Migration best-effort: leave json as-is if keychain is unreachable.
    }
  }

  if (isAlreadyRegistered && !migrated) {
    stdout(MSG_ALREADY_REGISTERED);
    return 0;
  }

  const entry: Record<string, unknown> = isAlreadyRegistered
    ? stripKeyFromEntry(existingCclEntry as Record<string, unknown>)
    : { command: "node", args: [serverDistPath], type: "stdio" };

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

  // Best-effort auto-wire of ANTHROPIC_API_KEY from the calling environment.
  // Skip when migration already populated the keychain — env var would clobber.
  let autoWired = false;
  if (!migrated) {
    const envKey = process.env[ANTHROPIC_KEY_ENV];
    if (envKey && isValidKeyFormat(envKey)) {
      try {
        await keyringStore.set(KEYRING_SERVICE, KEYRING_ACCOUNT, envKey);
        autoWired = true;
      } catch {
        // Best-effort — user can still run --set-key later.
      }
    }
  }

  if (migrated) stdout(MSG_KEY_MIGRATED);
  if (isAlreadyRegistered) {
    stdout(MSG_ALREADY_REGISTERED);
  } else {
    stdout(MSG_SUCCESS + (autoWired ? MSG_KEY_AUTO_WIRED : MSG_NO_KEY_HINT));
  }
  stdout(MSG_RESTART);
  return 0;
}

function extractLegacyKey(entry: Record<string, unknown>): string | null {
  const env = entry["env"];
  if (!isPlainObject(env)) return null;
  const v = env[ANTHROPIC_KEY_ENV];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function stripKeyFromEntry(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...entry };
  if (!isPlainObject(next["env"])) return next;
  const nextEnv = { ...(next["env"] as Record<string, unknown>) };
  delete nextEnv[ANTHROPIC_KEY_ENV];
  if (Object.keys(nextEnv).length === 0) {
    delete next["env"];
  } else {
    next["env"] = nextEnv;
  }
  return next;
}

// ────────────────────────────────────────────────────────────────────────────
// Key management
//
// SECURITY INVARIANTS — the API key value:
//  - is never written to stdout or stderr;
//  - is never logged or sent through the elicitation audit trail;
//  - is never persisted to claude.json, ccl-state.json, ccl-practices.json,
//    or any other on-disk CCL file;
//  - lives only inside the OS keychain (macOS Keychain, Windows Credential
//    Vault, libsecret on Linux) under service "ccl" / account
//    "anthropic-api-key".
// ────────────────────────────────────────────────────────────────────────────

export async function setApiKey(
  key: string,
  configPath?: string,
): Promise<void> {
  await keyringStore.set(KEYRING_SERVICE, KEYRING_ACCOUNT, key);
  cleanLegacyKeyFromConfig(configPath ?? defaultConfigPath());
}

export async function removeApiKey(configPath?: string): Promise<void> {
  await keyringStore.delete(KEYRING_SERVICE, KEYRING_ACCOUNT);
  cleanLegacyKeyFromConfig(configPath ?? defaultConfigPath());
}

export async function listApiKey(opts: KeyCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((m: string) => process.stdout.write(m + "\n"));

  let keychainKey: string | null = null;
  try {
    keychainKey = await keyringStore.get(KEYRING_SERVICE, KEYRING_ACCOUNT);
  } catch {
    // Keyring backend unavailable — treat as absent.
  }

  const envRaw = process.env[ANTHROPIC_KEY_ENV];
  const envKey = envRaw && envRaw.length > 0 ? envRaw : null;

  if (keychainKey && envKey) {
    stdout(MSG_BOTH_WARNING);
    stdout(`   Keychain: ${maskKey(keychainKey)}`);
    stdout(`   Env var:  ${maskKey(envKey)}`);
  } else if (keychainKey) {
    stdout(`Key set: ${maskKey(keychainKey)}  (${keychainBackendName()})`);
  } else if (envKey) {
    stdout(MSG_ENV_ONLY);
  } else {
    stdout(MSG_NO_KEY_LIST);
  }
  return 0;
}

function maskKey(key: string): string {
  if (key.length <= 14) return key;
  return `${key.slice(0, 10)}...${key.slice(-4)}`;
}

function keychainBackendName(): string {
  if (process.platform === "darwin") return "macOS Keychain";
  if (process.platform === "win32") return "Windows Credential Vault";
  return "libsecret";
}

export async function resolveApiKey(): Promise<string | undefined> {
  try {
    const stored = await keyringStore.get(KEYRING_SERVICE, KEYRING_ACCOUNT);
    if (stored) return stored;
  } catch {
    // Keyring backend unavailable — fall through to env var.
  }
  const envKey = process.env[ANTHROPIC_KEY_ENV];
  return envKey && envKey.length > 0 ? envKey : undefined;
}

export function runHelp(opts: KeyCommandOptions = {}): number {
  const stdout = opts.stdout ?? ((m: string) => process.stdout.write(m + "\n"));
  stdout(MSG_HELP);
  return 0;
}

// Strip a legacy plaintext key out of mcpServers.ccl.env, if present, and
// rewrite the config atomically. No-op when the file is absent, malformed,
// or already key-free — supports idempotent migration on every set/remove.
function cleanLegacyKeyFromConfig(configPath: string): void {
  if (!existsSync(configPath)) return;
  let config: ClaudeConfig;
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) return;
    config = parsed as ClaudeConfig;
  } catch {
    return;
  }
  const mcpServers = normalizeMcpServers(config.mcpServers);
  const cclEntry = mcpServers[CCL_KEY];
  if (!isPlainObject(cclEntry)) return;
  if (extractLegacyKey(cclEntry) === null) return;

  const cleaned = stripKeyFromEntry(cclEntry);
  const updated: ClaudeConfig = {
    ...config,
    mcpServers: { ...mcpServers, [CCL_KEY]: cleaned },
  };
  atomicWriteJson(configPath, updated, FILE_MODE_PRIVATE);
}

function isValidKeyFormat(key: string): boolean {
  return key.startsWith(KEY_PREFIX) && key.length >= KEY_MIN_LENGTH;
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

export interface DispatchCliOptions {
  configPath?: string;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

export async function dispatchCli(
  argv: string[],
  opts: DispatchCliOptions = {},
): Promise<number> {
  const stdout = opts.stdout ?? ((m: string) => process.stdout.write(m + "\n"));
  const stderr = opts.stderr ?? ((m: string) => process.stderr.write(m + "\n"));

  if (argv.includes("--help") || argv.includes("-h")) {
    return runHelp({ stdout });
  }
  const setKeyIdx = argv.indexOf("--set-key");
  if (setKeyIdx !== -1) {
    const key = argv[setKeyIdx + 1];
    if (!key || !isValidKeyFormat(key)) {
      stderr(ERR_KEY_FORMAT_INVALID);
      return 1;
    }
    try {
      await setApiKey(key, opts.configPath);
    } catch (err) {
      stderr(ERR_UNEXPECTED(errorMessage(err)));
      return 1;
    }
    stdout(MSG_KEY_SET_CLI);
    return 0;
  }
  if (argv.includes("--remove-key")) {
    try {
      await removeApiKey(opts.configPath);
    } catch (err) {
      stderr(ERR_UNEXPECTED(errorMessage(err)));
      return 1;
    }
    stdout(MSG_KEY_REMOVED_CLI);
    return 0;
  }
  if (argv.includes("--list-key")) {
    try {
      return await listApiKey({ stdout, stderr });
    } catch (err) {
      stderr(ERR_UNEXPECTED(errorMessage(err)));
      return 1;
    }
  }
  const setupOpts: SetupOptions = { stdout, stderr };
  if (opts.configPath !== undefined) setupOpts.configPath = opts.configPath;
  return runSetup(setupOpts);
}

if (require.main === module) {
  dispatchCli(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(ERR_UNEXPECTED(errorMessage(err)) + "\n");
      process.exit(1);
    });
}

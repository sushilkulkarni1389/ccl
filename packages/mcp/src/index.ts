// ────────────────────────────────────────────────────────────────────────────
// Phase 6 — MCP server entry point.
// Exposes a single `ccl` tool over stdio. The tool accepts an optional
// `input` string parameter; conversation state lives in
// `.claude/ccl-state.json` (conversationStep / guidedAnswers / planOverrides).
// CCL no longer uses MCP elicitation — every turn returns plain text and
// the host echoes the user's reply back via the next tool call's input.
// ────────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";

import Anthropic from "@anthropic-ai/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { GitRunner, LlmCall } from "@sushilkulkarni1389/ccl-core";

import {
  runCcl,
  type CclAdapter,
} from "./commands/ccl.js";
import { resolveApiKey } from "./setup.js";

// ────────────────────────────────────────────────────────────────────────────
// User-facing strings
// ────────────────────────────────────────────────────────────────────────────

const SERVER_NAME = "ccl";
const SERVER_VERSION = "0.0.0";
const TOOL_NAME = "ccl";
const TOOL_DESCRIPTION =
  "Scaffold a production-ready Claude Code project. Pass user replies via the optional `input` parameter; CCL tracks conversation state across calls in .claude/ccl-state.json. When this tool returns text, output the entire response to the user verbatim — do not summarize, paraphrase, shorten, or reformat any part of it.";

const LLM_MODEL = "claude-sonnet-4-6";
const LLM_MAX_TOKENS = 1000;

const MIN_NODE_MAJOR = 18;

const ERR_NODE_TOO_OLD = (major: number): string =>
  `CCL requires Node.js >= ${MIN_NODE_MAJOR}. Detected major version: ${major}.`;

const ERR_STARTUP_FAILED = "CCL MCP server failed to start";

const ELICIT_PROMPT_TRUNCATE = 80;
const ELICIT_RESPONSE_TRUNCATE = 120;

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(0, n) + "…";

export function scrubSecrets(text: string): string {
  let out = text;
  out = out.replace(/sk-ant-[A-Za-z0-9_\-]{20,}/g, "[REDACTED]");
  out = out.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[REDACTED]");
  out = out.replace(/[0-9a-fA-F]{40,}/g, "[REDACTED]");
  out = out.replace(/bearer\s+\S{20,}/gi, "[REDACTED]");
  out = out.replace(/ghp_[A-Za-z0-9]{36}/g, "[REDACTED]");
  return out;
}

// `parseChoice` maps the user's free-text input onto the integer choice
// space the CclAdapter.choose contract still uses. The state machine in
// ccl.ts mostly inspects the input string directly, but a few code paths
// still go through choose() — keep parsing aligned with the v1.3 hints
// ("Type 1 or 2", "Type yes or no", "refresh / later / never").
export function parseChoice(input: string, optCount: number): number {
  const t = input.trim().toLowerCase();
  if (!t) return -1;
  const n = Number.parseInt(t, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= optCount) return n - 1;
  if (t === "yes" || t === "y") return 0;
  if (t === "no" || t === "n") return 1;
  if (t === "refresh" || t === "accept") return 0;
  if (t === "later") return 1;
  if (t === "never") return 2;
  if (t === "review") return 2;
  if (t === "retry") return 0;
  if (t === "skip") return 1;
  return -1;
}

// ────────────────────────────────────────────────────────────────────────────
// LLM + git wrappers
// ────────────────────────────────────────────────────────────────────────────

type AnthropicCtor = new (
  opts: ConstructorParameters<typeof Anthropic>[0],
) => Anthropic;

export function buildLlmCall(
  key: string | undefined,
  AnthropicCtorOverride?: AnthropicCtor,
): LlmCall | undefined {
  if (!key) return undefined;
  const Ctor = AnthropicCtorOverride ?? Anthropic;
  const client = new Ctor({ apiKey: key });
  return async (prompt: string, systemPrompt?: string): Promise<string> => {
    try {
      const res = await client.messages.create({
        model: LLM_MODEL,
        max_tokens: LLM_MAX_TOKENS,
        ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
        messages: [{ role: "user", content: prompt }],
      });
      const block = res.content[0];
      if (!block || block.type !== "text" || !block.text) {
        throw new Error("CCL: empty response from Anthropic API");
      }
      return block.text;
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      if (e.status === 401) {
        throw new Error(
          "CCL_ERR_KEY_INVALID: Your ANTHROPIC_API_KEY is invalid or " +
            "expired. Run: npx @sushilkulkarni1389/ccl-mcp --set-key <new-key>",
        );
      }
      if (e.status === 403) {
        throw new Error(
          "CCL_ERR_KEY_FORBIDDEN: Your ANTHROPIC_API_KEY does not have " +
            "permission to call this model. Check your Anthropic plan.",
        );
      }
      if (e.status === 429) {
        throw new Error(
          "CCL_ERR_RATE_LIMITED: Anthropic API rate limit reached. " +
            "Wait a moment and try again.",
        );
      }
      if (e.status && e.status >= 500) {
        throw new Error(
          "CCL_ERR_API_DOWN: Anthropic API returned " +
            e.status +
            ". Try again in a few minutes.",
        );
      }
      if (
        e.message?.includes("ENOTFOUND") ||
        e.message?.includes("ECONNREFUSED") ||
        e.message?.includes("network")
      ) {
        throw new Error(
          "CCL_ERR_NETWORK: Could not reach Anthropic API. " +
            "Check your internet connection.",
        );
      }
      throw err;
    }
  };
}

const spawnGit: GitRunner = (args: string[], cwd: string) =>
  new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });

// ────────────────────────────────────────────────────────────────────────────
// Adapter — wires MCP logging + user input forwarding to CclAdapter.
// `ask` and `choose` no longer block on elicitation; they return the
// caller-supplied `input` value (parsed for `choose`).
// ────────────────────────────────────────────────────────────────────────────

interface AdapterOptions {
  mcpServer: McpServer;
  llmCall: LlmCall | undefined;
  transcript: string[];
  input: string;
}

function buildMcpAdapter(opts: AdapterOptions): CclAdapter {
  const s = opts.mcpServer.server;
  const userInput = opts.input;

  const say = async (message: string): Promise<void> => {
    opts.transcript.push(message);
    try {
      await s.sendLoggingMessage({ level: "info", data: message });
    } catch {
      // Client may not implement logging — transcript still captures the
      // message for the final tool response.
    }
  };

  // The audit trail logs the prompt CCL emitted and the (scrubbed) reply
  // the host forwarded back. The same `[ccl:elicit]` prefix is retained
  // for log-grep continuity with v1.2 deployments and SECURITY.md.
  const ask = async (message: string): Promise<string> => {
    try {
      await s.sendLoggingMessage({
        level: "info",
        data: `[ccl:elicit] ask | prompt="${truncate(message, ELICIT_PROMPT_TRUNCATE)}" | response="${truncate(scrubSecrets(userInput), ELICIT_RESPONSE_TRUNCATE)}"`,
      });
    } catch {
      // Client may not implement logging — audit log is best-effort.
    }
    return userInput;
  };

  const choose = async (
    message: string,
    options: string[],
  ): Promise<number> => {
    const n = parseChoice(userInput, options.length);
    try {
      const chosenLabel =
        n >= 0 && n < options.length ? options[n] ?? "" : "(invalid)";
      await s.sendLoggingMessage({
        level: "info",
        data: `[ccl:elicit] choose | prompt="${truncate(message, ELICIT_PROMPT_TRUNCATE)}" | chosen="${scrubSecrets(String(chosenLabel))}"`,
      });
    } catch {
      // Client may not implement logging — audit log is best-effort.
    }
    return n;
  };

  return {
    cwd: process.cwd(),
    ask,
    choose,
    say,
    ...(opts.llmCall !== undefined ? { llmCall: opts.llmCall } : {}),
    now: () => new Date(),
    runGitCommand: spawnGit,
    initGit: true,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tool handler
// ────────────────────────────────────────────────────────────────────────────

async function handleCclTool(mcpServer: McpServer, input?: string) {
  const apiKey = await resolveApiKey();
  const llmCall = buildLlmCall(apiKey);
  const transcript: string[] = [];
  const adapter = buildMcpAdapter({
    mcpServer,
    llmCall,
    transcript,
    input: input ?? "",
  });

  try {
    await runCcl(adapter, input);
    const body = transcript.join("\n\n");
    const text = [
      "IMPORTANT: Show the following to the user exactly as written. Do not summarize or paraphrase.",
      body,
    ].join("\n\n");
    return { content: [{ type: "text" as const, text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const body = transcript.join("\n\n");
    const text = [
      "IMPORTANT: Show the following to the user exactly as written. Do not summarize or paraphrase.",
      `${body}\n\nCCL aborted: ${message}`,
    ].join("\n\n");
    return {
      content: [{ type: "text" as const, text }],
      isError: true,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Entry — no module-level server instance; everything is constructed per run.
// ────────────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const nodeMajor = Number.parseInt(
    process.versions.node.split(".")[0] ?? "0",
    10,
  );
  if (Number.isNaN(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    process.stderr.write(ERR_NODE_TOO_OLD(nodeMajor) + "\n");
    process.exit(1);
  }

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {}, tools: {} } },
  );

  server.registerTool(
    TOOL_NAME,
    {
      description: TOOL_DESCRIPTION,
      inputSchema: { input: z.string().optional() },
      annotations: {
        title: "Claude Context Loader",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ input }) => handleCclTool(server, input),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${ERR_STARTUP_FAILED}: ${message}\n`);
    process.exit(1);
  });
}

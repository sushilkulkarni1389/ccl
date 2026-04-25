// ────────────────────────────────────────────────────────────────────────────
// Phase 6 — MCP server entry point.
// Exposes a single `ccl` tool over stdio. Interactive prompts are backed by
// MCP elicitation. If the connecting client does not advertise elicitation
// support, the tool aborts with a clean error (logged + returned) rather than
// hanging on the first ask/choose.
// ────────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";

import Anthropic from "@anthropic-ai/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { GitRunner, LlmCall } from "@ccl/core";

import {
  runCcl,
  type CclAdapter,
  type CclRunResult,
} from "./commands/ccl.js";

// ────────────────────────────────────────────────────────────────────────────
// User-facing strings (top-of-file, matching Phase 5 discipline)
// ────────────────────────────────────────────────────────────────────────────

const SERVER_NAME = "ccl";
const SERVER_VERSION = "0.0.0";
const TOOL_NAME = "ccl";
const TOOL_DESCRIPTION =
  "Scaffold a production-ready Claude Code project in the current directory. Interactive — requires an MCP client with elicitation support.";

const LLM_MODEL = "claude-sonnet-4-6";
const LLM_MAX_TOKENS = 4096;

const MIN_NODE_MAJOR = 18;

const ERR_NODE_TOO_OLD = (major: number): string =>
  `CCL requires Node.js >= ${MIN_NODE_MAJOR}. Detected major version: ${major}.`;

const ERR_STARTUP_FAILED = "CCL MCP server failed to start";

const ERR_NO_ELICITATION =
  "This MCP client does not advertise elicitation support. CCL needs an elicitation-capable client (e.g. Claude Code) to ask interactive questions. Tool call aborted — no files were written.";

const ERR_NO_API_KEY =
  "ANTHROPIC_API_KEY is not set in the server environment. CCL uses the Anthropic API for skill classification and generation. Set ANTHROPIC_API_KEY and retry.";

const ERR_USER_CANCELLED =
  "User cancelled or declined an elicitation prompt — CCL stopped cleanly. No files were written beyond steps already completed before cancellation.";

const ERR_ELICITATION_SHAPE =
  "Elicitation response did not match the expected shape.";

const ELICIT_PROMPT_TRUNCATE = 80;
const ELICIT_RESPONSE_TRUNCATE = 120;

const truncate = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(0, n) + "…";

const STATUS_LABELS: Record<CclRunResult["status"], string> = {
  complete: "✅ CCL scaffold complete.",
  cancelled: "CCL aborted — no changes applied.",
  "refresh-only": "Best practices refresh completed.",
  resumed: "Resumed scaffold — finished.",
  skipped: "Scaffold skipped.",
};

// ────────────────────────────────────────────────────────────────────────────
// LLM + git wrappers
// ────────────────────────────────────────────────────────────────────────────

function buildAnthropicLlmCall(client: Anthropic): LlmCall {
  return async (prompt, systemPrompt) => {
    const response = await client.messages.create({
      model: LLM_MODEL,
      max_tokens: LLM_MAX_TOKENS,
      ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
      messages: [{ role: "user", content: prompt }],
    });
    const parts: string[] = [];
    for (const block of response.content) {
      if (block.type === "text") parts.push(block.text);
    }
    return parts.join("");
  };
}

const spawnGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: "ignore" });
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });

// ────────────────────────────────────────────────────────────────────────────
// Adapter — wires MCP primitives (elicitation + logging) to CclAdapter.
// ────────────────────────────────────────────────────────────────────────────

interface AdapterOptions {
  mcpServer: McpServer;
  llmCall: LlmCall;
  transcript: string[];
}

function buildMcpAdapter(opts: AdapterOptions): CclAdapter {
  const s = opts.mcpServer.server;

  const say = async (message: string): Promise<void> => {
    opts.transcript.push(message);
    try {
      await s.sendLoggingMessage({ level: "info", data: message });
    } catch {
      // Client may not implement logging — transcript still captures the
      // message for the final tool response.
    }
  };

  const ask = async (message: string): Promise<string> => {
    const result = await s.elicitInput({
      message,
      requestedSchema: {
        type: "object",
        properties: {
          value: {
            type: "string",
            description: message,
          },
        },
        required: ["value"],
      },
    });
    if (result.action !== "accept") throw new Error(ERR_USER_CANCELLED);
    const val = result.content?.["value"];
    if (typeof val !== "string") throw new Error(ERR_ELICITATION_SHAPE);
    try {
      await s.sendLoggingMessage({
        level: "info",
        data: `[ccl:elicit] ask | prompt="${truncate(message, ELICIT_PROMPT_TRUNCATE)}" | response="${truncate(val, ELICIT_RESPONSE_TRUNCATE)}"`,
      });
    } catch {
      // Client may not implement logging — audit log is best-effort.
    }
    return val;
  };

  const choose = async (message: string, options: string[]): Promise<number> => {
    const enumValues = options.map((_, i) => String(i));
    const result = await s.elicitInput({
      message,
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            description: message,
            enum: enumValues,
            enumNames: options,
          },
        },
        required: ["choice"],
      },
    });
    if (result.action !== "accept") throw new Error(ERR_USER_CANCELLED);
    const raw = result.content?.["choice"];
    if (typeof raw !== "string") throw new Error(ERR_ELICITATION_SHAPE);
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n) || n < 0 || n >= options.length) {
      throw new Error(ERR_ELICITATION_SHAPE);
    }
    const chosenLabel = options[n] ?? "";
    try {
      await s.sendLoggingMessage({
        level: "info",
        data: `[ccl:elicit] choose | prompt="${truncate(message, ELICIT_PROMPT_TRUNCATE)}" | chosen="${chosenLabel}"`,
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
    llmCall: opts.llmCall,
    now: () => new Date(),
    runGitCommand: spawnGit,
    initGit: true,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tool handler
// ────────────────────────────────────────────────────────────────────────────

async function handleCclTool(mcpServer: McpServer) {
  const caps = mcpServer.server.getClientCapabilities();
  if (!caps?.elicitation) {
    try {
      await mcpServer.server.sendLoggingMessage({
        level: "error",
        data: ERR_NO_ELICITATION,
      });
    } catch {
      // Ignore — we still return the error via the tool response below.
    }
    return {
      content: [{ type: "text" as const, text: ERR_NO_ELICITATION }],
      isError: true,
    };
  }

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    return {
      content: [{ type: "text" as const, text: ERR_NO_API_KEY }],
      isError: true,
    };
  }

  const client = new Anthropic({ apiKey });
  const transcript: string[] = [];
  const adapter = buildMcpAdapter({
    mcpServer,
    llmCall: buildAnthropicLlmCall(client),
    transcript,
  });

  try {
    const result = await runCcl(adapter);
    const summary = STATUS_LABELS[result.status];
    const body = transcript.join("\n\n");
    const text = body.length > 0 ? `${body}\n\n${summary}` : summary;
    return { content: [{ type: "text" as const, text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const body = transcript.join("\n\n");
    const text =
      body.length > 0
        ? `${body}\n\nCCL aborted: ${message}`
        : `CCL aborted: ${message}`;
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
      annotations: {
        title: "Claude Context Loader",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async () => handleCclTool(server),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${ERR_STARTUP_FAILED}: ${message}\n`);
  process.exit(1);
});

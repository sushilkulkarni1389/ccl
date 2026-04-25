import * as yaml from "yaml";

import { SHELL_TOKENS } from "../override-validator.js";
import type { AgentContext } from "./types.js";

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export const AGENT_READONLY_TOOLS: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "LS",
];

export interface AgentValidationResult {
  valid: boolean;
  violations: string[];
}

const AGENT_FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
const AGENT_BODY_SHELL_TOKEN_RE = new RegExp(
  `\\b(${SHELL_TOKENS.join("|")})\\b`,
  "i",
);

export function validateAgentMd(content: string): AgentValidationResult {
  const violations: string[] = [];
  if (typeof content !== "string" || content.length === 0) {
    return { valid: true, violations };
  }

  const fmMatch = content.match(AGENT_FRONTMATTER_RE);
  if (!fmMatch) return { valid: true, violations };

  let parsed: unknown;
  try {
    parsed = yaml.parse(fmMatch[1]!, { schema: "failsafe" });
  } catch {
    return { valid: true, violations };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: true, violations };
  }

  const tools = (parsed as Record<string, unknown>)["tools"];
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (typeof t !== "string") continue;
      if (!AGENT_READONLY_TOOLS.includes(t)) {
        violations.push(`tools: '${t}' is not permitted for read-only agents`);
      }
    }
  }

  const body = content.slice(fmMatch[0].length);
  for (const heading of ["## Purpose", "## Steps"]) {
    const block = extractAgentSection(body, heading);
    if (block === null) continue;
    const tokenMatch = block.match(AGENT_BODY_SHELL_TOKEN_RE);
    if (tokenMatch) {
      violations.push(
        `body: contains shell token '${tokenMatch[1]!.toLowerCase()}'`,
      );
    }
  }

  return { valid: violations.length === 0, violations };
}

function extractAgentSection(body: string, heading: string): string | null {
  const re = new RegExp(`^${heading}\\s*\\n`, "m");
  const start = body.match(re);
  if (!start || start.index === undefined) return null;
  const rest = body.slice(start.index + start[0].length);
  const nextHeading = rest.search(/^## /m);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

export class InvalidAgentNameError extends Error {
  constructor(name: string) {
    super(
      `Agent name "${name}" is invalid. Use lowercase letters, digits, and hyphens only, starting with a letter or digit.`,
    );
    this.name = "InvalidAgentNameError";
  }
}

function formatToolList(tools: string[]): string {
  return `[${tools.join(", ")}]`;
}

function bulletList(items: string[]): string {
  if (items.length === 0) return "_(none)_";
  return items.map((item) => `- ${item}`).join("\n");
}

export function renderAgentMd(ctx: AgentContext): string {
  if (!AGENT_NAME_RE.test(ctx.name)) {
    throw new InvalidAgentNameError(ctx.name);
  }
  const frontmatter: string[] = [
    "---",
    `name: ${ctx.name}`,
    `description: ${ctx.description}`,
    `model: ${ctx.model}`,
    `tools: ${formatToolList(ctx.tools)}`,
  ];
  if (ctx.role.length > 0) {
    frontmatter.push(`role: ${ctx.role}`);
  }
  frontmatter.push("---");
  return `${frontmatter.join("\n")}

## Purpose
${ctx.purpose}

## Output format
${ctx.outputFormat}

## Constraints
${bulletList(ctx.constraints)}
`;
}

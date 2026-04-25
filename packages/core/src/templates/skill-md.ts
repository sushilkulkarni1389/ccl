import type { SkillContext } from "./types.js";

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export class InvalidSkillNameError extends Error {
  constructor(name: string) {
    super(
      `Skill name "${name}" is invalid. Use lowercase letters, digits, and hyphens only, starting with a letter or digit.`,
    );
    this.name = "InvalidSkillNameError";
  }
}

function formatToolList(tools: string[]): string {
  return `[${tools.join(", ")}]`;
}

function numberedList(items: string[]): string {
  if (items.length === 0) return "_(none)_";
  return items.map((item, i) => `${i + 1}. ${item}`).join("\n");
}

function bulletList(items: string[]): string {
  if (items.length === 0) return "_(none)_";
  return items.map((item) => `- ${item}`).join("\n");
}

export function renderSkillMd(ctx: SkillContext): string {
  if (!SKILL_NAME_RE.test(ctx.name)) {
    throw new InvalidSkillNameError(ctx.name);
  }
  return `---
name: ${ctx.name}
description: ${ctx.description}
allowed-tools: ${formatToolList(ctx.allowedTools)}
---

## Steps
${numberedList(ctx.steps)}

## Verification criteria
${bulletList(ctx.verification)}

## Reference
${bulletList(ctx.references)}
`;
}

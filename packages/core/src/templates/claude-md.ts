import type { ClaudeMdContext, DirectoryEntry } from "./types.js";

export const CLAUDE_MD_LINE_LIMIT = 200;

export class ClaudeMdTooLongError extends Error {
  constructor(public readonly lineCount: number) {
    super(
      `CLAUDE.md exceeds the ${CLAUDE_MD_LINE_LIMIT}-line hard limit (got ${lineCount}). ` +
        `Trim coding rules, pitfalls, or gotchas before writing.`,
    );
    this.name = "ClaudeMdTooLongError";
  }
}

const BEHAVIORAL_GUIDELINES = `## Behavioral guidelines

### Think before coding
- State assumptions explicitly — if uncertain, ask
- If multiple interpretations exist, present them — don't pick silently
- If a simpler approach exists, say so — push back when warranted
- If something is unclear, stop and name what's confusing

### Simplicity first
- Minimum code that solves the problem — nothing speculative
- No features beyond what was asked
- No abstractions for single-use code
- If 200 lines can be 50 lines, rewrite it

### Surgical changes
- Touch only what you must — don't improve adjacent code
- Match existing style even if you'd prefer otherwise
- Every changed line must trace directly to the user's request
- Mention unrelated dead code — don't delete it

### Goal-driven execution
- Transform tasks into verifiable goals
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- For multi-step tasks, state a plan with explicit verify steps per step`;

function formatDirectories(entries: DirectoryEntry[]): string {
  if (entries.length === 0) return "_(none inferred)_";
  const width = Math.max(...entries.map((e) => e.dir.length), 12) + 2;
  return entries
    .map((e) => `${e.dir.padEnd(width, " ")}${e.description}`)
    .join("\n");
}

function bulletList(items: string[], emptyPlaceholder = "_(none)_"): string {
  if (items.length === 0) return emptyPlaceholder;
  return items.map((item) => `- ${item}`).join("\n");
}

export function renderClaudeMd(ctx: ClaudeMdContext): string {
  const content = `# ${ctx.projectName}

## What is this?
${ctx.whatIsThis}

## Stack
${bulletList(ctx.stack)}

## Where things live
${formatDirectories(ctx.directories)}

## How to run it
\`\`\`bash
${ctx.commands.dev}      # start dev server
${ctx.commands.test}     # run tests
${ctx.commands.build}    # production build
${ctx.commands.lint}     # lint + format
\`\`\`

## Coding rules
${bulletList(ctx.codingRules)}

## Testing philosophy
${ctx.testingPhilosophy}

## Common pitfalls
${bulletList(ctx.commonPitfalls)}

## Gotchas
${bulletList(ctx.gotchas)}

## Never do
${bulletList(ctx.neverDo)}

---

${BEHAVIORAL_GUIDELINES}
`;

  const lineCount = content.split("\n").length;
  if (lineCount > CLAUDE_MD_LINE_LIMIT) {
    throw new ClaudeMdTooLongError(lineCount);
  }
  return content;
}

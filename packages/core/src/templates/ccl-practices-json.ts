import type { PracticesContext, PracticeEntry } from "./types.js";

export const PRACTICES_SCHEMA_VERSION = "1.0";
export const REFRESH_INTERVAL_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ISO timestamp: ${iso}`);
  }
  return new Date(d.getTime() + days * MS_PER_DAY).toISOString();
}

export function renderPracticesJson(ctx: PracticesContext): string {
  const payload: Record<string, unknown> = {
    version: ctx.version,
    last_updated: ctx.lastUpdated,
    last_checked: ctx.lastChecked,
    next_check_due: ctx.nextCheckDue,
    practices: ctx.practices.map(serializePractice),
    archived_versions: ctx.archivedVersions.map((a) => ({
      version: a.version,
      archived_at: a.archivedAt,
      practices: a.practices.map(serializePractice),
    })),
  };
  if (ctx.refresh === "never") {
    payload["refresh"] = "never";
  }
  return JSON.stringify(payload, null, 2) + "\n";
}

function serializePractice(p: PracticeEntry): unknown {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    source: p.source,
    added: p.added,
    status: p.status,
  };
}

// Curation date for the v1.0 seeded practices. Preserved across scaffolds so
// that the refresh cycle's carry-over logic can cleanly distinguish newly
// added practices (scaffold-date) from the seed set.
export const INITIAL_PRACTICES_SEED_DATE = "2026-04-24";

function buildInitialPractices(): PracticeEntry[] {
  const added = INITIAL_PRACTICES_SEED_DATE;
  return [
    {
      id: "bp-001",
      title: "CLAUDE.md 200-line limit",
      description:
        "Keep CLAUDE.md under 200 lines. It loads fully into context at the start of every session — beyond 200 lines becomes token waste. Every line must earn its place.",
      source: "https://github.com/forrestchang/andrej-karpathy-skills",
      added,
      status: "active",
    },
    {
      id: "bp-002",
      title: "CLAUDE.md 7-section structure",
      description:
        "CLAUDE.md must answer 7 questions in order: (1) What is this — one paragraph for a senior engineer joining in 30 minutes, not Claude instructions. (2) Stack. (3) Where things live — directory map, one line per folder. (4) How to run it — exact bash commands only, no prose. (5) Coding rules. (6) Common pitfalls — what NOT to do and why, codebase-specific. (7) Gotchas — convention violations that exist for legacy reasons.",
      source: "https://www.sotaaz.com/post/karpathy-claude-md-en",
      added,
      status: "active",
    },
    {
      id: "bp-003",
      title: "Write CLAUDE.md as a staff engineer onboarding doc",
      description:
        "Write CLAUDE.md for a senior engineer who needs to be productive in 30 minutes — not as instructions directed at Claude. Context for anyone reading cold.",
      source: "https://www.sotaaz.com/post/karpathy-claude-md-en",
      added,
      status: "active",
    },
    {
      id: "bp-004",
      title: "Prefer runnable commands over prose",
      description:
        "Everywhere in CLAUDE.md, prefer exact bash commands over descriptive prose. 'npm run dev' is better than 'start the development server'.",
      source: "https://www.sotaaz.com/post/karpathy-claude-md-en",
      added,
      status: "active",
    },
    {
      id: "bp-005",
      title: "Include a Never Do section",
      description:
        "Add a 'Never Do' section to CLAUDE.md listing absolute prohibitions with reasons. Don't-do rules are more effective than do rules — LLMs have a strong tendency to add things, so explicit prohibitions are more reliably followed.",
      source: "https://www.sotaaz.com/post/karpathy-claude-md-en",
      added,
      status: "active",
    },
    {
      id: "bp-006",
      title: "Turn repeated corrections into rules",
      description:
        "If you have given the AI the same correction 3 or more times, it should become a rule in CLAUDE.md. Repeated corrections that stay in chat are wasted context.",
      source: "https://www.sotaaz.com/post/karpathy-claude-md-en",
      added,
      status: "active",
    },
    {
      id: "bp-007",
      title: "Include concrete examples in rules",
      description:
        "Abstract rules get ignored. Add before/after examples to the most important rules in CLAUDE.md. A wrong and correct example together are more reliably followed than a rule stated in prose alone.",
      source: "https://www.sotaaz.com/post/karpathy-claude-md-en",
      added,
      status: "active",
    },
    {
      id: "bp-008",
      title: "CLAUDE.md section weight ratios",
      description:
        "Recommended weight distribution for CLAUDE.md: Coding principles 30%, Project-specific rules 40%, Never Do 20%, Examples 10% (1-2 key examples only). Keeps the file dense and actionable.",
      source: "https://www.sotaaz.com/post/karpathy-claude-md-en",
      added,
      status: "active",
    },
    {
      id: "bp-009",
      title: "Think before coding",
      description:
        "Before implementing: state assumptions explicitly — if uncertain, ask. If multiple interpretations exist, present them — don't pick silently. If a simpler approach exists, say so and push back. If something is unclear, stop and name what is confusing.",
      source: "https://github.com/forrestchang/andrej-karpathy-skills",
      added,
      status: "active",
    },
    {
      id: "bp-010",
      title: "Simplicity first",
      description:
        "Write the minimum code that solves the problem — nothing speculative. No features beyond what was asked. No abstractions for single-use code. No unrequested flexibility or configurability. If 200 lines can be 50 lines, rewrite it. Ask: would a senior engineer say this is overcomplicated?",
      source: "https://github.com/forrestchang/andrej-karpathy-skills",
      added,
      status: "active",
    },
    {
      id: "bp-011",
      title: "Surgical changes",
      description:
        "Touch only what you must. Do not improve adjacent code, comments, or formatting. Do not refactor things that are not broken. Match existing style even if you would prefer otherwise. Every changed line must trace directly to the user's request. If you find unrelated dead code, mention it — do not delete it.",
      source: "https://github.com/forrestchang/andrej-karpathy-skills",
      added,
      status: "active",
    },
    {
      id: "bp-012",
      title: "Goal-driven execution",
      description:
        "Transform tasks into verifiable goals. 'Fix the bug' becomes 'write a test that reproduces it, then make it pass'. For multi-step tasks, state a plan with explicit verify steps: [step] → verify: [check]. Strong success criteria let Claude iterate independently. Weak criteria require constant clarification.",
      source: "https://github.com/forrestchang/andrej-karpathy-skills",
      added,
      status: "active",
    },
    {
      id: "bp-013",
      title: "Skills over legacy commands",
      description:
        "Use .claude/skills/<n>/SKILL.md instead of the legacy commands/ directory. Skills are lazy-loaded — full content loads only when Claude determines relevance or the user runs /<n>. Optimised descriptions improve auto-activation from ~20% to ~90%.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-014",
      title: "Skill description is the activation trigger",
      description:
        "The description field in a SKILL.md YAML frontmatter is the most critical field — it determines when Claude auto-activates the skill. Write it as a precise trigger sentence: the exact scenario in which this skill should load. Vague descriptions produce ~20% activation; precise ones produce ~90%.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-015",
      title: "Subagents use Haiku with read-only tools",
      description:
        "Subagents must always use claude-haiku-4-5 (fast, cheap) and be restricted to Read, Grep, Glob — no write tools. They return structured JSON summaries to the orchestrator. Use for: bulk file reads, security audits, doc generation, dependency mapping.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-016",
      title: "Model routing by task type",
      description:
        "Route tasks to the right model: Haiku 4.5 for bulk reads, log analysis, boilerplate. Sonnet 4.6 for daily implementation, multi-file edits, tests — this is the default orchestrator. Opus 4.7 for complex architecture decisions and heavy algorithmic work.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-017",
      title: "Use xhigh effort for agentic coding",
      description:
        "Set effort level to xhigh as the default for all agentic coding tasks. low/medium for boilerplate and renaming. high for standard feature work. xhigh for agentic coding. max for deep architectural design.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-018",
      title: "Four-phase workflow is mandatory",
      description:
        "All agentic coding must follow four phases: (1) Explore — read-only, map dependencies, list ambiguities as QUESTIONS, zero file writes. (2) Plan — full directory tree, data models, API contracts, numbered build order, verification criteria, risk flags — PAUSE and wait for human approval before proceeding. (3) Implement — strict adherence to approved plan, co-located tests, no silent scope expansion, ask before deviating. (4) Verify — run full test suite and linter, generate CHANGELOG, produce git commit message.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-019",
      title: "Mandatory pause after Plan phase",
      description:
        "Claude must always pause after completing Phase 2 (Plan) and wait for explicit human approval before starting Phase 3 (Implement). No silent continuation. No assumptions that silence means approval.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-020",
      title: "Security hooks on Bash and Write",
      description:
        "Register PreToolUse/Bash hook for allowlist validation and PostToolUse/Write hook for audit logging. Both should be present in settings.json for every project. This is the minimum viable security posture for agentic coding.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-021",
      title: "Write decisions to CLAUDE.md before Phase 3",
      description:
        "Before starting the Implement phase, write all architectural decisions, chosen approaches, and deviations from standard patterns to CLAUDE.md. This preserves context across /compact and session boundaries.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-022",
      title: "Run /compact after each phase",
      description:
        "Run /compact at the end of each workflow phase to keep context window manageable. Long contexts without compaction degrade plan quality and increase the chance of the model losing track of earlier decisions.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-023",
      title: "Delegate bulk reads to Haiku subagents",
      description:
        "Never use the orchestrator (Sonnet) to read large numbers of files. Delegate bulk file reads, dependency mapping, and codebase scanning to Haiku subagents. Return structured JSON summaries to the orchestrator. Keeps orchestrator context clean and reduces cost.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-024",
      title: "Static content first for cache prefix matching",
      description:
        "Place static content (CLAUDE.md, system instructions, large reference files) at the start of context before dynamic content. This enables cache prefix matching and reduces token cost on repeated invocations.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-025",
      title: "Nested CLAUDE.md for subdirectory scope",
      description:
        "Place additional CLAUDE.md files in subdirectories to override or extend the root for that scope. A CLAUDE.md in packages/api/ applies only when Claude is working in that directory. Keeps root CLAUDE.md focused and under the 200-line limit.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-026",
      title: "Commit settings.json, gitignore settings.local.json",
      description:
        "Always commit .claude/settings.json to git — it defines team-wide permissions, hooks, and tool allowlists. Always gitignore .claude/settings.local.json — it contains machine-local overrides that should never be shared.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-027",
      title: "Use webfetch in skills for live API docs",
      description:
        "Skills should reference live documentation URLs via webfetch rather than embedding doc content inline. This prevents skills from going stale as APIs evolve and keeps SKILL.md files concise.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-028",
      title: "Include testing philosophy in CLAUDE.md",
      description:
        "Add a single testing philosophy line to CLAUDE.md: what tests exist, how to run them, and what coverage means in this specific project. Generic testing advice is useless — project-specific philosophy is actionable.",
      source: "https://www.sotaaz.com/post/karpathy-claude-md-en",
      added,
      status: "active",
    },
    {
      id: "bp-029",
      title: ".claudeignore excludes noisy files from context",
      description:
        "Use .claudeignore to exclude node_modules, build outputs, logs, test fixtures, and other high-volume low-signal files from Claude's context. Every file Claude reads costs tokens — .claudeignore is a cost and quality control tool.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
    {
      id: "bp-030",
      title: "Co-locate tests with implementation",
      description:
        "During the Implement phase, write tests alongside the code they test — not in a separate pass at the end. Co-located tests catch regressions immediately and make the verify phase faster.",
      source: "https://docs.anthropic.com/en/docs/claude-code",
      added,
      status: "active",
    },
  ];
}

export function defaultPracticesContext(now: Date = new Date()): PracticesContext {
  const nowIso = now.toISOString();
  return {
    version: PRACTICES_SCHEMA_VERSION,
    lastUpdated: nowIso,
    lastChecked: nowIso,
    nextCheckDue: addDays(nowIso, REFRESH_INTERVAL_DAYS),
    practices: buildInitialPractices(),
    archivedVersions: [],
  };
}

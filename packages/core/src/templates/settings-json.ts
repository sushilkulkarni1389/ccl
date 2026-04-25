import type { HookEntry, SettingsContext } from "./types.js";

export const DEFAULT_ALLOW: string[] = [
  "Read",
  "Write",
  "Bash(git:*)",
  "Bash(npm:*)",
  "Bash(npx:*)",
];

export const DEFAULT_DENY: string[] = [
  "Bash(rm -rf:*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
];

export const DEFAULT_PRE_HOOKS: HookEntry[] = [
  { matcher: "Bash", command: "ccl-validate-bash" },
];

export const DEFAULT_POST_HOOKS: HookEntry[] = [
  { matcher: "Write", command: "ccl-audit-write" },
];

function buildHookGroups(entries: HookEntry[]): unknown[] {
  return entries.map((e) => ({
    matcher: e.matcher,
    hooks: [{ type: "command", command: e.command }],
  }));
}

export function buildSettingsObject(ctx: SettingsContext): unknown {
  return {
    permissions: {
      allow: ctx.allow,
      deny: ctx.deny,
    },
    hooks: {
      PreToolUse: buildHookGroups(ctx.preToolUseHooks),
      PostToolUse: buildHookGroups(ctx.postToolUseHooks),
    },
  };
}

export function renderSettingsJson(ctx: SettingsContext): string {
  return JSON.stringify(buildSettingsObject(ctx), null, 2) + "\n";
}

export function defaultSettingsContext(): SettingsContext {
  return {
    allow: [...DEFAULT_ALLOW],
    deny: [...DEFAULT_DENY],
    preToolUseHooks: [...DEFAULT_PRE_HOOKS],
    postToolUseHooks: [...DEFAULT_POST_HOOKS],
  };
}

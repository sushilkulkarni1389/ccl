import type { GitignoreContext } from "./types.js";

export const CCL_GITIGNORE_MARKER_START = "# >>> ccl managed <<<";
export const CCL_GITIGNORE_MARKER_END = "# <<< ccl managed >>>";

const BASE_LINES = [".claude/settings.local.json"];
const STATE_LINE = ".claude/ccl-state.json";

export function renderGitignoreAdditions(ctx: GitignoreContext): string {
  const lines = [...BASE_LINES];
  if (!ctx.syncStateToGit) {
    lines.push(STATE_LINE);
  }
  return (
    CCL_GITIGNORE_MARKER_START +
    "\n" +
    lines.join("\n") +
    "\n" +
    CCL_GITIGNORE_MARKER_END +
    "\n"
  );
}

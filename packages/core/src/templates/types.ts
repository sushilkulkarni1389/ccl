export interface DirectoryEntry {
  dir: string;
  description: string;
}

export interface ProjectCommands {
  dev: string;
  test: string;
  build: string;
  lint: string;
}

export interface ClaudeMdContext {
  projectName: string;
  whatIsThis: string;
  stack: string[];
  directories: DirectoryEntry[];
  commands: ProjectCommands;
  codingRules: string[];
  testingPhilosophy: string;
  commonPitfalls: string[];
  gotchas: string[];
  neverDo: string[];
}

export interface SkillContext {
  name: string;
  description: string;
  allowedTools: string[];
  steps: string[];
  verification: string[];
  references: string[];
}

export const CCL_MODEL_ALIASES = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
} as const;

export const CCL_MODEL_DATED_IDS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
} as const;

export type CclModelAlias = (typeof CCL_MODEL_ALIASES)[keyof typeof CCL_MODEL_ALIASES];

export interface AgentContext {
  name: string;
  description: string;
  model: CclModelAlias;
  tools: string[];
  purpose: string;
  outputFormat: string;
  constraints: string[];
  role: string;
}

export interface SettingsContext {
  allow: string[];
  deny: string[];
  preToolUseHooks: HookEntry[];
  postToolUseHooks: HookEntry[];
}

export interface HookEntry {
  matcher: string;
  command: string;
}

export interface PracticeEntry {
  id: string;
  title: string;
  description: string;
  source: string;
  added: string;
  status: "active" | "deprecated";
}

export interface PracticesContext {
  version: string;
  lastUpdated: string;
  lastChecked: string;
  nextCheckDue: string;
  practices: PracticeEntry[];
  archivedVersions: ArchivedVersion[];
  refresh?: "never";
}

export interface ArchivedVersion {
  version: string;
  archivedAt: string;
  practices: PracticeEntry[];
}

export interface StateStep {
  name: string;
  status: "pending" | "done" | "failed" | "skipped";
}

export interface StateContext {
  status: "complete" | "in_progress" | "failed";
  scaffoldVersion: string;
  startedAt: string;
  completedAt: string | null;
  projectName: string;
  projectType: string;
  steps: StateStep[];
  gitSync: boolean;
  lastCompletedStep?: string;
  remainingSteps?: string[];
  conversationStep?: string;
  guidedAnswers?: Record<string, string>;
  planOverrides?: Record<string, unknown>;
}

export interface GitignoreContext {
  syncStateToGit: boolean;
}

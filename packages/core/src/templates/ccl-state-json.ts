import type { StateContext, StateStep } from "./types.js";

export const SCAFFOLD_VERSION = "1.0";

export function renderStateJson(ctx: StateContext): string {
  const payload: Record<string, unknown> = {
    status: ctx.status,
    scaffold_version: ctx.scaffoldVersion,
    started_at: ctx.startedAt,
    completed_at: ctx.completedAt,
    project_name: ctx.projectName,
    project_type: ctx.projectType,
    steps: ctx.steps.map((s) => ({ name: s.name, status: s.status })),
    git_sync: ctx.gitSync,
    conversation_step: ctx.conversationStep ?? "greeting",
    guided_answers: ctx.guidedAnswers ?? {},
    plan_overrides: ctx.planOverrides ?? {},
  };
  if (ctx.status !== "complete") {
    if (ctx.lastCompletedStep !== undefined) {
      payload["last_completed_step"] = ctx.lastCompletedStep;
    }
    if (ctx.remainingSteps !== undefined) {
      payload["remaining_steps"] = ctx.remainingSteps;
    }
  }
  return JSON.stringify(payload, null, 2) + "\n";
}

export function initialStateContext(args: {
  projectName: string;
  projectType: string;
  steps: string[];
  gitSync: boolean;
  now?: Date;
}): StateContext {
  const startedAt = (args.now ?? new Date()).toISOString();
  const steps: StateStep[] = args.steps.map((name) => ({ name, status: "pending" }));
  return {
    status: "in_progress",
    scaffoldVersion: SCAFFOLD_VERSION,
    startedAt,
    completedAt: null,
    projectName: args.projectName,
    projectType: args.projectType,
    steps,
    gitSync: args.gitSync,
    remainingSteps: [...args.steps],
  };
}

export type RunLogMeta = {
  runId?: string;
  taskId?: string;
  iteration?: number;
  reasonCode?: string;
};

export type RunExecutionContext = {
  runId: string;
  repoRoot: string;
  workspaceRoot: "." | "app";
  workspaceAbs: string;
  controlSessionId?: string;
};

export const RUN_PHASE = {
  PREFLIGHT: "preflight",
  RECONCILE: "reconcile",
  REPAIR: "repair",
  VERIFY: "verify",
  FINALIZE: "finalize",
} as const;

export type RunPhaseName = (typeof RUN_PHASE)[keyof typeof RUN_PHASE];

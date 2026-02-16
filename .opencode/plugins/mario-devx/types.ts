export type WorkSessionState = {
  sessionId: string;
  baselineMessageId: string;
  createdAt: string;
  updatedAt: string;
};

export type RunPhase = "run";

export type RunStatus = "NONE" | "DOING" | "DONE" | "BLOCKED";

export type RunState = {
  iteration: number;
  status: RunStatus;
  phase: RunPhase;
  lastRunAt?: string;
  lastRunControlSessionId?: string;
  lastRunResult?: string;
  currentPI?: string;
  controlSessionId?: string;
  workSessionId?: string;
  baselineMessageId?: string;
  startedAt?: string;
  updatedAt: string;
};

export type UiVerifyState = {
  agentBrowserVersion?: string;
  browserInstallOkAt?: string;
  lastInstallAttemptAt?: string;
  lastInstallExitCode?: number;
  lastInstallReasonCode?: string;
  lastInstallCommand?: string;
  lastInstallNote?: string;
};

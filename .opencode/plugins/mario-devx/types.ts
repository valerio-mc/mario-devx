export type WorkSessionState = {
  sessionId: string;
  baselineMessageId: string;
  createdAt: string;
  updatedAt: string;
};

export type RunPhase = "run";

export type RunStatus = "NONE" | "DOING" | "DONE" | "BLOCKED";

export type FeatureAddInterviewState = {
  active: boolean;
  startedAt: string;
  step: 1 | 2 | 3;
  originalRequest: string;
  acceptance?: string[];
  constraints?: string[];
  uxNotes?: string;
  lastQuestion?: string;
};

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
  featureAddInterview?: FeatureAddInterviewState;
  updatedAt: string;
};

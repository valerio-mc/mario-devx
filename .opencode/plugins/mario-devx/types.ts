export type GateCommand = {
  name: string;
  command: string;
  source: "prd" | "agents" | "auto";
};

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
  currentPI?: string;
  controlSessionId?: string;
  workSessionId?: string;
  baselineMessageId?: string;
  startedAt?: string;
  updatedAt: string;
};

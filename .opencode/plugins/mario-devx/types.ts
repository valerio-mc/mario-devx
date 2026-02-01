export type GateCommand = {
  name: string;
  command: string;
  source: "prd" | "agents" | "auto";
};

export type IterationMode = "prd" | "plan" | "build";

export type PendingPlan = {
  id: string;
  title: string;
  block: string;
  createdAt: string;
  idea?: string;
};

export type IterationState = {
  iteration: number;
  lastMode: IterationMode | null;
  lastRunDir?: string;
  lastStatus?: "PASS" | "FAIL" | "NONE";
};

export type WorkSessionState = {
  sessionId: string;
  baselineMessageId: string;
  createdAt: string;
  updatedAt: string;
};

export type RunPhase = "prd" | "plan" | "build" | "verify" | "auto";

export type RunStatus = "NONE" | "DOING" | "DONE" | "BLOCKED";

export type RunState = {
  status: RunStatus;
  phase: RunPhase;
  flow?: "new";
  flowNext?: "plan";
  currentPI?: string;
  controlSessionId?: string;
  workSessionId?: string;
  baselineMessageId?: string;
  runDir?: string;
  lastGate?: "PASS" | "FAIL" | "NONE";
  lastUI?: "PASS" | "FAIL" | "NONE";
  lastVerifier?: "PASS" | "FAIL" | "NONE";
  startedAt?: string;
  updatedAt: string;
};

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

export type RunPhase = "prd" | "plan" | "run";

export type RunStatus = "NONE" | "DOING" | "DONE" | "BLOCKED";

export type RunState = {
  iteration: number;
  status: RunStatus;
  phase: RunPhase;
  flow?: "new";
  flowNext?: "plan";
  currentPI?: string;
  controlSessionId?: string;
  workSessionId?: string;
  baselineMessageId?: string;
  runDir?: string;
  latestVerdictPath?: string;
  lastGate?: "PASS" | "FAIL" | "NONE";
  lastUI?: "PASS" | "FAIL" | "NONE";
  lastVerifier?: "PASS" | "FAIL" | "NONE";
  startedAt?: string;
  updatedAt: string;
};

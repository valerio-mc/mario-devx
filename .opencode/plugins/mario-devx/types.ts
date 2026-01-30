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

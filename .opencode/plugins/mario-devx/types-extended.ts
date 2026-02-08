/**
 * Mario DevX Type Definitions
 * 
 * Centralized type definitions to replace 'any' usage
 * and enable better type safety throughout the codebase.
 */

// Plugin Context Types
export interface ShellContext {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export interface PluginClient {
  session: {
    prompt: (opts: {
      path: { id: string };
      body: {
        agent?: string;
        parts: Array<{ type: "text"; text: string }>;
        noReply?: boolean;
      };
    }) => Promise<unknown>;
    get: (opts: { path: { id: string } }) => Promise<unknown>;
    message: (opts: { path: { id: string; messageID: string } }) => Promise<unknown>;
    status: () => Promise<Record<string, { type?: string }>>;
  };
  tui?: {
    showToast: (opts: {
      body: {
        message: string;
        variant: "info" | "success" | "warning" | "error";
      };
    }) => Promise<void>;
  };
}

export interface PluginContext {
  $?: ShellContext;
  client: PluginClient;
}

// LLM Response Types
export interface InterviewEnvelope {
  done: boolean;
  updates?: Record<string, unknown>;
  next_question?: string;
}

export interface InterviewResponse {
  envelope: InterviewEnvelope | null;
  question: string | null;
  error?: string;
}

export interface FeatureBreakdown {
  ready: boolean;
  tasks?: string[];
  acceptanceCriteria?: string[];
  constraints?: string[];
  uxNotes?: string;
  next_question?: string | null;
}

export interface VerifierResult {
  status: "PASS" | "FAIL";
  reason: string[];
  nextActions: string[];
}

// Error Types
export interface MarioError {
  code: string;
  message: string;
  details?: unknown;
}

export type ErrorCode =
  | "INTERVIEW_PARSE_ERROR"
  | "FEATURE_PARSE_ERROR"
  | "REPLAN_PARSE_ERROR"
  | "VERIFIER_PARSE_ERROR"
  | "HEARTBEAT_FAILED"
  | "TASK_EXECUTION_FAILED"
  | "GATE_EXECUTION_FAILED"
  | "UI_VERIFY_FAILED"
  | "SCAFFOLD_FAILED"
  | "QUALITY_SETUP_FAILED";

// Gate Execution Types
export interface GateCommand {
  name: string;
  command: string;
}

export interface GateResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

// State Types
export interface RunLockState {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  controlSessionId?: string;
}

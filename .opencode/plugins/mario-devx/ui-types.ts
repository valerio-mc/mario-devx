export type UiLog = (entry: {
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  extra?: Record<string, unknown>;
  reasonCode?: string;
}) => Promise<void>;

export type LoggedShellResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type UiVerificationEvidence = {
  snapshot?: string;
  snapshotInteractive?: string;
  screenshot?: string;
  console?: string;
  errors?: string;
};

export type UiFailureSubtype = "NEXT_DEV_LOCK_HELD" | "EADDRINUSE" | "OPEN_CONNECTION_REFUSED" | "UNKNOWN";

export type UiVerificationFailure = {
  subtype: UiFailureSubtype;
  pid?: number;
  lockPath?: string;
  transcript: string[];
  signature?: string;
  repeatCount?: number;
};

export type UiVerificationResult = {
  ok: boolean;
  note?: string;
  evidence?: UiVerificationEvidence;
  failure?: UiVerificationFailure;
};

export type AgentBrowserPrereqStatus = {
  cliOk: boolean;
  skillOk: boolean;
  browserOk: boolean;
  attempted: string[];
  installing: boolean;
  installPid?: number;
  installLogPath?: string;
  note?: string;
};

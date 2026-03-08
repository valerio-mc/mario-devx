import path from "path";
import { readTextIfExists } from "./fs";
import { parseAgentsEnv } from "./agents-env";
import { ensureAgentBrowserPrereqs, hasAgentBrowserCli, hasAgentBrowserSkill, isLikelyWebApp } from "./ui-prereq";

export type UiRunSetup = {
  uiVerifyEnabled: boolean;
  uiVerifyCmd: string;
  uiVerifyUrl: string;
  uiVerifyRequired: boolean;
  agentBrowserRepo: string;
  isWebApp: boolean;
  cliOk: boolean;
  skillOk: boolean;
  browserOk: boolean;
  autoInstallAttempted: string[];
  prereqInstalling: boolean;
  prereqInstallPid?: number;
  prereqLogPath?: string;
  prereqNote?: string;
  shouldRunUiVerify: boolean;
};

export const shouldBlockRunForUiPrereqs = (opts: {
  uiVerifyEnabled: boolean;
  isWebApp: boolean;
  cliOk: boolean;
  skillOk: boolean;
  browserOk: boolean;
}): boolean => {
  const { uiVerifyEnabled, isWebApp, cliOk, skillOk, browserOk } = opts;
  return uiVerifyEnabled && isWebApp && (!cliOk || !skillOk || !browserOk);
};

type ResolveUiRunSetupOptions = {
  ctx: any;
  repoRoot: string;
  workspaceRoot: "." | "app";
  onWarnings?: (count: number) => Promise<void>;
  onPrereqLog?: (entry: {
    level: "info" | "warn" | "error";
    event: string;
    message: string;
    extra?: Record<string, unknown>;
    reasonCode?: string;
  }) => Promise<void>;
};

export const resolveUiRunSetup = async (opts: ResolveUiRunSetupOptions): Promise<UiRunSetup> => {
  const { ctx, repoRoot, workspaceRoot, onWarnings, onPrereqLog } = opts;
  const isWebApp = await isLikelyWebApp(repoRoot);
  const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
  const agentsRaw = await readTextIfExists(agentsPath);
  const agentsParsed = agentsRaw ? parseAgentsEnv(agentsRaw) : { env: {}, warnings: [] };
  const agentsEnv = agentsParsed.env;
  if (agentsParsed.warnings.length > 0) {
    await onWarnings?.(agentsParsed.warnings.length);
  }

  const uiVerifyRaw = (agentsEnv.UI_VERIFY ?? "").trim();
  const uiVerifyEnabled = uiVerifyRaw.length > 0 ? uiVerifyRaw === "1" : isWebApp;
  const uiVerifyCmd = agentsEnv.UI_VERIFY_CMD || (workspaceRoot === "app" ? "npm --prefix app run dev" : "npm run dev");
  const uiVerifyUrl = agentsEnv.UI_VERIFY_URL || "http://localhost:3000";
  const uiVerifyRequiredRaw = (agentsEnv.UI_VERIFY_REQUIRED ?? "").trim();
  const uiVerifyRequired = uiVerifyEnabled
    ? (uiVerifyRequiredRaw.length > 0 ? uiVerifyRequiredRaw === "1" : isWebApp)
    : false;
  const agentBrowserRepo = agentsEnv.AGENT_BROWSER_REPO || "https://github.com/vercel-labs/agent-browser";

  let cliOk = await hasAgentBrowserCli(ctx);
  let skillOk = await hasAgentBrowserSkill(repoRoot);
  let browserOk = true;
  let autoInstallAttempted: string[] = [];
  let prereqInstalling = false;
  let prereqInstallPid: number | undefined;
  let prereqLogPath: string | undefined;
  let prereqNote: string | undefined;
  if (uiVerifyEnabled && isWebApp) {
    const ensured = await ensureAgentBrowserPrereqs(ctx, repoRoot, onPrereqLog);
    cliOk = ensured.cliOk;
    skillOk = ensured.skillOk;
    browserOk = ensured.browserOk;
    autoInstallAttempted = ensured.attempted;
    prereqInstalling = ensured.installing;
    prereqInstallPid = ensured.installPid;
    prereqLogPath = ensured.installLogPath;
    prereqNote = ensured.note;
  }

  return {
    uiVerifyEnabled,
    uiVerifyCmd,
    uiVerifyUrl,
    uiVerifyRequired,
    agentBrowserRepo,
    isWebApp,
    cliOk,
    skillOk,
    browserOk,
    autoInstallAttempted,
    prereqInstalling,
    ...(typeof prereqInstallPid === "number" ? { prereqInstallPid } : {}),
    ...(prereqLogPath ? { prereqLogPath } : {}),
    ...(prereqNote ? { prereqNote } : {}),
    shouldRunUiVerify: uiVerifyEnabled && isWebApp && cliOk && skillOk && browserOk,
  };
};

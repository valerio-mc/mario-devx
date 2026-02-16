import path from "path";
import { readTextIfExists } from "./fs";
import { ensureAgentBrowserPrereqs, hasAgentBrowserCli, hasAgentBrowserSkill, isLikelyWebApp, parseAgentsEnv } from "./ui-verify";

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
  shouldRunUiVerify: boolean;
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
  const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
  const agentsRaw = await readTextIfExists(agentsPath);
  const agentsParsed = agentsRaw ? parseAgentsEnv(agentsRaw) : { env: {}, warnings: [] };
  const agentsEnv = agentsParsed.env;
  if (agentsParsed.warnings.length > 0) {
    await onWarnings?.(agentsParsed.warnings.length);
  }

  const uiVerifyEnabled = agentsEnv.UI_VERIFY === "1";
  const uiVerifyCmd = agentsEnv.UI_VERIFY_CMD || (workspaceRoot === "app" ? "npm --prefix app run dev" : "npm run dev");
  const uiVerifyUrl = agentsEnv.UI_VERIFY_URL || "http://localhost:3000";
  const uiVerifyRequired = agentsEnv.UI_VERIFY_REQUIRED === "1";
  const agentBrowserRepo = agentsEnv.AGENT_BROWSER_REPO || "https://github.com/vercel-labs/agent-browser";

  const isWebApp = await isLikelyWebApp(repoRoot);
  let cliOk = await hasAgentBrowserCli(ctx);
  let skillOk = await hasAgentBrowserSkill(repoRoot);
  let browserOk = true;
  let autoInstallAttempted: string[] = [];
  if (uiVerifyEnabled && isWebApp) {
    const ensured = await ensureAgentBrowserPrereqs(ctx, repoRoot, onPrereqLog);
    cliOk = ensured.cliOk;
    skillOk = ensured.skillOk;
    browserOk = ensured.browserOk;
    autoInstallAttempted = ensured.attempted;
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
    shouldRunUiVerify: uiVerifyEnabled && isWebApp && cliOk && skillOk && browserOk,
  };
};

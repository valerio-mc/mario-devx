import path from "path";
import type { PrdJson } from "./prd";
import { readTextIfExists, writeText } from "./fs";
import { hasAgentsKey, parseAgentsEnv, upsertAgentsKey } from "./ui-verify";
import type { RunReasonCode } from "./run-contracts";
import { RUN_REASON } from "./run-contracts";

export type SessionAgentConfig = {
  workAgent: string;
  verifyAgent: string;
  streamWorkEvents: boolean;
  parseWarnings: number;
};

export const parseMaxItems = (rawMax: string | undefined): number => {
  const raw = (rawMax ?? "").trim();
  const parsed = raw.length === 0 ? 1 : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 1;
};

export const validateRunPrerequisites = (prd: PrdJson): {
  ok: boolean;
  message?: string;
  reasonCode?: RunReasonCode;
  extra?: Record<string, unknown>;
} => {
  if (prd.wizard.status !== "completed") {
    return {
      ok: false,
      message: "PRD wizard is not complete. Run /mario-devx:new to finish it.",
      reasonCode: RUN_REASON.PRD_INCOMPLETE,
      extra: {
        wizardStatus: prd.wizard.status,
        wizardStep: prd.wizard.step,
        wizardTotalSteps: prd.wizard.totalSteps,
      },
    };
  }
  if (!Array.isArray(prd.tasks) || prd.tasks.length === 0) {
    return {
      ok: false,
      message: "No tasks found in .mario/prd.json. Run /mario-devx:new to seed tasks.",
      reasonCode: RUN_REASON.NO_TASKS,
      extra: {
        tasksCount: Array.isArray(prd.tasks) ? prd.tasks.length : 0,
      },
    };
  }
  if (!Array.isArray(prd.qualityGates) || prd.qualityGates.length === 0) {
    return {
      ok: false,
      message: "No quality gates configured in .mario/prd.json (qualityGates is empty). Add at least one command, then rerun /mario-devx:run 1.",
      reasonCode: RUN_REASON.NO_QUALITY_GATES,
      extra: {
        qualityGatesCount: Array.isArray(prd.qualityGates) ? prd.qualityGates.length : 0,
      },
    };
  }
  return { ok: true };
};

export const syncFrontendAgentsConfig = async (opts: {
  repoRoot: string;
  workspaceRoot: string;
  prd: PrdJson;
}): Promise<{ parseWarnings: number }> => {
  const { repoRoot, workspaceRoot, prd } = opts;
  if (prd.frontend !== true) {
    return { parseWarnings: 0 };
  }
  const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
  const raw = (await readTextIfExists(agentsPath)) ?? "";
  const parsed = parseAgentsEnv(raw);
  const env = parsed.env;
  const uiRequired = prd.uiVerificationRequired === true;
  if (env.UI_VERIFY !== "1") {
    let next = raw;
    next = upsertAgentsKey(next, "UI_VERIFY", "1");
    next = upsertAgentsKey(next, "UI_VERIFY_REQUIRED", uiRequired ? "1" : "0");
    const defaultUiCmd = workspaceRoot === "app" ? "npm --prefix app run dev" : "npm run dev";
    if (!hasAgentsKey(next, "UI_VERIFY_CMD") || !env.UI_VERIFY_CMD || (workspaceRoot === "app" && env.UI_VERIFY_CMD === "npm run dev")) {
      next = upsertAgentsKey(next, "UI_VERIFY_CMD", defaultUiCmd);
    }
    if (!env.UI_VERIFY_URL) next = upsertAgentsKey(next, "UI_VERIFY_URL", "http://localhost:3000");
    if (!env.AGENT_BROWSER_REPO) next = upsertAgentsKey(next, "AGENT_BROWSER_REPO", "https://github.com/vercel-labs/agent-browser");
    await writeText(agentsPath, next);
  } else if ((env.UI_VERIFY_REQUIRED === "1") !== uiRequired) {
    let next = upsertAgentsKey(raw, "UI_VERIFY_REQUIRED", uiRequired ? "1" : "0");
    if ((workspaceRoot === "app" && env.UI_VERIFY_CMD === "npm run dev") || !hasAgentsKey(raw, "UI_VERIFY_CMD")) {
      next = upsertAgentsKey(next, "UI_VERIFY_CMD", workspaceRoot === "app" ? "npm --prefix app run dev" : "npm run dev");
    }
    await writeText(agentsPath, next);
  }
  return { parseWarnings: parsed.warnings.length };
};

export const resolveSessionAgents = async (opts: {
  repoRoot: string;
  defaultWorkAgent?: string;
  defaultVerifyAgent?: string;
}): Promise<SessionAgentConfig> => {
  const {
    repoRoot,
    defaultWorkAgent = "build",
    defaultVerifyAgent = "build",
  } = opts;
  const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
  const raw = (await readTextIfExists(agentsPath)) ?? "";
  const parsed = parseAgentsEnv(raw);
  const env = parsed.env;
  const normalizeAgent = (value: string | undefined, fallback: string): string => {
    const trimmed = (value ?? "").trim();
    return trimmed.length > 0 ? trimmed : fallback;
  };
  return {
    workAgent: normalizeAgent(env.WORK_AGENT, defaultWorkAgent),
    verifyAgent: normalizeAgent(env.VERIFY_AGENT, defaultVerifyAgent),
    streamWorkEvents: env.STREAM_WORK === "1",
    parseWarnings: parsed.warnings.length,
  };
};

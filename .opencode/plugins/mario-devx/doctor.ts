import path from "path";
import { unlink } from "fs/promises";
import { readTextIfExists } from "./fs";
import { assetsDir } from "./paths";
import { discoverAgentBrowserCapabilities } from "./agent-browser-capabilities";
import { redactForLog } from "./logging";
import { tryLoadPrd, readPrdJsonIfExists } from "./prd";
import { readRunState, readUiVerifyState } from "./state";
import { runLockPath } from "./run-lock";
import { parseAgentsEnv } from "./agents-env";
import { hasAgentBrowserCli, hasAgentBrowserRuntime, hasAgentBrowserSkill, isLikelyWebApp } from "./ui-verify";

const parseIsoMs = (value: unknown): number | null => {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

export const runDoctor = async (ctx: any, repoRoot: string): Promise<string> => {
  const issues: string[] = [];
  const fixes: string[] = [];

  const prdLoad = await tryLoadPrd(() => readPrdJsonIfExists(repoRoot));
  let prd = null;
  let prdReadBlocked = false;
  if (!prdLoad.ok) {
    prdReadBlocked = true;
    issues.push(prdLoad.message);
    fixes.push("After regenerating PRD, rerun /mario-devx:doctor.");
  } else {
    prd = prdLoad.value;
  }
  if (!prd && !prdReadBlocked) {
    issues.push("Missing or invalid .mario/prd.json");
    fixes.push("Run /mario-devx:new <idea>");
  } else {
    if (prd.wizard.status !== "completed") {
      issues.push("PRD wizard not completed (prd.json.wizard.status != completed).");
      fixes.push("Run /mario-devx:new and answer the wizard questions.");
    }
    if (!Array.isArray(prd.qualityGates) || prd.qualityGates.length === 0) {
      issues.push("No quality gates configured in .mario/prd.json (qualityGates is empty).");
      fixes.push("Edit .mario/prd.json: add commands under qualityGates (example: npm test).");
    }
    if (!Array.isArray(prd.tasks) || prd.tasks.length === 0) {
      issues.push("No tasks in .mario/prd.json (tasks is empty).");
      fixes.push("Run /mario-devx:new to seed tasks or add tasks manually to .mario/prd.json.");
    }
    const inProgress = (prd.tasks ?? []).filter((t) => t.status === "in_progress").map((t) => t.id);
    if (inProgress.length > 1) {
      issues.push(`Invalid task state: multiple tasks are in_progress (${inProgress.join(", ")}).`);
      fixes.push("Edit .mario/prd.json so at most one task is in_progress (set the others to open/blocked/cancelled). Then rerun /mario-devx:run 1.");
    }
    const blocked = (prd.tasks ?? []).filter((t) => t.status === "blocked").map((t) => t.id);
    if (blocked.length > 0) {
      issues.push(`Blocked tasks: ${blocked.join(", ")}`);
      fixes.push("For each blocked task, read prd.json.tasks[].lastAttempt.judge.nextActions, fix them, then rerun /mario-devx:run 1.");
    }
  }

  const runState = await readRunState(repoRoot);
  const uiVerifyState = await readUiVerifyState(repoRoot);
  const lockPath = runLockPath(repoRoot);
  const lockRaw = await readTextIfExists(lockPath);
  if (!lockRaw) {
    if (runState.status === "DOING") {
      issues.push("Run state is DOING but run.lock is missing (stale interrupted run).");
      fixes.push("Rerun /mario-devx:run 1.");
    }
  } else {
    try {
      const lock = JSON.parse(lockRaw) as { runId?: unknown; at?: unknown; heartbeatAt?: unknown };
      const lockRefMs = parseIsoMs(lock.heartbeatAt) ?? parseIsoMs(lock.at);
      const stateUpdatedMs = parseIsoMs(runState.updatedAt);
      const staleByState = (
        runState.status !== "DOING"
        && lockRefMs !== null
        && stateUpdatedMs !== null
        && stateUpdatedMs >= lockRefMs
      );
      const staleByRunIdMismatch = (
        runState.status === "DOING"
        && typeof runState.runId === "string"
        && runState.runId.length > 0
        && typeof lock.runId === "string"
        && lock.runId.length > 0
        && runState.runId !== lock.runId
      );
      if (staleByState || staleByRunIdMismatch) {
        await unlink(lockPath).catch(() => undefined);
        issues.push(
          staleByRunIdMismatch
            ? "Stale run.lock detected (runId mismatch) and cleared automatically."
            : "Stale run.lock detected (run state is not DOING) and cleared automatically.",
        );
        fixes.push("Retry /mario-devx:run 1.");
      } else if (runState.status === "DOING" && runState.runId && lock.runId !== runState.runId) {
        issues.push("Run state is DOING but run.lock ownership does not match run state runId.");
        fixes.push("Retry /mario-devx:run 1.");
      }
    } catch {
      if (runState.status !== "DOING") {
        await unlink(lockPath).catch(() => undefined);
        issues.push("Malformed stale run.lock detected and cleared automatically.");
        fixes.push("Retry /mario-devx:run 1.");
      } else {
        issues.push("Run state is DOING but run.lock is malformed (stale interrupted run).");
        fixes.push("Rerun /mario-devx:run 1.");
      }
    }
  }

  const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
  const agentsRaw = await readTextIfExists(agentsPath);
  const agentsParsed = agentsRaw ? parseAgentsEnv(agentsRaw) : { env: {}, warnings: [] };
  const agentsEnv = agentsParsed.env;
  if (agentsParsed.warnings.length > 0) {
    issues.push(`AGENTS.md parse warnings (${agentsParsed.warnings.length}).`);
    fixes.push("Fix malformed lines in .mario/AGENTS.md (must be KEY=VALUE; use # for comments).");
  }
  const uiVerifyEnabled = agentsEnv.UI_VERIFY === "1";
  if (uiVerifyEnabled) {
    const isWebApp = await isLikelyWebApp(repoRoot);
    const scaffoldBlocked = !!prd?.tasks?.some(
      (t) => (t.labels ?? []).includes("scaffold") && (t.status === "open" || t.status === "in_progress" || t.status === "blocked"),
    );
    if (!isWebApp) {
      if (!scaffoldBlocked) {
        issues.push("UI_VERIFY=1 but this repo does not look like a Node web app yet.");
        fixes.push("Either scaffold the web app first, or set UI_VERIFY=0 in .mario/AGENTS.md.");
      }
    } else {
      const cliOk = await hasAgentBrowserCli(ctx);
      const skillOk = await hasAgentBrowserSkill(repoRoot);
      if (!cliOk || !skillOk) {
        issues.push(`UI_VERIFY=1 but agent-browser prerequisites missing (${[!cliOk ? "cli" : null, !skillOk ? "skill" : null].filter(Boolean).join(", ")}).`);
        fixes.push("Install: npx skills add vercel-labs/agent-browser");
        fixes.push("Install: npm install -g agent-browser && agent-browser install");
        fixes.push("Optional: set UI_VERIFY=0 in .mario/AGENTS.md to disable best-effort UI checks.");
      } else {
        const caps = await discoverAgentBrowserCapabilities(ctx);
        if (!caps.available) {
          issues.push("agent-browser CLI appears unavailable during capability probe.");
          fixes.push("Reinstall: npm install -g agent-browser");
        } else if (caps.openUsage && !caps.openUsage.includes("open <url>")) {
          issues.push(`agent-browser open signature differs from expected contract (${caps.openUsage}).`);
          fixes.push("Update agent-browser to latest release and rerun /mario-devx:doctor.");
        }

        const uiVerifierPath = path.join(assetsDir(), "prompts", "UI_VERIFIER.md");
        const uiVerifierPlaybook = await readTextIfExists(uiVerifierPath);
        if (!uiVerifierPlaybook || uiVerifierPlaybook.trim().length === 0) {
          issues.push("UI verifier playbook is missing (UI_VERIFIER.md). Autonomous UI judging may drift.");
          fixes.push("Restore .opencode/plugins/mario-devx/assets/prompts/UI_VERIFIER.md and reinstall plugin.");
        }

        const runtime = await hasAgentBrowserRuntime(ctx);
        if (!runtime.ok) {
          issues.push("UI_VERIFY=1 and agent-browser CLI exists, but browser runtime is missing or broken.");
          fixes.push("Run: agent-browser install");
          if (uiVerifyState.lastInstallReasonCode === "INTERACTIVE_PROMPT_BLOCKED") {
            issues.push("Previous browser install attempt hit an interactive prompt and was blocked.");
            fixes.push("Use non-interactive install: CI=1 npm_config_yes=true npx --yes playwright install chromium");
          }
          if (uiVerifyState.lastInstallCommand) {
            issues.push(`Last install command: ${uiVerifyState.lastInstallCommand}`);
          }
          if (uiVerifyState.lastInstallNote) {
            issues.push(`Last install note: ${redactForLog(uiVerifyState.lastInstallNote).slice(0, 240)}`);
          }
          if (runtime.note) {
            issues.push(`Runtime detail: ${redactForLog(runtime.note).slice(0, 240)}`);
          }
        }
      }
    }
  }

  if (issues.length === 0) {
    return "Doctor: OK (no obvious issues found).";
  }

  return [
    "Doctor: issues found",
    ...issues.map((i) => `- ${i}`),
    "",
    "Suggested fixes",
    ...Array.from(new Set(fixes)).map((f) => `- ${f}`),
  ].join("\n");
};

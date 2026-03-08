import path from "path";
import { readTextIfExists } from "./fs";
import type { AgentBrowserPrereqStatus, UiLog } from "./ui-types";
import { hasAgentBrowserCli, hasAgentBrowserRuntime, hasAgentBrowserSkill } from "./ui-prereq-checks";
import { buildAgentBrowserInstallPlan } from "./ui-prereq-plan";

export const isLikelyWebApp = async (repoRoot: string): Promise<boolean> => {
  const pkgRaw = await readTextIfExists(path.join(repoRoot, "package.json"));
  const appPkgRaw = await readTextIfExists(path.join(repoRoot, "app", "package.json"));
  const candidates = [pkgRaw, appPkgRaw].filter((v): v is string => typeof v === "string");
  if (candidates.length === 0) {
    return false;
  }
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(candidate) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps.next || deps.vite || deps["react-scripts"]) {
        return true;
      }
    } catch {
      // Keep checking other package manifests.
    }
  }
  return false;
};

export const ensureAgentBrowserPrereqs = async (
  ctx: any,
  repoRoot: string,
  log?: UiLog,
): Promise<AgentBrowserPrereqStatus> => {
  const skillOk = await hasAgentBrowserSkill(repoRoot);
  if (!ctx.$) {
    return {
      cliOk: false,
      skillOk,
      browserOk: false,
      attempted: buildAgentBrowserInstallPlan({
        needsCli: true,
        needsBrowserRuntime: true,
        needsSkill: !skillOk,
      }),
      note: "No shell available. Install agent-browser prerequisites manually and rerun.",
    };
  }

  const cliOk = await hasAgentBrowserCli(ctx);
  const runtime = cliOk
    ? await hasAgentBrowserRuntime(ctx)
    : { ok: false as const, note: "agent-browser CLI is not installed." };
  const browserOk = runtime.ok;
  const attempted = buildAgentBrowserInstallPlan({
    needsCli: !cliOk,
    needsBrowserRuntime: !browserOk,
    needsSkill: !skillOk,
  });

  if (cliOk && skillOk && browserOk) {
    return {
      cliOk,
      skillOk,
      browserOk,
      attempted: [],
    };
  }

  await log?.({
    level: "warn",
    event: "ui.prereq.missing",
    message: "Agent-browser prerequisites missing",
    reasonCode: "UI_PREREQ_MISSING",
    extra: {
      cliOk,
      skillOk,
      browserOk,
      commands: attempted,
      runtimeNote: runtime.note ?? null,
    },
  });

  const noteParts = [
    runtime.note ?? "Agent-browser prerequisites are missing.",
    attempted.length > 0 ? `Install manually: ${attempted.join(" ; ")}` : "",
  ].filter((part) => part && part.trim().length > 0);

  return {
    cliOk,
    skillOk,
    browserOk,
    attempted,
    note: noteParts.join(" "),
  };
};

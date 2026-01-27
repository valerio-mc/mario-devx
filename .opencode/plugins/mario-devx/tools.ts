import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import path from "path";
import { ensureDir, readTextIfExists, writeText } from "./fs";
import { buildPrompt } from "./prompt";
import { resolveGateCommands, persistGateCommands } from "./gates";
import { ensureMario, bumpIteration, readIterationState, writeIterationState, readPendingPlan, writePendingPlan, clearPendingPlan, getPendingPlanPath } from "./state";
import { marioRoot, marioRunsDir } from "./paths";
import { PendingPlan } from "./types";

type ToolContext = {
  sessionID?: string;
  agent?: string;
};

type PluginContext = Parameters<Plugin>[0];

const nowIso = (): string => new Date().toISOString();

const getRepoRoot = (ctx: PluginContext): string => ctx.worktree ?? ctx.directory ?? process.cwd();

const appendLine = async (filePath: string, line: string): Promise<void> => {
  const existing = await readTextIfExists(filePath);
  const next = existing ? `${existing.trimEnd()}\n${line}\n` : `${line}\n`;
  await writeText(filePath, next);
};

const showToast = async (
  ctx: PluginContext,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
): Promise<void> => {
  if (!ctx.client?.tui?.showToast) {
    return;
  }
  await ctx.client.tui.showToast({
    body: {
      message,
      variant,
    },
  });
};

const getNextPlanItem = async (planPath: string): Promise<{ id: string; title: string; block: string } | null> => {
  const content = await readTextIfExists(planPath);
  if (!content) {
    return null;
  }
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.startsWith("### PI-") && line.includes("- TODO -"));
  if (startIndex === -1) {
    return null;
  }
  const header = lines[startIndex];
  const match = header.match(/^###\s+(PI-\d+)\s+-\s+TODO\s+-\s+(.*)$/);
  if (!match) {
    return null;
  }
  const [, id, title] = match;
  const blockLines: string[] = [];
  for (let i = startIndex; i < lines.length; i += 1) {
    if (i !== startIndex && lines[i].startsWith("### PI-")) {
      break;
    }
    blockLines.push(lines[i]);
  }
  return { id, title: title.trim(), block: blockLines.join("\n") };
};

const writeRunArtifacts = async (runDir: string, prompt: string): Promise<void> => {
  await ensureDir(runDir);
  await writeText(path.join(runDir, "prompt.md"), prompt);
};

const runGateCommands = async (
  commands: { name: string; command: string }[],
  $: PluginContext["$"] | undefined,
  runDir: string,
): Promise<{ ok: boolean; summary: string }> => {
  if (commands.length === 0) {
    return { ok: false, summary: "No quality gates detected." };
  }
  if (!$) {
    return { ok: false, summary: "Bun shell not available to run gates." };
  }

  const logLines: string[] = [];
  let ok = true;

  for (const command of commands) {
    logLines.push(`$ ${command.command}`);
    try {
      const result = await $`${command.command}`;
      logLines.push(result.stdout.toString());
      logLines.push(result.stderr.toString());
    } catch (error) {
      ok = false;
      logLines.push(String(error));
      break;
    }
  }

  await writeText(path.join(runDir, "gates.log"), logLines.join("\n"));
  return {
    ok,
    summary: ok ? "All quality gates passed." : "Quality gate failed. See gates.log.",
  };
};

const formatPromptResult = (title: string, prompt: string): string => {
  return [
    title,
    "",
    "---",
    "",
    prompt,
  ].join("\n");
};

const draftPendingPlan = async (
  repoRoot: string,
  idea: string | undefined,
): Promise<{ pending: PendingPlan; content: string } | null> => {
  const planPath = path.join(repoRoot, ".mario", "IMPLEMENTATION_PLAN.md");
  const planItem = await getNextPlanItem(planPath);
  if (!planItem) {
    return null;
  }
  const content = [
    `# Pending Iteration Plan (${planItem.id})`,
    "",
    `Title: ${planItem.title}`,
    idea ? `Idea: ${idea}` : null,
    "",
    "Plan item:",
    planItem.block,
    "",
    "Proposed steps:",
    "- ",
    "- ",
  ]
    .filter((line) => line !== null)
    .join("\n");

  const pending: PendingPlan = {
    id: planItem.id,
    title: planItem.title,
    block: planItem.block,
    createdAt: nowIso(),
    idea,
  };
  return { pending, content };
};

export const createTools = (ctx: PluginContext) => {
  const repoRoot = getRepoRoot(ctx);

  return {
    mario_devx_init: tool({
      description: "Initialize mario-devx state files",
      args: {
        force: tool.schema.boolean().optional().describe("Overwrite existing files"),
      },
      async execute(args) {
        await ensureMario(repoRoot, Boolean(args.force));
        return "mario-devx initialized in .mario/";
      },
    }),

    mario_devx_prd: tool({
      description: "Start PRD interview",
      args: {
        idea: tool.schema.string().optional().describe("Initial idea"),
      },
      async execute(args) {
        await ensureMario(repoRoot, false);
        const prompt = await buildPrompt(repoRoot, "prd", args.idea ? `Initial idea: ${args.idea}` : undefined);
        return formatPromptResult("PRD mode: answer the questions (3-5 per round)", prompt);
      },
    }),

    mario_devx_plan: tool({
      description: "Generate/update implementation plan",
      args: {},
      async execute() {
        await ensureMario(repoRoot, false);
        const prompt = await buildPrompt(repoRoot, "plan");
        return formatPromptResult("Planning mode: write/update .mario/IMPLEMENTATION_PLAN.md", prompt);
      },
    }),

    mario_devx_build: tool({
      description: "Draft the next iteration plan (HITL checkpoint)",
      args: {
        idea: tool.schema.string().optional().describe("Additional idea or hint"),
      },
      async execute(args) {
        await ensureMario(repoRoot, false);
        const draft = await draftPendingPlan(repoRoot, args.idea);
        if (!draft) {
          return "No TODO plan items found in .mario/IMPLEMENTATION_PLAN.md.";
        }
        await writePendingPlan(repoRoot, draft.pending, draft.content);
        await showToast(ctx, `Pending plan drafted for ${draft.pending.id}.`, "info");
        return `Drafted pending plan at ${getPendingPlanPath(repoRoot)}. Review it, then run /mario-devx:approve.`;
      },
    }),

    mario_devx_approve: tool({
      description: "Approve and execute the pending iteration",
      args: {},
      async execute() {
        const { pending, content } = await readPendingPlan(repoRoot);
        if (!pending || !content) {
          return "No pending plan found. Run /mario-devx:build first.";
        }
        const state = await bumpIteration(repoRoot, "build");
        const runDir = path.join(
          marioRunsDir(repoRoot),
          `${new Date().toISOString().replace(/[:.]/g, "")}-build-iter${state.iteration}`,
        );
        await ensureDir(runDir);
        const prompt = await buildPrompt(repoRoot, "build", content);
        await writeRunArtifacts(runDir, prompt);

        await clearPendingPlan(repoRoot);
        await writeIterationState(repoRoot, {
          ...state,
          lastRunDir: runDir,
          lastStatus: "NONE",
        });

        await showToast(ctx, `Approved ${pending.id}. Implement, then run /mario-devx:verify.`, "info");

        return formatPromptResult(
          `Build mode: implement ${pending.id} (then run /mario-devx:verify)`,
          prompt,
        );
      },
    }),

    mario_devx_cancel: tool({
      description: "Cancel pending iteration plan",
      args: {},
      async execute() {
        await clearPendingPlan(repoRoot);
        return "Pending plan cleared.";
      },
    }),

    mario_devx_verify: tool({
      description: "Run deterministic gates + LLM judge without executing",
      args: {},
      async execute() {
        await ensureMario(repoRoot, false);
        const current = await readIterationState(repoRoot);
        const state = current.iteration === 0 ? await bumpIteration(repoRoot, "build") : current;

        const runDir =
          state.lastRunDir && state.lastRunDir.length > 0
            ? state.lastRunDir
            : path.join(
                marioRunsDir(repoRoot),
                `${new Date().toISOString().replace(/[:.]/g, "")}-verify-iter${state.iteration}`,
              );

        await ensureDir(runDir);
        const prdPath = path.join(repoRoot, ".mario", "PRD.md");
        const agentsPath = path.join(repoRoot, ".mario", "AGENTS.md");
        const gateCommands = await resolveGateCommands(repoRoot, prdPath, agentsPath);
        await persistGateCommands(agentsPath, gateCommands);
        const gateResult = await runGateCommands(gateCommands, ctx.$, runDir);

        await writeIterationState(repoRoot, {
          ...state,
          lastRunDir: runDir,
          lastStatus: "NONE",
        });
        await appendLine(path.join(repoRoot, ".mario", "progress.md"), `- ${nowIso()} verify iter=${state.iteration} gates=${gateResult.ok ? "PASS" : "FAIL"}`);

        await showToast(
          ctx,
          `Gates: ${gateResult.ok ? "PASS" : "FAIL"}. Now write verifier feedback.`,
          gateResult.ok ? "success" : "warning",
        );

        const verifierPrompt = await buildPrompt(
          repoRoot,
          "verify",
          [
            `Run artifacts: ${runDir}`,
            `Deterministic gates: ${gateResult.ok ? "PASS" : "FAIL"}`,
            `Gates log: ${path.join(runDir, "gates.log")}`,
          ].join("\n"),
        );

        const preface = [
          `Deterministic gates: ${gateResult.ok ? "PASS" : "FAIL"}`,
          `Evidence: ${path.join(runDir, "gates.log")}`,
          "",
          "Now act as the verifier:",
          "- Produce the exact Status/EXIT_SIGNAL format.",
          "- Write it to .mario/state/feedback.md.",
          "- If gates failed, Status must be FAIL and EXIT_SIGNAL must be false.",
        ].join("\n");

        return formatPromptResult(preface, verifierPrompt);
      },
    }),

    mario_devx_status: tool({
      description: "Show mario-devx status",
      args: {},
      async execute() {
        const state = await readIterationState(repoRoot);
        const pending = await readPendingPlan(repoRoot);
        return [
          `Iteration: ${state.iteration}`,
          `Last mode: ${state.lastMode ?? "none"}`,
          `Last status: ${state.lastStatus ?? "none"}`,
          pending.pending ? `Pending plan: ${pending.pending.id} (${getPendingPlanPath(repoRoot)})` : "Pending plan: none",
        ].join("\n");
      },
    }),

    mario_devx_help: tool({
      description: "Show mario-devx help",
      args: {},
      async execute() {
        return [
          "mario-devx commands:",
          "- /mario-devx:init",
          "- /mario-devx:prd [idea]",
          "- /mario-devx:plan",
          "- /mario-devx:build [idea] (draft pending plan)",
          "- /mario-devx:approve (execute pending plan)",
          "- /mario-devx:cancel",
          "- /mario-devx:verify",
          "- /mario-devx:status",
        ].join("\n");
      },
    }),
  };
};

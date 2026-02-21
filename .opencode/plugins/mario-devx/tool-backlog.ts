import { tool } from "@opencode-ai/plugin";

import { compactIdea } from "./interview";
import { decomposeFeatureRequestToTasks, makeTask, nextTaskOrdinal, normalizeTaskId } from "./planner";
import { writePrdJson, type PrdJson, type PrdTask } from "./prd";
import { deleteSessionBestEffort, ensureNotInWorkSession, ensureWorkSession, resolvePromptText } from "./runner";
import { ensureMario, readRunState } from "./state";
import { logReplanComplete, redactForLog } from "./logging";
import type { PluginContext, ToolContext, ToolEventLogger } from "./tool-common";

type AddInterviewState = {
  originalRequest: string;
  answers: string[];
  lastQuestion?: string;
};

const ADD_INTERVIEW_STATE_KEY = "__add_feature_interview";

const parseAddInterviewState = (raw: string | undefined): AddInterviewState | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AddInterviewState;
    if (!parsed || typeof parsed.originalRequest !== "string" || !Array.isArray(parsed.answers)) return null;
    return {
      originalRequest: parsed.originalRequest,
      answers: parsed.answers.map((a) => String(a)).filter((a) => a.trim().length > 0),
      ...(typeof parsed.lastQuestion === "string" ? { lastQuestion: parsed.lastQuestion } : {}),
    };
  } catch {
    return null;
  }
};

const writeAddInterviewState = (prd: PrdJson, state: AddInterviewState | null): PrdJson => {
  const answers = { ...(prd.wizard.answers ?? {}) };
  if (!state) {
    delete answers[ADD_INTERVIEW_STATE_KEY];
  } else {
    answers[ADD_INTERVIEW_STATE_KEY] = JSON.stringify(state);
  }
  return {
    ...prd,
    wizard: {
      ...prd.wizard,
      answers,
    },
  };
};

const nextBacklogId = (items: PrdJson["backlog"]["featureRequests"]): string => {
  const max = items.reduce((acc, item) => {
    const m = item.id.match(/^F-(\d{4})$/);
    if (!m) return acc;
    const v = Number.parseInt(m[1] ?? "0", 10);
    return Number.isFinite(v) ? Math.max(acc, v) : acc;
  }, 0);
  return `F-${String(max + 1).padStart(4, "0")}`;
};

export const createBacklogTools = (opts: {
  ctx: PluginContext;
  repoRoot: string;
  ensurePrd: (repoRoot: string) => Promise<PrdJson>;
  logToolEvent: ToolEventLogger;
}) => {
  const { ctx, repoRoot, ensurePrd, logToolEvent } = opts;

  return {
    mario_devx_add: tool({
      description: "Add a feature request and decompose into tasks",
      args: {
        feature: tool.schema.string().describe("Feature request to add"),
      },
      async execute(args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          await logToolEvent(ctx, repoRoot, "warn", "add.blocked.work-session", "Feature add blocked in work session");
          return notInWork.message;
        }
        await ensureMario(repoRoot, false);
        let prd = await ensurePrd(repoRoot);
        const feature = (args.feature ?? "").trim();
        const pendingAddInterview = parseAddInterviewState(prd.wizard.answers?.[ADD_INTERVIEW_STATE_KEY]);
        const originalFeatureRequest = pendingAddInterview?.originalRequest ?? feature;
        const clarificationAnswers = pendingAddInterview
          ? [...pendingAddInterview.answers, feature]
          : [];
        await logToolEvent(ctx, repoRoot, "info", "add.start", "Feature decomposition started", {
          featureLength: feature.length,
          runIteration: (await readRunState(repoRoot)).iteration,
          continuingInterview: !!pendingAddInterview,
        });
        if (!feature) {
          await logToolEvent(ctx, repoRoot, "warn", "add.invalid.empty", "Feature add called with empty input");
          return "Feature request is empty. Provide a short description.";
        }

        let wsSessionId: string | undefined;
        try {
          const ws = await ensureWorkSession(ctx, repoRoot, context.agent);
          wsSessionId = ws.sessionId;
          const runState = await readRunState(repoRoot);

        const featurePrompt = [
          "You are mario-devx's feature interviewer.",
          "Help the user break down a feature request into implementable tasks.",
          "",
          "Current feature request:",
          originalFeatureRequest,
          ...(clarificationAnswers.length > 0
            ? [
                "",
                "Clarification answers gathered so far:",
                ...clarificationAnswers.map((a, i) => `${i + 1}. ${a}`),
              ]
            : []),
          "",
          "Quality gates for this project:",
          JSON.stringify(prd.qualityGates ?? []),
          "",
          "Instructions:",
          "- Ask follow-up questions if the feature is vague or needs clarification",
          "- Once you have enough detail, return a JSON envelope with the breakdown",
          "- Decompose the feature into 2-5 atomic implementation tasks",
          "- Each task should be independently verifiable",
          "",
          "Return format:",
          "<FEATURE_JSON>",
          '{"ready": boolean, "tasks": string[], "acceptanceCriteria": string[], "constraints": string[], "uxNotes": string, "next_question": string | null}',
          "</FEATURE_JSON>",
          "",
          "If ready=false, ask a follow-up question in next_question.",
          "If ready=true, provide the breakdown and set next_question=null.",
        ].join("\n");

        const featureResponse = await ctx.client.session.prompt({
          path: { id: ws.sessionId },
          body: {
            ...(context.agent ? { agent: context.agent } : {}),
            parts: [{ type: "text", text: featurePrompt }],
          },
        });

        const responseText = await resolvePromptText(ctx, ws.sessionId, featureResponse);
        const jsonMatch = responseText.match(/<FEATURE_JSON>([\s\S]*?)<\/FEATURE_JSON>/i);

        if (!jsonMatch) {
          await logToolEvent(ctx, repoRoot, "error", "add.parse.missing-tags", "Feature interview response missing <FEATURE_JSON>", {
            rawResponse: redactForLog(responseText),
          });
          return "Error: Could not parse feature breakdown. The LLM response was malformed. Please try again with more detail.";
        }

        let envelope: {
          ready: boolean;
          tasks?: string[];
          acceptanceCriteria?: string[];
          constraints?: string[];
          uxNotes?: string;
          next_question?: string | null;
        };

        try {
          envelope = JSON.parse(jsonMatch[1].trim());
        } catch (err) {
          await logToolEvent(ctx, repoRoot, "error", "add.parse.invalid-json", "Feature interview JSON parse failed", {
            error: err instanceof Error ? err.message : String(err),
            rawJson: redactForLog(jsonMatch[1].trim()),
          });
          return `Error: Invalid JSON in feature response: ${err instanceof Error ? err.message : String(err)}. Please try again.`;
        }

        if (!envelope.ready || envelope.next_question) {
          prd = writeAddInterviewState(prd, {
            originalRequest: originalFeatureRequest,
            answers: clarificationAnswers,
            ...(envelope.next_question ? { lastQuestion: envelope.next_question } : {}),
          });
          await writePrdJson(repoRoot, prd);
          await logToolEvent(ctx, repoRoot, "info", "add.followup", "Feature interview requested follow-up", {
            nextQuestion: envelope.next_question || "Please provide more detail about this feature.",
          });
          return [
            "Feature interview",
            envelope.next_question || "Please provide more detail about this feature.",
            "Reply with your answer in natural language.",
          ].join("\n");
        }

        const backlogId = nextBacklogId(prd.backlog.featureRequests);
        const gates = prd.verificationPolicy?.globalGates?.length
          ? prd.verificationPolicy.globalGates
          : prd.qualityGates;
        const startN = nextTaskOrdinal(prd.tasks ?? []);
        let n = startN;

        const taskAtoms = envelope.tasks?.length ? envelope.tasks : [originalFeatureRequest];
        const newTasks = taskAtoms.map((item) => makeTask({
          id: normalizeTaskId(n++),
          title: `Implement: ${item}`,
          doneWhen: gates,
          labels: ["feature", "backlog"],
          acceptance: envelope.acceptanceCriteria?.length ? envelope.acceptanceCriteria : [item],
          ...(envelope.uxNotes ? { notes: [envelope.uxNotes] } : {}),
        }));

        const request = [
          originalFeatureRequest,
          clarificationAnswers.length > 0
            ? `\nClarifications:\n${clarificationAnswers.map((a) => `- ${a}`).join("\n")}`
            : "",
          envelope.acceptanceCriteria?.length ? `\nAcceptance:\n${envelope.acceptanceCriteria.map((a) => `- ${a}`).join("\n")}` : "",
          envelope.constraints?.length ? `\nConstraints:\n${envelope.constraints.map((c) => `- ${c}`).join("\n")}` : "",
          envelope.uxNotes ? `\nUX notes:\n${envelope.uxNotes}` : "",
        ]
          .join("\n")
          .trim();

        prd = {
          ...prd,
          tasks: [...(prd.tasks ?? []), ...newTasks],
          backlog: {
            ...prd.backlog,
            featureRequests: [
              ...prd.backlog.featureRequests,
              {
                id: backlogId,
                title: compactIdea(originalFeatureRequest),
                request: request || originalFeatureRequest,
                createdAt: new Date().toISOString(),
                status: "planned",
                taskIds: newTasks.map((t) => t.id),
              },
            ],
          },
        };
        prd = writeAddInterviewState(prd, null);
        await writePrdJson(repoRoot, prd);
        await logToolEvent(ctx, repoRoot, "info", "add.complete", "Feature decomposed into tasks", {
          backlogId,
          newTasks: newTasks.length,
          taskIds: newTasks.map((t) => t.id),
          runIteration: runState.iteration,
        });

          return [
            `Feature added: ${backlogId}`,
            `New tasks: ${newTasks.length}`,
            `Task IDs: ${newTasks.map((t) => t.id).join(", ")}`,
            `Next: /mario-devx:run 1`,
          ].join("\n");
        } finally {
          if (wsSessionId) {
            await deleteSessionBestEffort(ctx, wsSessionId, context.sessionID);
          }
        }
      },
    }),

    mario_devx_replan: tool({
      description: "Rebuild open-task plan from backlog using LLM",
      args: {},
      async execute(_args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          await logToolEvent(ctx, repoRoot, "warn", "replan.blocked.work-session", "Replan blocked in work session");
          return notInWork.message;
        }
        await ensureMario(repoRoot, false);
        let prd = await ensurePrd(repoRoot);
        const replanCandidates = prd.backlog.featureRequests.filter((f) => f.status === "open" || f.status === "planned");
        const taskById = new Map((prd.tasks ?? []).map((t) => [t.id, t] as const));
        const hasLockedTask = (featureId: string): boolean => {
          const backlogItem = replanCandidates.find((f) => f.id === featureId);
          if (!backlogItem) return false;
          return (backlogItem.taskIds ?? []).some((id) => {
            const task = taskById.get(id);
            return task?.status === "in_progress" || task?.status === "completed";
          });
        };
        const candidatesToReplan = replanCandidates.filter((f) => !hasLockedTask(f.id));
        await logToolEvent(ctx, repoRoot, "info", "replan.start", "Replan started", {
          candidates: replanCandidates.length,
          skippedLocked: replanCandidates.length - candidatesToReplan.length,
        });

        if (replanCandidates.length === 0) {
          await logToolEvent(ctx, repoRoot, "info", "replan.noop", "No backlog items to replan");
          return "No backlog items to replan.";
        }

        if (candidatesToReplan.length === 0) {
          return "No replannable backlog items: all candidates already have active/completed tasks.";
        }

        let wsSessionId: string | undefined;
        try {
          const ws = await ensureWorkSession(ctx, repoRoot, context.agent);
          wsSessionId = ws.sessionId;
          const gates = prd.verificationPolicy?.globalGates?.length
            ? prd.verificationPolicy.globalGates
            : prd.qualityGates;

        await logToolEvent(ctx, repoRoot, "info", "replan.llm.start", "Replanning backlog items via LLM", {
          candidates: replanCandidates.length,
        });

        const replanPrompt = [
          "You are mario-devx's replanning assistant.",
          "Analyze these backlog items and suggest task breakdowns.",
          "",
          "Current PRD:",
          JSON.stringify({
            idea: prd.idea,
            platform: prd.platform,
            framework: prd.framework,
            qualityGates: prd.qualityGates,
          }, null, 2),
          "",
          "Backlog items to replan:",
          candidatesToReplan.map((f, i) => `${i + 1}. ${f.title}\n${f.request}`).join("\n\n"),
          "",
          "Existing tasks:",
          (prd.tasks || []).filter((t) => t.status !== "cancelled").map((t) => `- ${t.id}: ${t.title}`).join("\n"),
          "",
          "Instructions:",
          "1. Analyze each backlog item for complexity",
          "2. Break down into 1-5 implementation tasks per item",
          "3. Consider existing tasks to avoid duplication",
          "4. Set appropriate dependencies",
          "5. Suggest doneWhen commands for each task",
          "",
          "Return format:",
          "<REPLAN_JSON>",
          JSON.stringify({
            breakdowns: [
              {
                backlogId: "F-0001",
                tasks: [
                  {
                    title: "Implement feature X part 1",
                    labels: ["feature", "backlog"],
                    doneWhen: ["npm test"],
                    dependsOn: [],
                    acceptance: ["Feature X part 1 works"],
                  },
                ],
              },
            ],
          }, null, 2),
          "</REPLAN_JSON>",
        ].join("\n");

        const replanResponse = await ctx.client.session.prompt({
          path: { id: ws.sessionId },
          body: {
            ...(context.agent ? { agent: context.agent } : {}),
            parts: [{ type: "text", text: replanPrompt }],
          },
        });

        const replanText = await resolvePromptText(ctx, ws.sessionId, replanResponse);
        const replanMatch = replanText.match(/<REPLAN_JSON>([\s\S]*?)<\/REPLAN_JSON>/i);

        let n = nextTaskOrdinal(prd.tasks ?? []);
        const generated: PrdTask[] = [];
        let updatedBacklog = [...prd.backlog.featureRequests];
        const backlogLabel = (id: string): string => `backlog:${id}`;

        if (replanMatch) {
          try {
            const parsed = JSON.parse(replanMatch[1].trim());

            for (const breakdown of parsed.breakdowns || []) {
              const backlogItem = candidatesToReplan.find((f) => f.id === breakdown.backlogId);
              if (!backlogItem) continue;

              const tasks = (breakdown.tasks || []).map((t: any) => makeTask({
                id: normalizeTaskId(n++),
                title: t.title,
                doneWhen: t.doneWhen || gates,
                labels: [...new Set([...(t.labels || ["feature", "backlog"]), backlogLabel(backlogItem.id)])],
                acceptance: t.acceptance || [t.title],
                dependsOn: t.dependsOn,
              }));

              generated.push(...tasks);

              updatedBacklog = updatedBacklog.map((f) =>
                f.id === breakdown.backlogId
                  ? { ...f, status: "planned" as const, taskIds: tasks.map((t: PrdTask) => t.id) }
                  : f,
              );
            }

            await logToolEvent(ctx, repoRoot, "info", "replan.llm.complete", "LLM generated replanned tasks", {
              generated: generated.length,
              breakdowns: parsed.breakdowns?.length || 0,
            });
          } catch (err) {
            await logToolEvent(ctx, repoRoot, "error", "replan.parse.invalid-json", "Failed to parse REPLAN_JSON", {
              error: err instanceof Error ? err.message : String(err),
              rawResponse: redactForLog(replanText),
            });
          }
        }

        if (generated.length === 0) {
          await logToolEvent(ctx, repoRoot, "warn", "replan.fallback", "Using fallback feature decomposition", {
            candidates: candidatesToReplan.length,
          });
          for (const f of candidatesToReplan) {
            if (f.status === "implemented") continue;

            const atoms = decomposeFeatureRequestToTasks(f.request);
            const tasks = atoms.map((atom) => makeTask({
              id: normalizeTaskId(n++),
              title: `Implement: ${atom}`,
              doneWhen: gates,
              labels: ["feature", "backlog", backlogLabel(f.id)],
              acceptance: [atom],
            }));
            generated.push(...tasks);

            updatedBacklog = updatedBacklog.map((bf) =>
              bf.id === f.id
                ? { ...bf, status: "planned" as const, taskIds: tasks.map((t) => t.id) }
                : bf,
            );
          }
        }

        const replannedIds = new Set(candidatesToReplan.map((f) => f.id));
        const keptTasks = (prd.tasks ?? []).filter((task) => {
          const labels = task.labels ?? [];
          const relatedFeatureId = Array.from(replannedIds).find((id) => labels.includes(backlogLabel(id)));
          if (!relatedFeatureId) return true;
          return task.status === "in_progress" || task.status === "completed";
        });

        prd = {
          ...prd,
          tasks: [
            ...keptTasks,
            ...generated,
          ],
          backlog: { ...prd.backlog, featureRequests: updatedBacklog },
        };
        await writePrdJson(repoRoot, prd);
        await logReplanComplete(ctx, repoRoot, candidatesToReplan.length, generated.length);
        await logToolEvent(ctx, repoRoot, "info", "replan.complete", "Replan completed", {
          backlogItems: candidatesToReplan.length,
          skippedLocked: replanCandidates.length - candidatesToReplan.length,
          generatedTasks: generated.length,
        });

          return [
            "Replan complete.",
            `Backlog items replanned: ${replanCandidates.length}`,
            `New tasks: ${generated.length}`,
            "Next: /mario-devx:run 1",
          ].join("\n");
        } finally {
          if (wsSessionId) {
            await deleteSessionBestEffort(ctx, wsSessionId, context.sessionID);
          }
        }
      },
    }),
  };
};

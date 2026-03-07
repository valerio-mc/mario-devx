import { tool } from "@opencode-ai/plugin";

import { compactIdea } from "./interview";
import { decomposeFeatureRequestToTasks, makeTask, nextBacklogId, nextTaskOrdinal, normalizeTaskId } from "./planner";
import { formatPrdReadErrorMessage, isPrdReadError, writePrdJson, type PrdJson, type PrdTask } from "./prd";
import { deleteSessionBestEffort, ensureNotInWorkSession, ensureWorkSession, resolvePromptText } from "./runner";
import { ensureMario, readRunState } from "./state";
import { logReplanComplete, redactForLog } from "./logging";
import type { PluginContext, ToolContext, ToolEventLogger } from "./tool-common";
import { extractTaggedBlock, tryParseJson } from "./llm-json";

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

const normalizeScalarText = (value: unknown): string => {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
};

const normalizeStringList = (value: unknown, maxItems: number): string[] => {
  if (!Array.isArray(value) || maxItems <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = normalizeScalarText(entry);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
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
        let prd: PrdJson;
        try {
          prd = await ensurePrd(repoRoot);
        } catch (error) {
          if (isPrdReadError(error)) {
            await logToolEvent(ctx, repoRoot, "error", "add.prd.read-failed", "Feature add blocked: PRD read failed", {
              code: error.code,
              filePath: error.filePath,
              ...(error.backupPath ? { backupPath: error.backupPath } : {}),
              ...(Object.prototype.hasOwnProperty.call(error, "detectedVersion") ? { detectedVersion: error.detectedVersion } : {}),
            });
            return formatPrdReadErrorMessage(error);
          }
          throw error;
        }
        if (prd.wizard.status !== "completed") {
          await logToolEvent(ctx, repoRoot, "warn", "add.blocked.wizard-incomplete", "Feature add blocked: PRD wizard incomplete", {
            wizardStatus: prd.wizard.status,
            wizardStep: prd.wizard.step,
            wizardTotalSteps: prd.wizard.totalSteps,
          });
          return [
            "Feature add blocked: PRD interview is not complete.",
            "Run /mario-devx:new until completion.",
            "Then rerun /mario-devx:add <feature request>.",
          ].join("\n");
        }
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
            ...(pendingAddInterview?.lastQuestion
              ? [
                  "",
                  "Last follow-up question asked:",
                  pendingAddInterview.lastQuestion,
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
          const featureJson = extractTaggedBlock(responseText, "FEATURE_JSON");

          if (!featureJson) {
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

          const parsedEnvelope = tryParseJson<typeof envelope>(featureJson);
          if (!parsedEnvelope.ok) {
            await logToolEvent(ctx, repoRoot, "error", "add.parse.invalid-json", "Feature interview JSON parse failed", {
              error: parsedEnvelope.error,
              rawJson: redactForLog(featureJson),
            });
            return `Error: Invalid JSON in feature response: ${parsedEnvelope.error}. Please try again.`;
          }
          envelope = parsedEnvelope.value;

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
            ].join("\n");
          }

          const backlogId = nextBacklogId(prd.backlog.featureRequests);
          const backlogTaskLabel = `backlog:${backlogId}`;
          const gates = prd.verificationPolicy?.globalGates?.length
            ? prd.verificationPolicy.globalGates
            : prd.qualityGates;
          const startN = nextTaskOrdinal(prd.tasks ?? []);
          let n = startN;

          const normalizedTasks = normalizeStringList(envelope.tasks, 5);
          const normalizedAcceptanceCriteria = normalizeStringList(envelope.acceptanceCriteria, 12);
          const normalizedConstraints = normalizeStringList(envelope.constraints, 12);
          const normalizedUxNotes = normalizeScalarText(envelope.uxNotes);

          const taskAtoms = normalizedTasks.length > 0
            ? normalizedTasks
            : [normalizeScalarText(originalFeatureRequest) || "Implement feature request"];
          const newTasks = taskAtoms.map((item) => makeTask({
            id: normalizeTaskId(n++),
            title: `Implement: ${item}`,
            doneWhen: gates,
            labels: ["feature", "backlog", backlogTaskLabel],
            acceptance: normalizedAcceptanceCriteria.length > 0 ? normalizedAcceptanceCriteria : [item],
            ...(normalizedUxNotes ? { notes: [normalizedUxNotes] } : {}),
          }));

          const request = [
            originalFeatureRequest,
            clarificationAnswers.length > 0
              ? `\nClarifications:\n${clarificationAnswers.map((a) => `- ${a}`).join("\n")}`
              : "",
            normalizedAcceptanceCriteria.length > 0
              ? `\nAcceptance:\n${normalizedAcceptanceCriteria.map((a) => `- ${a}`).join("\n")}`
              : "",
            normalizedConstraints.length > 0
              ? `\nConstraints:\n${normalizedConstraints.map((c) => `- ${c}`).join("\n")}`
              : "",
            normalizedUxNotes ? `\nUX notes:\n${normalizedUxNotes}` : "",
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
        let prd: PrdJson;
        try {
          prd = await ensurePrd(repoRoot);
        } catch (error) {
          if (isPrdReadError(error)) {
            await logToolEvent(ctx, repoRoot, "error", "replan.prd.read-failed", "Replan blocked: PRD read failed", {
              code: error.code,
              filePath: error.filePath,
              ...(error.backupPath ? { backupPath: error.backupPath } : {}),
              ...(Object.prototype.hasOwnProperty.call(error, "detectedVersion") ? { detectedVersion: error.detectedVersion } : {}),
            });
            return formatPrdReadErrorMessage(error);
          }
          throw error;
        }
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
          const replanJson = extractTaggedBlock(replanText, "REPLAN_JSON");

          let n = nextTaskOrdinal(prd.tasks ?? []);
          const generated: PrdTask[] = [];
          let updatedBacklog = [...prd.backlog.featureRequests];
          const backlogLabel = (id: string): string => `backlog:${id}`;

          if (replanJson) {
            try {
              const parsedResult = tryParseJson<{ breakdowns?: unknown }>(replanJson);
              if (!parsedResult.ok) {
                throw new Error(parsedResult.error);
              }
              const parsed = parsedResult.value;
              const rawBreakdowns = Array.isArray(parsed.breakdowns) ? parsed.breakdowns : [];

              for (const breakdown of rawBreakdowns) {
                if (!breakdown || typeof breakdown !== "object") continue;
                const breakdownPayload = breakdown as { backlogId?: unknown; tasks?: unknown };
                const backlogId = normalizeScalarText(breakdownPayload.backlogId);
                if (!backlogId) continue;
                const backlogItem = candidatesToReplan.find((f) => f.id === backlogId);
                if (!backlogItem) continue;

                const rawTasks = Array.isArray(breakdownPayload.tasks) ? breakdownPayload.tasks : [];
                const tasks = rawTasks
                  .map((rawTask): PrdTask | null => {
                    if (!rawTask || typeof rawTask !== "object") return null;
                    const taskPayload = rawTask as {
                      title?: unknown;
                      labels?: unknown;
                      doneWhen?: unknown;
                      dependsOn?: unknown;
                      acceptance?: unknown;
                    };
                    const title = normalizeScalarText(taskPayload.title);
                    if (!title) return null;
                    const doneWhen = normalizeStringList(taskPayload.doneWhen, 8);
                    const labels = normalizeStringList(taskPayload.labels, 8);
                    const dependsOn = normalizeStringList(taskPayload.dependsOn, 12);
                    const acceptance = normalizeStringList(taskPayload.acceptance, 12);
                    return makeTask({
                      id: normalizeTaskId(n++),
                      title,
                      doneWhen: doneWhen.length > 0 ? doneWhen : gates,
                      labels: [...new Set([...(labels.length > 0 ? labels : ["feature", "backlog"]), backlogLabel(backlogItem.id)])],
                      acceptance: acceptance.length > 0 ? acceptance : [title],
                      ...(dependsOn.length > 0 ? { dependsOn } : {}),
                    });
                  })
                  .filter((task): task is PrdTask => Boolean(task));

                if (tasks.length === 0) {
                  continue;
                }

                generated.push(...tasks);

                updatedBacklog = updatedBacklog.map((f) =>
                  f.id === backlogId
                    ? { ...f, status: "planned" as const, taskIds: tasks.map((t: PrdTask) => t.id) }
                    : f,
                );
              }

              await logToolEvent(ctx, repoRoot, "info", "replan.llm.complete", "LLM generated replanned tasks", {
                generated: generated.length,
                breakdowns: rawBreakdowns.length,
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
          const replannedTaskIds = new Set(
            candidatesToReplan.flatMap((f) => (Array.isArray(f.taskIds) ? f.taskIds : [])).filter((id) => typeof id === "string" && id.trim().length > 0),
          );
          const keptTasks = (prd.tasks ?? []).filter((task) => {
            if (replannedTaskIds.has(task.id)) {
              return task.status === "in_progress" || task.status === "completed";
            }
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
            `Backlog items replanned: ${candidatesToReplan.length}`,
            `Backlog items skipped (locked): ${replanCandidates.length - candidatesToReplan.length}`,
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

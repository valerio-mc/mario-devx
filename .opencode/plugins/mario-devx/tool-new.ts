import path from "path";
import { tool } from "@opencode-ai/plugin";

import { ensureMario } from "./state";
import { writePrdJson } from "./prd";
import { deleteSessionBestEffort, ensureNotInWorkSession, ensureWorkSession, resolvePromptText } from "./runner";
import { WIZARD_REQUIREMENTS } from "./config";
import { LAST_QUESTION_KEY, hasMeaningfulList, isPrdComplete } from "./interview";
import type { PluginContext, ToolContext, ToolEventLogger } from "./tool-common";

type PrdLike = any;

export const createNewTool = (opts: {
  ctx: PluginContext;
  repoRoot: string;
  ensurePrd: (repoRoot: string) => Promise<PrdLike>;
  logToolEvent: ToolEventLogger;
  hasNonEmpty: (value: string | null | undefined) => boolean;
  extractStyleReferencesFromText: (text: string) => string[];
  mergeStyleReferences: (existing: string[] | undefined, next: string[]) => string[];
  parseQualityGateSelectionState: (raw: string | undefined) => any;
  writeQualityGateSelectionState: (prd: PrdLike, state: any | null) => PrdLike;
  resolveQualityGatePresetChoice: (answer: string, state: any) => any;
  applyInterviewUpdates: (prd: PrdLike, updates: Record<string, unknown>) => PrdLike;
  normalizeTextArray: (value: string[]) => string[];
  normalizeQuestionKey: (value: string) => string;
  isNoneLikeAnswer: (value: string) => boolean;
  interviewPrompt: (prd: PrdLike, input: string) => string;
  parseInterviewTurn: (text: string) => { done: boolean; question: string | null; error?: string };
  interviewTurnRepairPrompt: (invalidOutput: string) => string;
  parseCompileInterviewResponse: (text: string) => { envelope: { updates?: Record<string, unknown>; next_question?: string } | null; error?: string };
  compileInterviewPrompt: (prd: PrdLike) => string;
  compileRepairPrompt: (invalidOutput: string) => string;
  qualityGatePresetPrompt: (prd: PrdLike) => string;
  parseQualityGatePresetResponse: (text: string) => any;
  qualityGatePresetRepairPrompt: (invalidResponse: string) => string;
  formatQualityGateSelectionQuestion: (state: any) => string;
  repeatedQuestionRepairPrompt: (previousQuestion: string, latestAnswer: string) => string;
  seedTasksFromPrd: (repoRoot: string, prd: PrdLike, ctx: PluginContext) => Promise<PrdLike>;
  logPrdComplete: (ctx: PluginContext, repoRoot: string, taskCount: number) => Promise<void>;
  STYLE_REFS_ACK_KEY: string;
  INTERVIEW_ANSWER_PREFIX: string;
  QUALITY_GATES_STATE_KEY: string;
  STYLE_REFS_REQUIRED_QUESTION: string;
}) => {
  const {
    ctx,
    repoRoot,
    ensurePrd,
    logToolEvent,
    hasNonEmpty,
    extractStyleReferencesFromText,
    mergeStyleReferences,
    parseQualityGateSelectionState,
    writeQualityGateSelectionState,
    resolveQualityGatePresetChoice,
    applyInterviewUpdates,
    normalizeTextArray,
    normalizeQuestionKey,
    isNoneLikeAnswer,
    interviewPrompt,
    parseInterviewTurn,
    interviewTurnRepairPrompt,
    parseCompileInterviewResponse,
    compileInterviewPrompt,
    compileRepairPrompt,
    qualityGatePresetPrompt,
    parseQualityGatePresetResponse,
    qualityGatePresetRepairPrompt,
    formatQualityGateSelectionQuestion,
    repeatedQuestionRepairPrompt,
    seedTasksFromPrd,
    logPrdComplete,
    STYLE_REFS_ACK_KEY,
    INTERVIEW_ANSWER_PREFIX,
    QUALITY_GATES_STATE_KEY,
    STYLE_REFS_REQUIRED_QUESTION,
  } = opts;

  return {
    mario_devx_new: tool({
      description: "Interactive PRD interview (writes .mario/prd.json)",
      args: {
        idea: tool.schema.string().optional().describe("Initial idea"),
      },
      async execute(args, context: ToolContext) {
        const notInWork = await ensureNotInWorkSession(repoRoot, context);
        if (!notInWork.ok) {
          await logToolEvent(ctx, repoRoot, "warn", "new.blocked.work-session", "PRD interview blocked in work session");
          return notInWork.message;
        }

        await ensureMario(repoRoot, false);
        let prd = await ensurePrd(repoRoot);
        const rawInput = (args.idea ?? "").trim();
        await logToolEvent(ctx, repoRoot, "info", "new.start", "PRD interview step started", {
          wizardStatus: prd.wizard.status,
          hasInput: rawInput.length > 0,
          inputLength: rawInput.length,
        });

        if (prd.wizard.status === "completed") {
          await logToolEvent(ctx, repoRoot, "info", "new.noop.completed", "PRD already completed");
          return [
            "PRD wizard: completed.",
            `Edit: ${path.join(repoRoot, ".mario", "prd.json")}`,
            "Next: /mario-devx:run 1",
          ].join("\n");
        }

        const isBootstrapIdea = rawInput.length > 0 && prd.wizard.step === 0 && !hasNonEmpty(prd.idea);
        if (isBootstrapIdea) {
          prd = {
            ...prd,
            idea: rawInput,
          };
        }

        const hasAnswer = rawInput.length > 0 && !isBootstrapIdea;
        if (rawInput.length > 0) {
          const extractedStyleRefs = extractStyleReferencesFromText(rawInput);
          if (extractedStyleRefs.length > 0) {
            prd = {
              ...prd,
              ui: {
                ...prd.ui,
                styleReferences: mergeStyleReferences(prd.ui.styleReferences, extractedStyleRefs),
              },
            };
          }
        }

        if (hasAnswer) {
          prd = {
            ...prd,
            wizard: {
              ...prd.wizard,
              answers: {
                ...prd.wizard.answers,
                [`${INTERVIEW_ANSWER_PREFIX}${Date.now()}`]: rawInput,
              },
            },
          };
        }

        const pendingQualityGateSelection = parseQualityGateSelectionState(prd.wizard.answers?.[QUALITY_GATES_STATE_KEY]);
        if (pendingQualityGateSelection && hasMeaningfulList(prd.qualityGates, WIZARD_REQUIREMENTS.MIN_QUALITY_GATES)) {
          prd = writeQualityGateSelectionState(prd, null);
        }
        const activeQualityGateSelection = parseQualityGateSelectionState(prd.wizard.answers?.[QUALITY_GATES_STATE_KEY]);

        if (activeQualityGateSelection && hasAnswer) {
          const chosen = resolveQualityGatePresetChoice(rawInput, activeQualityGateSelection);
          if (chosen) {
            prd = writeQualityGateSelectionState(prd, null);
            prd = applyInterviewUpdates(prd, { qualityGates: chosen.commands });
            await writePrdJson(repoRoot, prd);
            await logToolEvent(ctx, repoRoot, "info", "new.quality-gates.selected", "Quality gate preset selected", {
              label: chosen.label,
              commandCount: chosen.commands.length,
            });
          } else {
            const customCommands = normalizeTextArray(
              rawInput
                .split(/\r?\n|;/)
                .flatMap((line) => line.split(","))
                .map((x) => x.trim())
                .filter(Boolean),
            );
            if (customCommands.length >= WIZARD_REQUIREMENTS.MIN_QUALITY_GATES) {
              prd = writeQualityGateSelectionState(prd, null);
              prd = applyInterviewUpdates(prd, { qualityGates: customCommands });
              await writePrdJson(repoRoot, prd);
              await logToolEvent(ctx, repoRoot, "info", "new.quality-gates.custom", "Custom quality gates captured from user answer", {
                commandCount: customCommands.length,
              });
            }
          }
        }

        const refreshedQualityGateSelection = parseQualityGateSelectionState(prd.wizard.answers?.[QUALITY_GATES_STATE_KEY]);
        if (refreshedQualityGateSelection && !hasMeaningfulList(prd.qualityGates, WIZARD_REQUIREMENTS.MIN_QUALITY_GATES)) {
          const selectionQuestion = formatQualityGateSelectionQuestion(refreshedQualityGateSelection);
          prd = {
            ...prd,
            wizard: {
              ...prd.wizard,
              answers: {
                ...prd.wizard.answers,
                [LAST_QUESTION_KEY]: selectionQuestion,
              },
            },
          };
          await writePrdJson(repoRoot, prd);
          return [
            "PRD interview",
            selectionQuestion,
            "Pick one option or type your own quality gate commands.",
          ].join("\n");
        }

        const cachedQuestion = prd.wizard.answers?.[LAST_QUESTION_KEY];
        if (
          hasAnswer
          && typeof cachedQuestion === "string"
          && normalizeQuestionKey(cachedQuestion) === normalizeQuestionKey(STYLE_REFS_REQUIRED_QUESTION)
          && isNoneLikeAnswer(rawInput)
        ) {
          prd = {
            ...prd,
            wizard: {
              ...prd.wizard,
              answers: {
                ...prd.wizard.answers,
                [STYLE_REFS_ACK_KEY]: "true",
              },
            },
          };
        }
        if (!hasAnswer && cachedQuestion) {
          await logToolEvent(ctx, repoRoot, "info", "new.question.cached", "Returning cached interview question");
          return [
            "PRD interview",
            cachedQuestion,
            "Reply with your answer in natural language.",
          ].join("\n");
        }

        let wsSessionId: string | undefined;
        try {
          const ws = await ensureWorkSession(ctx, repoRoot, undefined);
          wsSessionId = ws.sessionId;
          const interviewInput = hasAnswer
            ? rawInput
            : (isBootstrapIdea ? `Project idea provided: ${prd.idea}` : "Start the interview and ask the first question.");
          const interviewResponse = await ctx.client.session.prompt({
            path: { id: ws.sessionId },
            body: {
              parts: [{ type: "text", text: interviewPrompt(prd, interviewInput) }],
            },
          });
          const text = await resolvePromptText(ctx, ws.sessionId, interviewResponse);
          let parsedInterview = parseInterviewTurn(text);

          if (parsedInterview.error) {
            await logToolEvent(ctx, repoRoot, "error", "new.interview.parse-error", "Failed to parse interview turn", {
              error: parsedInterview.error,
            });

            const repairResponse = await ctx.client.session.prompt({
              path: { id: ws.sessionId },
              body: {
                parts: [{ type: "text", text: interviewTurnRepairPrompt(text) }],
              },
            });
            const repairedText = await resolvePromptText(ctx, ws.sessionId, repairResponse);
            const repairedInterview = parseInterviewTurn(repairedText);

            if (!repairedInterview.error) {
              await logToolEvent(ctx, repoRoot, "info", "new.interview.recovered", "Recovered malformed interview response");
              parsedInterview = repairedInterview;
            } else {
              await logToolEvent(ctx, repoRoot, "error", "new.interview.parse-error-retry", "Interview parse retry failed", {
                error: repairedInterview.error,
              });
              const fallbackQuestion = repairedInterview.question || parsedInterview.question || "In one sentence, what are we building?";
              return [
                "PRD interview",
                fallbackQuestion,
                "Reply with your answer in natural language.",
              ].join("\n");
            }
          }

          let done = parsedInterview.done;
          let finalQuestion = parsedInterview.question || "What else should we capture?";

          if (parsedInterview.done) {
            const compileResponse = await ctx.client.session.prompt({
              path: { id: ws.sessionId },
              body: {
                parts: [{ type: "text", text: compileInterviewPrompt(prd) }],
              },
            });
            const compileText = await resolvePromptText(ctx, ws.sessionId, compileResponse);
            let compiled = parseCompileInterviewResponse(compileText);
            if (compiled.error) {
              await logToolEvent(ctx, repoRoot, "error", "new.compile.parse-error", "Failed to parse compiled interview envelope", {
                error: compiled.error,
              });
              const repairResponse = await ctx.client.session.prompt({
                path: { id: ws.sessionId },
                body: {
                  parts: [{ type: "text", text: compileRepairPrompt(compileText) }],
                },
              });
              const repairedText = await resolvePromptText(ctx, ws.sessionId, repairResponse);
              compiled = parseCompileInterviewResponse(repairedText);
              if (compiled.error) {
                await logToolEvent(ctx, repoRoot, "error", "new.compile.parse-error-retry", "Compile parse retry failed", {
                  error: compiled.error,
                });
              }
            }

            if (compiled.envelope?.updates) {
              prd = applyInterviewUpdates(prd, compiled.envelope.updates);
            }
            done = isPrdComplete(prd);
            finalQuestion = (compiled.envelope?.next_question || "What should we clarify next to finish the PRD?").trim();
          }

          if (
            done
            && prd.frontend
            && (prd.ui.styleReferences ?? []).length === 0
            && prd.wizard.answers?.[STYLE_REFS_ACK_KEY] !== "true"
          ) {
            done = false;
            finalQuestion = STYLE_REFS_REQUIRED_QUESTION;
          }

          if (!done && !hasMeaningfulList(prd.qualityGates, WIZARD_REQUIREMENTS.MIN_QUALITY_GATES)) {
            const existingSelection = parseQualityGateSelectionState(prd.wizard.answers?.[QUALITY_GATES_STATE_KEY]);
            if (!existingSelection) {
              const presetResponse = await ctx.client.session.prompt({
                path: { id: ws.sessionId },
                body: {
                  parts: [{ type: "text", text: qualityGatePresetPrompt(prd) }],
                },
              });
              const presetText = await resolvePromptText(ctx, ws.sessionId, presetResponse);
              let selection = parseQualityGatePresetResponse(presetText);
              if (!selection) {
                const repairResponse = await ctx.client.session.prompt({
                  path: { id: ws.sessionId },
                  body: {
                    parts: [{ type: "text", text: qualityGatePresetRepairPrompt(presetText) }],
                  },
                });
                const repairText = await resolvePromptText(ctx, ws.sessionId, repairResponse);
                selection = parseQualityGatePresetResponse(repairText);
              }
              if (selection) {
                prd = writeQualityGateSelectionState(prd, selection);
                finalQuestion = formatQualityGateSelectionQuestion(selection);
                await logToolEvent(ctx, repoRoot, "info", "new.quality-gates.suggested", "Suggested quality gate presets", {
                  options: selection.options.map((o: { label: string }) => o.label),
                  llmGenerated: true,
                });
              } else {
                finalQuestion = "List at least 2 runnable quality-gate commands for this project (one per line).";
                await logToolEvent(ctx, repoRoot, "warn", "new.quality-gates.suggest-failed", "Failed to generate quality gate presets", {
                  llmGenerated: false,
                });
              }
            }
            done = false;
          }

          if (!done) {
          if (
            hasAnswer
            && typeof cachedQuestion === "string"
            && normalizeQuestionKey(finalQuestion) === normalizeQuestionKey(cachedQuestion)
          ) {
            const repeatRepairResponse = await ctx.client.session.prompt({
              path: { id: ws.sessionId },
              body: {
                parts: [{ type: "text", text: repeatedQuestionRepairPrompt(cachedQuestion, rawInput) }],
              },
            });
            const repeatRepairText = await resolvePromptText(ctx, ws.sessionId, repeatRepairResponse);
            const repeatRepairTurn = parseInterviewTurn(repeatRepairText);
            if (!repeatRepairTurn.error && repeatRepairTurn.question) {
              finalQuestion = repeatRepairTurn.question;
            }
          }

            prd = {
            ...prd,
            wizard: {
              ...prd.wizard,
              step: 0,
              totalSteps: WIZARD_REQUIREMENTS.TOTAL_STEPS,
              status: "in_progress",
              lastQuestionId: "interview",
              answers: {
                ...prd.wizard.answers,
                [`q-${Date.now()}`]: finalQuestion,
                [LAST_QUESTION_KEY]: finalQuestion,
              },
            },
          };
            await writePrdJson(repoRoot, prd);
            await logToolEvent(ctx, repoRoot, "info", "new.question", "PRD follow-up question generated", {
              question: finalQuestion,
            });
            return [
              `PRD interview (0/${WIZARD_REQUIREMENTS.TOTAL_STEPS})`,
              finalQuestion,
              "Reply with your answer in natural language.",
            ].join("\n");
          }

          prd = {
          ...prd,
          wizard: {
            ...prd.wizard,
            step: WIZARD_REQUIREMENTS.TOTAL_STEPS,
            totalSteps: WIZARD_REQUIREMENTS.TOTAL_STEPS,
            status: "completed",
            lastQuestionId: "done",
            answers: {
              ...prd.wizard.answers,
              [LAST_QUESTION_KEY]: "done",
            },
          },
        };

          prd = await seedTasksFromPrd(repoRoot, prd, ctx);
          await writePrdJson(repoRoot, prd);
          await logPrdComplete(ctx, repoRoot, prd.tasks.length);
          await logToolEvent(ctx, repoRoot, "info", "new.complete", "PRD interview completed and tasks seeded", {
            tasks: prd.tasks.length,
          });
          return [
            "PRD wizard: completed.",
            `PRD: ${path.join(repoRoot, ".mario", "prd.json")}`,
            `Tasks: ${prd.tasks.length}`,
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

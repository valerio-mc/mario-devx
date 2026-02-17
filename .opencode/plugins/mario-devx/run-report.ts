import type { PrdTask, PrdTaskAttempt } from "./prd";

export type RunSummary = {
  result: string;
  latestTask: PrdTask | null;
  latestAttempt: PrdTaskAttempt | undefined;
  judgeTopReason: string;
};

type BuildRunSummaryOptions = {
  attempted: number;
  completed: number;
  maxItems: number;
  tasks: PrdTask[];
  runNotes: string[];
  uiVerifyRequired: boolean;
};

export const buildRunSummary = (opts: BuildRunSummaryOptions): RunSummary => {
  const { attempted, completed, maxItems, tasks, runNotes, uiVerifyRequired } = opts;
  const latestTask = tasks
    .filter((t) => t.lastAttempt)
    .sort((a, b) => (b.lastAttempt?.iteration ?? 0) - (a.lastAttempt?.iteration ?? 0))[0] ?? null;

  const latestAttempt = latestTask?.lastAttempt;
  const passedGates = latestAttempt?.gates.commands.filter((c) => c.ok).length ?? 0;
  const totalGates = latestAttempt?.gates.commands.length ?? 0;
  const uiSummary = latestAttempt?.ui
    ? (latestAttempt.ui.ran ? `UI verify: ${latestAttempt.ui.ok ? "PASS" : "FAIL"}${uiVerifyRequired ? " (required)" : " (optional)"}` : "UI verify: not run")
    : "UI verify: not available";
  const judgeTopReason = latestAttempt?.judge.reason?.[0] ?? "No judge reason recorded.";

  const note =
    attempted === 0 && latestAttempt
      ? "Stopped before execution. See task.lastAttempt.judge in .mario/prd.json."
      : completed === attempted && attempted === maxItems
      ? "Reached max_items limit."
      : completed === attempted
        ? "No more open/in_progress tasks found."
        : "Stopped early due to failure. See task.lastAttempt.judge in .mario/prd.json.";

  const result = [
    `Run finished. Attempted: ${attempted}. Completed: ${completed}. ${note}`,
    ...(runNotes.length > 0 ? [`Notes: ${runNotes.join(" ")}`] : []),
    latestTask ? `Task: ${latestTask.id} (${latestTask.status}) - ${latestTask.title}` : "Task: n/a",
    `Gates: ${passedGates}/${totalGates} PASS`,
    uiSummary,
    latestAttempt ? `Judge: ${latestAttempt.judge.status} (exit=${latestAttempt.judge.exitSignal})` : "Judge: n/a",
    `Reason: ${judgeTopReason}`,
  ].join("\n");

  return { result, latestTask, latestAttempt, judgeTopReason };
};

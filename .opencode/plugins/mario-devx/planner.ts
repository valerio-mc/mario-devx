import path from "path";
import { readTextIfExists } from "./fs";
import type { PrdJson, PrdTask, PrdTaskAttempt, PrdTaskStatus } from "./prd";
import { hasNonEmpty, normalizeTextArray } from "./interview";

export const readmeSectionGate = (section: string, escapeDoubleQuoted: (value: string) => string): string => {
  const escaped = escapeDoubleQuoted(section.trim());
  return `node -e "const fs=require('fs');const s=fs.readFileSync('README.md','utf8');process.exit(/^(?:#{1,3})\\s*${escaped}\\s*$/mi.test(s)?0:1)"`;
};

export const firstScaffoldHintFromNotes = (notes: string[] | undefined): string | null => {
  if (!notes || notes.length === 0) return null;
  const hint = notes.find((n) => n.startsWith("Preferred scaffold command (optional): "));
  if (!hint) return null;
  return hint.replace("Preferred scaffold command (optional): ", "").trim() || null;
};

export const isScaffoldMissingGateCommand = (command: string): boolean => {
  const c = command.trim();
  return (
    c === "test -f package.json || test -f app/package.json"
    || c === "test -f package.json"
    || c === "test -d app || test -d src/app"
    || c === "test -f pyproject.toml || test -f requirements.txt"
    || c === "test -f go.mod"
    || c === "test -f Cargo.toml"
  );
};

export const inferBootstrapCommand = async (repoRoot: string, prd: PrdJson): Promise<string | null> => {
  const hasRootPkg = !!(await readTextIfExists(path.join(repoRoot, "package.json")));
  const hasAppPkg = !!(await readTextIfExists(path.join(repoRoot, "app", "package.json")));
  if (hasRootPkg || hasAppPkg) {
    return null;
  }

  if (prd.language === "typescript" || prd.platform === "web") {
    return "mkdir -p app && npx --yes create-vite@latest app --template react-ts";
  }
  if (prd.language === "python") {
    return "python3 -m venv .venv && python3 -m pip install --upgrade pip";
  }
  if (prd.language === "go") {
    return "test -f go.mod || go mod init app";
  }
  if (prd.language === "rust") {
    return "test -f Cargo.toml || cargo init --name app";
  }
  return null;
};

export const inferBootstrapDoneWhen = async (repoRoot: string, prd: PrdJson): Promise<string[]> => {
  const hasPackageJson = !!(await readTextIfExists(path.join(repoRoot, "package.json")));
  const hasAppPackageJson = !!(await readTextIfExists(path.join(repoRoot, "app", "package.json")));
  const hasPyproject = !!(await readTextIfExists(path.join(repoRoot, "pyproject.toml")));
  const hasRequirements = !!(await readTextIfExists(path.join(repoRoot, "requirements.txt")));
  const hasGoMod = !!(await readTextIfExists(path.join(repoRoot, "go.mod")));
  const hasCargoToml = !!(await readTextIfExists(path.join(repoRoot, "Cargo.toml")));

  if (prd.language === "typescript" || prd.platform === "web") {
    return ["test -f package.json || test -f app/package.json"];
  }
  if (prd.language === "python") {
    if (!hasPyproject && !hasRequirements) {
      return ["test -f pyproject.toml || test -f requirements.txt"];
    }
    return [hasPyproject ? "test -f pyproject.toml" : "test -f requirements.txt"];
  }
  if (prd.language === "go") {
    return ["test -f go.mod"];
  }
  if (prd.language === "rust") {
    return ["test -f Cargo.toml"];
  }

  const fallback: string[] = [];
  if (hasPackageJson) fallback.push("test -f package.json");
  if (hasPyproject) fallback.push("test -f pyproject.toml");
  if (hasGoMod) fallback.push("test -f go.mod");
  if (hasCargoToml) fallback.push("test -f Cargo.toml");
  return fallback.length > 0 ? fallback : ["test -d ."];
};

export const scaffoldPlanFromPrd = async (repoRoot: string, prd: PrdJson): Promise<{ doneWhen: string[]; notes: string[] }> => {
  const notes: string[] = [
    "Seeded by PRD interviewer.",
    "First task scaffolds project artifacts before strict quality gates are enforced.",
    "Scaffold implementation is agent-chosen; command hints below are optional defaults.",
  ];
  const inferred = await inferBootstrapDoneWhen(repoRoot, prd);
  const scaffoldCommand = await inferBootstrapCommand(repoRoot, prd);
  notes.push("Preferred scaffold action (optional): initialize project skeleton for the chosen stack in this repository.");
  if (scaffoldCommand) {
    notes.push(`Preferred scaffold command (optional): ${scaffoldCommand}`);
  }
  return { doneWhen: inferred, notes };
};

export const normalizeTaskId = (n: number): string => `T-${String(n).padStart(4, "0")}`;

export const nextTaskOrdinal = (tasks: PrdTask[]): number => {
  const max = tasks.reduce((acc, t) => {
    const m = t.id.match(/^T-(\d{4})$/);
    if (!m) return acc;
    const v = Number.parseInt(m[1] ?? "0", 10);
    return Number.isFinite(v) ? Math.max(acc, v) : acc;
  }, 0);
  return max + 1;
};

export const nextBacklogId = (items: PrdJson["backlog"]["featureRequests"]): string => {
  const max = items.reduce((acc, item) => {
    const m = item.id.match(/^F-(\d{4})$/);
    if (!m) return acc;
    const v = Number.parseInt(m[1] ?? "0", 10);
    return Number.isFinite(v) ? Math.max(acc, v) : acc;
  }, 0);
  return `F-${String(max + 1).padStart(4, "0")}`;
};

export const decomposeFeatureRequestToTasks = (feature: string): string[] => {
  const compact = feature.replace(/\s+/g, " ").trim();
  if (!compact) return [];
  // Simple decomposition: split by commas or return as single item
  const byCommas = compact.split(",").map((p) => p.trim()).filter(Boolean);
  return byCommas.length > 1 ? byCommas : [compact];
};

export const normalizeMustHaveFeatureAtoms = (features: string[] | undefined): string[] => {
  return normalizeTextArray(features);
};

export const makeTask = (params: {
  id: string;
  status?: PrdTaskStatus;
  title: string;
  scope?: string[];
  parentId?: string;
  dependsOn?: string[];
  labels?: string[];
  acceptance?: string[];
  doneWhen: string[];
  evidence?: string[];
  notes?: string[];
}): PrdTask => {
  return {
    id: params.id,
    status: params.status ?? "open",
    title: params.title,
    scope: params.scope ?? ["**/*"],
    ...(params.parentId ? { parentId: params.parentId } : {}),
    ...(params.dependsOn ? { dependsOn: params.dependsOn } : {}),
    ...(params.labels ? { labels: params.labels } : {}),
    ...(params.acceptance ? { acceptance: params.acceptance } : {}),
    doneWhen: params.doneWhen,
    evidence: params.evidence ?? [],
    ...(params.notes ? { notes: params.notes } : {}),
  };
};

const isTerminalStatus = (status: PrdTaskStatus): boolean => status === "completed" || status === "cancelled";

const isRunnableCandidateStatus = (status: PrdTaskStatus): boolean => {
  return status === "open" || status === "in_progress" || status === "blocked";
};

export const getTaskDependencyBlockers = (prd: PrdJson, task: PrdTask): { pending: PrdTask[]; missing: string[] } => {
  const dependencies = task.dependsOn ?? [];
  if (dependencies.length === 0) {
    return { pending: [], missing: [] };
  }
  const tasksById = new Map((prd.tasks ?? []).map((t) => [t.id, t] as const));
  const pending: PrdTask[] = [];
  const missing: string[] = [];
  for (const depId of dependencies) {
    const dep = tasksById.get(depId);
    if (!dep) {
      missing.push(depId);
      continue;
    }
    if (!isTerminalStatus(dep.status)) {
      pending.push(dep);
    }
  }
  return { pending, missing };
};

export type TaskGraphIssue = {
  reasonCode: "TASK_GRAPH_DEP_MISSING" | "TASK_GRAPH_CYCLE";
  taskId: string;
  message: string;
  nextActions: string[];
};

export const validateTaskGraph = (prd: PrdJson): TaskGraphIssue | null => {
  const tasks = prd.tasks ?? [];
  const activeTasks = tasks.filter((t) => !isTerminalStatus(t.status));
  const allTasksById = new Map(tasks.map((t) => [t.id, t] as const));
  const activeById = new Map(activeTasks.map((t) => [t.id, t] as const));

  for (const task of activeTasks) {
    for (const depId of task.dependsOn ?? []) {
      if (!allTasksById.has(depId)) {
        return {
          reasonCode: "TASK_GRAPH_DEP_MISSING",
          taskId: task.id,
          message: `Task ${task.id} depends on missing task ${depId}.`,
          nextActions: [
            `Fix dependsOn for ${task.id} in .mario/prd.json (remove or correct ${depId}).`,
            "Then rerun /mario-devx:run 1.",
          ],
        };
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (taskId: string): string[] | null => {
    if (visited.has(taskId)) return null;
    if (visiting.has(taskId)) {
      const idx = stack.indexOf(taskId);
      if (idx >= 0) {
        return [...stack.slice(idx), taskId];
      }
      return [taskId, taskId];
    }
    visiting.add(taskId);
    stack.push(taskId);
    const task = activeById.get(taskId);
    const deps = task?.dependsOn ?? [];
    for (const depId of deps) {
      if (!activeById.has(depId)) continue;
      const cycle = visit(depId);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return null;
  };

  for (const task of activeTasks) {
    const cycle = visit(task.id);
    if (cycle) {
      const chain = cycle.join(" -> ");
      return {
        reasonCode: "TASK_GRAPH_CYCLE",
        taskId: cycle[0] ?? task.id,
        message: `Task dependency cycle detected: ${chain}.`,
        nextActions: [
          "Edit task dependsOn entries in .mario/prd.json to break the cycle.",
          "Then rerun /mario-devx:run 1.",
        ],
      };
    }
  }

  return null;
};

export const getNextPrdTask = (prd: PrdJson): PrdTask | null => {
  const tasks = prd.tasks ?? [];

  for (const task of tasks) {
    if (!isRunnableCandidateStatus(task.status)) continue;
    const blockers = getTaskDependencyBlockers(prd, task);
    if (blockers.pending.length === 0 && blockers.missing.length === 0) {
      return task;
    }
  }

  for (const task of tasks) {
    if (task.status === "open" || task.status === "in_progress") {
      return task;
    }
  }

  for (const task of tasks) {
    if (!isTerminalStatus(task.status)) {
      return task;
    }
  }
  return null;
};

export const setPrdTaskStatus = (prd: PrdJson, taskId: string, status: PrdTaskStatus): PrdJson => {
  const tasks = (prd.tasks ?? []).map((t) => (t.id === taskId ? { ...t, status } : t));
  return { ...prd, tasks };
};

export const setPrdTaskLastAttempt = (prd: PrdJson, taskId: string, lastAttempt: PrdTaskAttempt): PrdJson => {
  const tasks = (prd.tasks ?? []).map((t) => (t.id === taskId ? { ...t, lastAttempt } : t));
  return { ...prd, tasks };
};

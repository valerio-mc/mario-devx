import path from "path";

export type PluginContext = {
  directory?: string;
  worktree?: string;
};

export const getRepoRoot = (ctx: PluginContext): string => {
  return ctx.worktree ?? ctx.directory ?? process.cwd();
};

export const marioRoot = (repoRoot: string): string => {
  return path.join(repoRoot, ".mario");
};

export const marioStateDir = (repoRoot: string): string => {
  return path.join(marioRoot(repoRoot), "state");
};

export const marioRunsDir = (repoRoot: string): string => {
  return path.join(marioRoot(repoRoot), "runs");
};

export const marioPromptsDir = (repoRoot: string): string => {
  return path.join(marioRoot(repoRoot), "prompts");
};

export const assetsDir = (): string => {
  return path.join(import.meta.dir, "assets");
};

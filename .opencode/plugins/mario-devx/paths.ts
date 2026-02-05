import path from "path";

export const getRepoRoot = (ctx: { directory?: string; worktree?: string }): string => {
  return ctx.worktree ?? ctx.directory ?? process.cwd();
};

export const marioRoot = (repoRoot: string): string => {
  return path.join(repoRoot, ".mario");
};

export const marioStateDir = (repoRoot: string): string => {
  return path.join(marioRoot(repoRoot), "state");
};

export const assetsDir = (): string => {
  return path.join(import.meta.dir, "assets");
};

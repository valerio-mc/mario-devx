import path from "path";
import { fileURLToPath } from "url";

export const getRepoRoot = (ctx: { directory?: string; worktree?: string }): string => {
  return path.resolve(ctx.worktree ?? ctx.directory ?? process.cwd());
};

export const isPathInside = (baseDir: string, candidatePath: string): boolean => {
  const baseAbs = path.resolve(baseDir);
  const candidateAbs = path.resolve(candidatePath);
  const rel = path.relative(baseAbs, candidateAbs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export const resolvePathInside = (baseDir: string, ...segments: string[]): string => {
  const resolved = path.resolve(baseDir, ...segments);
  if (!isPathInside(baseDir, resolved)) {
    throw new Error(`Resolved path escapes base directory: ${resolved}`);
  }
  return resolved;
};

export const marioRoot = (repoRoot: string): string => {
  return path.join(repoRoot, ".mario");
};

export const marioStateDir = (repoRoot: string): string => {
  return path.join(marioRoot(repoRoot), "state");
};

export const assetsDir = (): string => {
  return fileURLToPath(new URL("./assets", import.meta.url));
};

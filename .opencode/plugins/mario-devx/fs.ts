import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { access } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

export const ensureDir = async (dirPath: string): Promise<void> => {
  await mkdir(dirPath, { recursive: true });
};

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const readText = async (filePath: string): Promise<string> => {
  return readFile(filePath, "utf8");
};

export const readTextIfExists = async (filePath: string): Promise<string | null> => {
  if (!(await fileExists(filePath))) {
    return null;
  }
  return readText(filePath);
};

export const writeText = async (filePath: string, content: string): Promise<void> => {
  await writeFile(filePath, content, "utf8");
};

export const writeTextAtomic = async (filePath: string, content: string): Promise<void> => {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await writeFile(tempPath, content, "utf8");
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
};

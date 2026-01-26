import { mkdir, readFile, writeFile } from "fs/promises";
import { access } from "fs/promises";

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

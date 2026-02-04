import path from "path";
import { ensureDir, fileExists, readText, writeText } from "./fs";
import { assetsDir, marioRoot, marioStateDir } from "./paths";

type AssetCopy = {
  source: string;
  destination: string;
};

const templateAssets: AssetCopy[] = [
  { source: "templates/prd.json", destination: "prd.json" },
  { source: "templates/AGENTS.md", destination: "AGENTS.md" },
];


const copyAsset = async (
  repoRoot: string,
  asset: AssetCopy,
  force: boolean,
): Promise<void> => {
  const srcPath = path.join(assetsDir(), asset.source);
  const destPath = path.join(marioRoot(repoRoot), asset.destination);
  if (!force && (await fileExists(destPath))) {
    return;
  }
  const content = await readText(srcPath);
  await ensureDir(path.dirname(destPath));
  await writeText(destPath, content);
};

export const seedMarioAssets = async (
  repoRoot: string,
  force = false,
): Promise<void> => {
  await ensureDir(marioRoot(repoRoot));
  await ensureDir(marioStateDir(repoRoot));

  for (const asset of templateAssets) {
    await copyAsset(repoRoot, asset, force);
  }
};

export const getPromptTemplatePath = (mode: string): string => {
  return path.join(assetsDir(), `prompts/PROMPT_${mode}.md`);
};

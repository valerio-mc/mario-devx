import path from "path";
import { ensureDir, fileExists, readText, writeText } from "./fs";
import { assetsDir, marioPromptsDir, marioRoot, marioStateDir } from "./paths";

type AssetCopy = {
  source: string;
  destination: string;
};

const promptAssets: AssetCopy[] = [
  {
    source: "prompts/PROMPT_prd.md",
    destination: "prompts/PROMPT_prd.md",
  },
  {
    source: "prompts/PROMPT_plan.md",
    destination: "prompts/PROMPT_plan.md",
  },
  {
    source: "prompts/PROMPT_build.md",
    destination: "prompts/PROMPT_build.md",
  },
  {
    source: "prompts/PROMPT_verify_llm.md",
    destination: "prompts/PROMPT_verify_llm.md",
  },
];

const templateAssets: AssetCopy[] = [
  { source: "templates/PRD.md", destination: "PRD.md" },
  { source: "templates/AGENTS.md", destination: "AGENTS.md" },
  {
    source: "templates/IMPLEMENTATION_PLAN.md",
    destination: "IMPLEMENTATION_PLAN.md",
  },
  { source: "templates/mario.gitignore", destination: ".gitignore" },
];

const stateAssets: AssetCopy[] = [
  { source: "templates/state/feedback.md", destination: "state/feedback.md" },
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
  await ensureDir(marioPromptsDir(repoRoot));
  await ensureDir(marioStateDir(repoRoot));

  for (const asset of templateAssets) {
    await copyAsset(repoRoot, asset, force);
  }

  for (const asset of stateAssets) {
    await copyAsset(repoRoot, asset, force);
  }

  for (const asset of promptAssets) {
    await copyAsset(repoRoot, asset, force);
  }
};

export const getPromptTemplatePath = (repoRoot: string, mode: string): string => {
  return path.join(marioPromptsDir(repoRoot), `PROMPT_${mode}.md`);
};

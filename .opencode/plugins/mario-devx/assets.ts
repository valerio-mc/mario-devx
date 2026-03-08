import path from "path";
import { ensureDir, fileExists, readText, writeText } from "./fs";
import { assetsDir, marioRoot, marioStateDir, resolvePathInside } from "./paths";

type AssetCopy = {
  source: string;
  destination: string;
};

const templateAssets: AssetCopy[] = [
  { source: "templates/prd.json", destination: "prd.json" },
  { source: "templates/AGENTS.md", destination: "AGENTS.md" },
];

const PROMPT_TEMPLATE_BY_MODE = {
  run_build: "prompts/PROMPT_run_build.md",
  verify_llm: "prompts/PROMPT_verify_llm.md",
} as const;

export type PromptTemplateMode = keyof typeof PROMPT_TEMPLATE_BY_MODE;


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
  if (!Object.prototype.hasOwnProperty.call(PROMPT_TEMPLATE_BY_MODE, mode)) {
    throw new Error(`Unsupported prompt template mode: ${mode}`);
  }
  const selected = PROMPT_TEMPLATE_BY_MODE[mode as PromptTemplateMode];
  return resolvePathInside(assetsDir(), selected);
};

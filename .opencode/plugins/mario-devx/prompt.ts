import path from "path";
import { readText, readTextIfExists } from "./fs";
import { getPromptTemplatePath } from "./assets";
import { assetsDir } from "./paths";

export const buildPrompt = async (
  repoRoot: string,
  mode: "build" | "verify",
  extra?: string,
): Promise<string> => {
  const templatePath = mode === "verify" ? getPromptTemplatePath("verify_llm") : getPromptTemplatePath("run_build");
  const template = await readText(templatePath);
  const uiVerifierPath = path.join(assetsDir(), "prompts", "UI_VERIFIER.md");
  const uiVerifier = mode === "verify" ? await readTextIfExists(uiVerifierPath) : null;

  const header = [
    "# mario-devx",
    "",
    `Mode: ${mode}`,
    `Repo: ${repoRoot}`,
    "",
    "Canonical files (use these paths):",
    "- PRD + tasks: .mario/prd.json",
    "- Agent config: .mario/AGENTS.md",
    "- State: .mario/state/state.json",
    "- Task evidence: .mario/prd.json (tasks[].lastAttempt)",
    "",
  ];

  if (extra) {
    header.push(extra, "");
  }

  const sections = [`${header.join("\n")}\n---\n\n${template}`];
  if (mode === "verify" && uiVerifier && uiVerifier.trim().length > 0) {
    sections.push(`\n---\n\n${uiVerifier.trim()}\n`);
  }
  return sections.join("\n");
};

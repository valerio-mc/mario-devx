import { readText } from "./fs";
import { getPromptTemplatePath } from "./assets";

export const buildPrompt = async (
  repoRoot: string,
  mode: "build" | "verify",
  extra?: string,
): Promise<string> => {
  const templatePath = mode === "verify" ? getPromptTemplatePath("verify_llm") : getPromptTemplatePath("run_build");
  const template = await readText(templatePath);

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
    "- Latest verdict: .mario/runs/<latest>/judge.out (see state.json for runDir)",
    "",
  ];

  if (extra) {
    header.push(extra, "");
  }

  return `${header.join("\n")}\n---\n\n${template}`;
};

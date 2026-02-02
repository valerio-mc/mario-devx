import { readText } from "./fs";
import { getPromptTemplatePath } from "./assets";

export const buildPrompt = async (
  repoRoot: string,
  mode: "prd" | "plan" | "build" | "verify",
  extra?: string,
): Promise<string> => {
  const templatePath =
    mode === "verify"
      ? getPromptTemplatePath("verify_llm")
      : mode === "build"
        ? getPromptTemplatePath("run_build")
        : getPromptTemplatePath(mode);
  const template = await readText(templatePath);

  const header = [
    "# mario-devx",
    "",
    `Mode: ${mode}`,
    `Repo: ${repoRoot}`,
    "",
    "Canonical files (use these paths):",
    "- PRD: .mario/PRD.md",
    "- Plan: .mario/IMPLEMENTATION_PLAN.md",
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

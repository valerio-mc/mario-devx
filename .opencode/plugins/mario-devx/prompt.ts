import { readText } from "./fs";
import { getPromptTemplatePath } from "./assets";

export const buildPrompt = async (
  repoRoot: string,
  mode: "prd" | "plan" | "build" | "verify",
  extra?: string,
): Promise<string> => {
  const templatePath =
    mode === "verify"
      ? getPromptTemplatePath(repoRoot, "verify_llm")
      : getPromptTemplatePath(repoRoot, mode);
  const template = await readText(templatePath);

  const header = [
    "# mario-devx",
    "",
    `Mode: ${mode}`,
    `Repo: ${repoRoot}`,
    "",
    "Canonical files (use these paths):",
    "- PRD: .mario/PRD.md",
    "- Specs: .mario/specs/*",
    "- Plan: .mario/IMPLEMENTATION_PLAN.md",
    "- Agent config: .mario/AGENTS.md",
    "- Feedback (read first): .mario/state/feedback.md",
    "- Progress log: .mario/progress.md",
    "- Guardrails: .mario/guardrails.md",
    "- Activity log: .mario/activity.log",
    "- Errors log: .mario/errors.log",
    "",
  ];

  if (extra) {
    header.push(extra, "");
  }

  return `${header.join("\n")}\n---\n\n${template}`;
};

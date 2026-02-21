import type { PrdJson } from "./prd";

export const buildTaskGenerationPrompt = (prd: PrdJson): string => {
  return [
    "You are mario-devx's task planner.",
    "Generate an optimal task breakdown from this PRD.",
    "",
    "PRD:",
    JSON.stringify(prd, null, 2),
    "",
    "Instructions:",
    "1. Analyze the PRD to understand project type, platform, and requirements",
    "2. Generate 5-15 implementation tasks",
    "3. Include foundation tasks (scaffold, quality setup) if needed",
    "4. Break must-have features into implementable tasks",
    "5. Set appropriate dependencies between tasks",
    "6. Tasks should be independently verifiable",
    "7. Each task should represent one focused slice that is quick to verify",
    "",
    "Granularity and quality rules:",
    "- Prefer small tasks: one behavior or one vertical slice per task.",
    "- Keep dependency graph acyclic and minimal.",
    "- doneWhen must be deterministic commands (no placeholders like 'run tests').",
    "- acceptance must be observable outcomes, not implementation steps.",
    "- Avoid dumping all features into one task.",
    "",
    "Good vs bad decomposition examples:",
    "- Good: 'Add auth route guards for dashboard pages'",
    "- Good: 'Implement CSV export button with file download behavior'",
    "- Bad: 'Build the whole app'",
    "- Bad: 'Improve UI and fix bugs'",
    "",
    "Task schema:",
    '{"id": "T-XXXX", "title": "string", "doneWhen": ["commands"], "labels": ["scaffold"|"quality"|"docs"|"feature"], "acceptance": ["criteria"], "dependsOn": ["T-XXXX"], "notes": ["strings"]}',
    "",
    "Return format:",
    "<TASK_JSON>",
    '{"tasks": [...]}',
    "</TASK_JSON>",
  ].join("\n");
};

export const buildInterviewPrompt = (prd: PrdJson, input: string, transcriptLines: string[]): string => {
  return [
    "You are mario-devx's PRD interviewer.",
    "Ask ONE focused question at a time. Do NOT output JSON.",
    "",
    "Current PRD state:",
    JSON.stringify(prd, null, 2),
    "",
    "Interview transcript so far:",
    transcriptLines.length > 0 ? transcriptLines.join("\n") : "(empty)",
    "",
    "Latest user input:",
    input,
    "",
    "Required fields before completion:",
    "- idea",
    "- platform",
    "- frontend",
    "- uiVerificationRequired if frontend=true",
    "- ui.designSystem/ui.visualDirection/ui.uxRequirements if frontend=true",
    "- ui.styleReferences prompt acknowledged if frontend=true",
    "- docs.readmeRequired/docs.readmeSections",
    "- language/framework",
    "- targetUsers/userProblems",
    "- mustHaveFeatures (>=3)",
    "- nonGoals/successMetrics/constraints",
    "- qualityGates (>=2 commands)",
    "",
    "Interview strategy:",
    "- Ask the single highest-leverage missing question first.",
    "- Prefer concrete, answerable prompts over broad questions.",
    "- Do not repeat a prior question unless the answer was ambiguous.",
    "- For frontend projects, force concrete visual direction and UX constraints.",
    "",
    "Good question examples:",
    "- Which framework and runtime should we target first (for example Next.js 16 on Node 22)?",
    "- List 3 must-have features as short verb phrases (for example sign in, dashboard, export csv).",
    "Bad question examples:",
    "- Tell me more.",
    "- What else should we build?",
    "",
    "Output rules (strict):",
    "- Return EXACTLY one line.",
    "- If more information is needed, return ONLY a question ending with '?'.",
    "- If all required fields are complete, return ONLY: DONE",
    "- No explanations, no markdown, no prefixes.",
  ].join("\n");
};

export const buildInterviewTurnRepairPrompt = (invalidResponse: string): string => {
  return [
    "Your previous response violated the required output format.",
    "Re-output in exactly one line.",
    "Allowed outputs:",
    "- A single question ending with '?'",
    "- DONE (if interview is complete)",
    "Do not include any other text.",
    "Previous invalid response:",
    invalidResponse,
  ].join("\n");
};

export const buildRepeatedQuestionRepairPrompt = (previousQuestion: string, latestAnswer: string): string => {
  return [
    "You repeated the same interview question.",
    "Ask a DIFFERENT next question based on the latest answer.",
    "Return exactly one line ending with '?', or DONE.",
    "Previous question:",
    previousQuestion,
    "Latest user answer:",
    latestAnswer,
  ].join("\n");
};

export const buildQualityGatePresetPrompt = (prd: PrdJson): string => {
  return [
    "You are mario-devx's quality gate assistant.",
    "Generate exactly 3 candidate deterministic quality-gate presets for this project.",
    "Prefer commands that are realistic for the provided language/framework and likely to pass once implementation is complete.",
    "Each preset should include 2-4 commands.",
    "Return ONLY JSON with this shape:",
    '{"question":"...","options":[{"label":"...","commands":["..."]},{"label":"...","commands":["..."]},{"label":"...","commands":["..."]}]}',
    "No markdown. No prose.",
    "PRD context:",
    JSON.stringify({
      idea: prd.idea,
      platform: prd.platform,
      frontend: prd.frontend,
      language: prd.language,
      framework: prd.framework,
      qualityGates: prd.qualityGates,
    }, null, 2),
  ].join("\n");
};

export const buildQualityGatePresetRepairPrompt = (invalidResponse: string): string => {
  return [
    "Your previous quality-gate preset response was invalid.",
    "Return ONLY valid JSON with this exact shape:",
    '{"question":"...","options":[{"label":"...","commands":["..."]},{"label":"...","commands":["..."]},{"label":"...","commands":["..."]}]}',
    "Rules:",
    "- exactly 3 options",
    "- each option must have 2-4 deterministic commands",
    "- no markdown, no prose",
    "Previous invalid response:",
    invalidResponse,
  ].join("\n");
};

export const buildCompileInterviewPrompt = (prd: PrdJson, transcriptLines: string[]): string => {
  return [
    "You are mario-devx's PRD compiler.",
    "Convert the interview transcript into PRD updates.",
    "",
    "Current PRD state:",
    JSON.stringify(prd, null, 2),
    "",
    "Interview transcript:",
    transcriptLines.length > 0 ? transcriptLines.join("\n") : "(empty)",
    "",
    "Return ONLY one JSON object with this shape:",
    '{"updates": { ... }, "next_question": "string"}',
    "Rules:",
    "- updates contains extracted/normalized field values",
    "- next_question is required if required fields remain missing",
    "- prefer specific normalized updates over vague summaries",
    "- if frontend=true, enforce concrete ui.visualDirection and at least one ui.uxRequirements item",
    "- if quality gates are missing, propose deterministic commands aligned with language/framework",
    "",
    "Few-shot examples:",
    "Input answer: 'Next.js app, users need login and dashboard, tests with npm test and npm run lint'",
    "Output shape hint: {'updates': {'framework':'Next.js','frontend':true,'product':{'mustHaveFeatures':['login','dashboard']},'qualityGates':['npm test','npm run lint']}, 'next_question':'What visual direction should the UI follow?'}",
    "Input answer: 'No frontend, this is a CLI in Go'",
    "Output shape hint: {'updates': {'platform':'cli','frontend':false,'language':'go'}, 'next_question':'List 3 must-have CLI commands and their expected outputs.'}",
    "- no markdown, no prose, JSON only",
  ].join("\n");
};

export const buildCompileRepairPrompt = (invalidResponse: string): string => {
  return [
    "Your previous compile response was invalid.",
    "Return ONLY valid JSON with shape:",
    '{"updates": { ... }, "next_question": "string"}',
    "No markdown and no extra text.",
    "Previous invalid response:",
    invalidResponse,
  ].join("\n");
};

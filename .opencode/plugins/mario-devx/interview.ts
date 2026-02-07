import { type PrdJson } from "./prd";

export const WIZARD_TOTAL_STEPS = 17;
export const LAST_QUESTION_KEY = "__last_question";
export const MIN_FEATURES = 3;
export const MIN_QUALITY_GATES = 2;

export const hasNonEmpty = (value: string | null | undefined): boolean => typeof value === "string" && value.trim().length > 0;

export const normalizeTextArray = (value: string[] | undefined): string[] => {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean)))
    : [];
};

export const normalizeStyleReferences = (value: string[] | undefined): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const refs = value
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0)
    .filter((item) => /^https?:\/\//i.test(item) || /\.(png|jpe?g|webp|gif|svg)$/i.test(item) || item.includes("/"));
  return Array.from(new Set(refs));
};

export const mergeStyleReferences = (current: string[] | undefined, incoming: string[] | undefined): string[] => {
  return normalizeStyleReferences([...(current ?? []), ...(incoming ?? [])]);
};

export const extractStyleReferencesFromText = (input: string): string[] => {
  const text = input.trim();
  if (!text) return [];
  const refs: string[] = [];

  const urlMatches = text.match(/https?:\/\/[^\s,)\]]+/gi) ?? [];
  refs.push(...urlMatches.map((u) => u.replace(/[.,;:!?]+$/, "")));

  const pathMatches = text.match(/(?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp|gif|svg)/gi) ?? [];
  refs.push(...pathMatches.map((p) => p.replace(/[.,;:!?]+$/, "")));

  return normalizeStyleReferences(refs);
};

export const stripTrailingSentencePunctuation = (value: string): string => value.replace(/[.?!]+$/g, "").trim();

export const hasMeaningfulList = (value: string[] | undefined, min = 1): boolean => normalizeTextArray(value).length >= min;

export const sameQuestion = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) {
    return false;
  }
  return a.trim().toLowerCase() === b.trim().toLowerCase();
};

export const isPrdComplete = (prd: PrdJson): boolean => {
  return (
    hasNonEmpty(prd.idea)
    && prd.platform !== null
    && typeof prd.frontend === "boolean"
    && (prd.frontend === false || typeof prd.uiVerificationRequired === "boolean")
    && (prd.frontend === false || prd.ui.designSystem !== null)
    && (prd.frontend === false || hasNonEmpty(prd.ui.visualDirection))
    && (prd.frontend === false || hasMeaningfulList(prd.ui.uxRequirements))
    && prd.language !== null
    && hasNonEmpty(prd.framework)
    && hasMeaningfulList(prd.product.targetUsers)
    && hasMeaningfulList(prd.product.userProblems)
    && hasMeaningfulList(prd.product.mustHaveFeatures, MIN_FEATURES)
    && hasMeaningfulList(prd.product.nonGoals)
    && hasMeaningfulList(prd.product.successMetrics)
    && hasMeaningfulList(prd.product.constraints)
    && typeof prd.docs.readmeRequired === "boolean"
    && (prd.docs.readmeRequired === false || hasMeaningfulList(prd.docs.readmeSections))
    && hasMeaningfulList(prd.qualityGates, MIN_QUALITY_GATES)
  );
};

export const deriveWizardStep = (prd: PrdJson): number => {
  // Simple binary: 0 = not started, 17 = complete, or let LLM decide
  if (isPrdComplete(prd)) return WIZARD_TOTAL_STEPS;
  return 0;
};

export const compactIdea = (input: string): string => {
  return input
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
};

export const escapeDoubleQuoted = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");

// Simple helpers for basic validation (not deterministic parsing)
export const isLikelyBooleanReply = (input: string): boolean => {
  const s = input.trim().toLowerCase();
  return ["y", "yes", "true", "1", "n", "no", "false", "0"].includes(s);
};

export const looksLikeUiChoiceArtifact = (input: string): boolean => {
  const s = input.trim();
  if (!s) {
    return false;
  }
  if (/^answer in my own words/i.test(s)) {
    return true;
  }
  return /(single-choice|multi-choice|free-text|show current status|stop for now|hardcoded|fixed questions|generate 3 questions)/i.test(s);
};

export const looksTooBroadQuestion = (question: string): boolean => {
  const q = question.trim();
  if (!q) {
    return true;
  }
  const wordCount = q.split(/\s+/).filter(Boolean).length;
  const clauseSignals = (q.match(/,| and | or |;/gi) ?? []).length;
  const hasListCue = /(include|cover|describe.*(flow|end-to-end)|what.*and.*what|first.*then)/i.test(q);
  return wordCount > 30 || clauseSignals >= 4 || hasListCue;
};

export const sameQuestion = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) {
    return false;
  }
  return a.trim().toLowerCase() === b.trim().toLowerCase();
};

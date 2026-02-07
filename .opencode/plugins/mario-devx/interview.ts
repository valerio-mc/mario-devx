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

export const isAtomicFeatureStatement = (value: string): boolean => {
  const feature = stripTrailingSentencePunctuation(value)
    .replace(/^user\s+/i, "")
    .trim();
  if (!feature) return false;
  if (/^(and|or|then)\b/i.test(feature)) return false;
  if (/^(active|completed|overdue|todo|done|high|low|med)$/i.test(feature)) return false;
  const wordCount = feature.split(/\s+/).filter(Boolean).length;
  const hasActionVerb = /(create|edit|update|delete|mark|toggle|set|clear|filter|search|sort|persist|store|restore|show|hide|add|remove|snooze|schedule|confirm|open|close|validate|support|allow|enable|disable|track|view|answer|enter|generate|copy|pick|choose|select|share|save|submit|regenerate|import|export|upload|download|start|finish)\b/i.test(feature);
  if (wordCount < 2) return false;
  if (wordCount === 2 && !hasActionVerb) return false;
  return hasActionVerb;
};

export const hasAtomicFeatures = (value: string[] | undefined, min = MIN_FEATURES): boolean => {
  const normalized = normalizeTextArray(value).map(stripTrailingSentencePunctuation).filter(Boolean);
  return normalized.length >= min && normalized.every(isAtomicFeatureStatement);
};

export const isVagueFeatureRequest = (input: string): boolean => {
  const s = input.replace(/\s+/g, " ").trim();
  if (!s) return true;
  const wordCount = s.split(/\s+/).filter(Boolean).length;
  if (s.length < 24 || wordCount < 5) return true;
  if (/\b(something|stuff|etc\.?|misc|various)\b/i.test(s)) return true;
  if (/^(improve|enhance|polish|update|fix)\b/i.test(s) && wordCount < 8) return true;
  if (!/(add|create|edit|update|delete|remove|export|import|sync|filter|search|sort|toggle|enable|disable|support|integrate|refactor|optimi[sz]e|validate|track|render|show|hide)\b/i.test(s)) {
    return true;
  }
  return false;
};

export const hasMeaningfulList = (value: string[] | undefined, min = 1): boolean => normalizeTextArray(value).length >= min;

export const hasDiverseQualityGates = (gates: string[]): boolean => {
  const normalized = normalizeTextArray(gates);
  const hasTest = normalized.some((gate) => /(\btest\b|pytest|vitest|jest|playwright|cypress|go test|cargo test)/i.test(gate));
  const hasStatic = normalized.some((gate) => /(lint|typecheck|mypy|ruff|flake8|eslint|tsc|build|check|fmt --check)/i.test(gate));
  return hasTest && hasStatic;
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

export const isLikelyBooleanReply = (input: string): boolean => {
  const s = input.trim().toLowerCase();
  return ["y", "yes", "true", "1", "n", "no", "false", "0"].includes(s);
};

export const parseBooleanReply = (input: string): boolean | null => {
  const s = input.trim().toLowerCase();
  if (["y", "yes", "true", "1"].includes(s)) return true;
  if (["n", "no", "false", "0"].includes(s)) return false;
  return null;
};

export const inferPlatformFromText = (input: string): "web" | "api" | "cli" | "library" | null => {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/\b(web\s*app|website|frontend|browser)\b/.test(s)) return "web";
  if (/\b(api|rest|graphql|backend|server)\b/.test(s)) return "api";
  if (/\b(cli|command\s*line|terminal\s*tool)\b/.test(s)) return "cli";
  if (/\b(library|sdk|package|module)\b/.test(s)) return "library";
  return null;
};

export const parseFeatureListReply = (input: string): string[] => {
  const normalized = input
    .replace(/\r\n?/g, "\n")
    .replace(/\\n/g, "\n")
    .trim();
  if (!normalized) {
    return [];
  }

  const clean = (item: string): string => item
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
    .replace(/^user\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const uniq = (items: string[]): string[] => Array.from(new Set(items));
  const asAtomicIfEnough = (items: string[]): string[] | null => {
    const normalizedItems = items.map(clean).map(stripTrailingSentencePunctuation).filter(Boolean);
    const atomic = uniq(normalizedItems.filter(isAtomicFeatureStatement));
    return atomic.length >= MIN_FEATURES ? atomic : null;
  };

  const inlineNumbered = normalized.match(/\d+[.)]\s+/g);
  if (inlineNumbered && inlineNumbered.length >= MIN_FEATURES) {
    const marked = normalized.replace(/(?:^|\s)(\d+[.)])\s+/g, "\n$1 ").trim();
    const items = marked.split(/\n+/);
    const atomic = asAtomicIfEnough(items);
    if (atomic) {
      return atomic;
    }
  }

  const lines = normalized.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const plainLineItems = asAtomicIfEnough(lines);
  if (plainLineItems) {
    return plainLineItems;
  }

  const bulletLines = lines.filter((line) => /^(?:[-*•]|\d+[.)])\s+/.test(line));
  if (bulletLines.length >= MIN_FEATURES) {
    const atomic = asAtomicIfEnough(bulletLines);
    if (atomic) {
      return atomic;
    }
  }

  const sentenceItems = asAtomicIfEnough(normalized
    .split(/(?<=[.?!])\s+(?=[A-Z])/)
  );
  if (sentenceItems) {
    return sentenceItems;
  }

  const semicolonParts = asAtomicIfEnough(normalized.split(/\s*;\s*/));
  if (semicolonParts) {
    return semicolonParts;
  }

  const commaParts = asAtomicIfEnough(normalized.split(","));
  if (commaParts) {
    return commaParts;
  }

  const pipeParts = asAtomicIfEnough(normalized.split(/\s*\|\s*/));
  if (pipeParts) {
    return pipeParts;
  }

  if (!/[.?!,;]/.test(normalized)) {
    const andParts = asAtomicIfEnough(normalized.split(/\s+and\s+/i));
    if (andParts) {
      return andParts;
    }
  }

  const fallback = uniq(
    normalized
      .split(/[\n,;|]+/)
      .map(clean)
      .map(stripTrailingSentencePunctuation)
      .filter(Boolean)
      .filter(isAtomicFeatureStatement),
  );
  if (fallback.length >= MIN_FEATURES) {
    return fallback;
  }

  return uniq([stripTrailingSentencePunctuation(clean(normalized))].filter(Boolean));
};

export const parseAtomicAcceptanceList = (input: string): string[] => {
  const parsed = parseFeatureListReply(input)
    .map(stripTrailingSentencePunctuation)
    .filter(Boolean)
    .filter(isAtomicFeatureStatement);
  return Array.from(new Set(parsed));
};

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
    && hasAtomicFeatures(prd.product.mustHaveFeatures, MIN_FEATURES)
    && hasMeaningfulList(prd.product.nonGoals)
    && hasMeaningfulList(prd.product.successMetrics)
    && hasMeaningfulList(prd.product.constraints)
    && typeof prd.docs.readmeRequired === "boolean"
    && (prd.docs.readmeRequired === false || hasMeaningfulList(prd.docs.readmeSections))
    && hasMeaningfulList(prd.qualityGates, MIN_QUALITY_GATES)
    && hasDiverseQualityGates(prd.qualityGates)
  );
};

export const deriveWizardStep = (prd: PrdJson): number => {
  let step = 0;
  if (hasNonEmpty(prd.idea)) step = 1;
  if (prd.platform !== null) step = 2;
  if (typeof prd.frontend === "boolean") step = 3;
  if (prd.frontend === false || typeof prd.uiVerificationRequired === "boolean") step = 4;
  if (prd.frontend === false || prd.ui.designSystem !== null) step = 5;
  if (prd.frontend === false || hasNonEmpty(prd.ui.visualDirection)) step = 6;
  if (prd.frontend === false || hasMeaningfulList(prd.ui.uxRequirements)) step = 7;
  if (typeof prd.docs.readmeRequired === "boolean") step = 8;
  if (prd.docs.readmeRequired === false || hasMeaningfulList(prd.docs.readmeSections)) step = 9;
  if (prd.language !== null) step = 10;
  if (hasNonEmpty(prd.framework)) step = 11;
  if (hasMeaningfulList(prd.product.targetUsers)) step = 12;
  if (hasMeaningfulList(prd.product.userProblems)) step = 13;
  if (hasAtomicFeatures(prd.product.mustHaveFeatures, MIN_FEATURES)) step = 14;
  if (hasMeaningfulList(prd.product.nonGoals)) step = 15;
  if (hasMeaningfulList(prd.product.successMetrics)) step = 16;
  if (hasMeaningfulList(prd.product.constraints) && hasMeaningfulList(prd.qualityGates, MIN_QUALITY_GATES) && hasDiverseQualityGates(prd.qualityGates)) step = 17;
  return Math.min(WIZARD_TOTAL_STEPS, step);
};

export const firstMissingField = (prd: PrdJson): string => {
  if (!hasNonEmpty(prd.idea)) return "idea";
  if (prd.platform === null) return "platform";
  if (typeof prd.frontend !== "boolean") return "frontend";
  if (prd.frontend === true && typeof prd.uiVerificationRequired !== "boolean") return "uiVerificationRequired";
  if (prd.frontend === true && prd.ui.designSystem === null) return "uiDesignSystem";
  if (prd.frontend === true && !hasNonEmpty(prd.ui.visualDirection)) return "uiVisualDirection";
  if (prd.frontend === true && !hasMeaningfulList(prd.ui.uxRequirements)) return "uiUxRequirements";
  if (typeof prd.docs.readmeRequired !== "boolean") return "docsReadmeRequired";
  if (prd.docs.readmeRequired === true && !hasMeaningfulList(prd.docs.readmeSections)) return "docsReadmeSections";
  if (prd.language === null) return "language";
  if (!hasNonEmpty(prd.framework)) return "framework";
  if (!hasMeaningfulList(prd.product.targetUsers)) return "targetUsers";
  if (!hasMeaningfulList(prd.product.userProblems)) return "userProblems";
  if (!hasAtomicFeatures(prd.product.mustHaveFeatures, MIN_FEATURES)) return "mustHaveFeatures";
  if (!hasMeaningfulList(prd.product.nonGoals)) return "nonGoals";
  if (!hasMeaningfulList(prd.product.successMetrics)) return "successMetrics";
  if (!hasMeaningfulList(prd.product.constraints)) return "constraints";
  if (!hasMeaningfulList(prd.qualityGates, MIN_QUALITY_GATES) || !hasDiverseQualityGates(prd.qualityGates)) return "qualityGates";
  return "done";
};

export const fallbackQuestion = (prd: PrdJson): string => {
  const missing = firstMissingField(prd);
  switch (missing) {
    case "idea":
      return "What one-line idea should this project build?";
    case "platform":
      return "What are we building: web app, API service, CLI tool, or library?";
    case "frontend":
      return "Does this project need a browser UI?";
    case "uiVerificationRequired":
      return "Should automated UI browser verification be required on every run? (yes/no)";
    case "uiDesignSystem":
      return "Which UI stack should we use: Tailwind, shadcn/ui, custom CSS, or none?";
    case "uiVisualDirection":
      return "Describe the visual direction in one line (mood, typography, color style).";
    case "uiUxRequirements":
      return "List key UX requirements (states, responsiveness, accessibility).";
    case "docsReadmeRequired":
      return "Should this project maintain a human-readable README.md throughout development? (yes/no)";
    case "docsReadmeSections":
      return "List required README sections (for example: Overview, Setup, Env Vars, Usage).";
    case "language":
      return "What is the primary language: TypeScript, Python, Go, Rust, or other?";
    case "framework":
      return "Which framework/runtime should be the default?";
    case "targetUsers":
      return "Who are the primary target users (list 2-4 user types)?";
    case "userProblems":
      return "What are the top 3 user problems this product must solve?";
    case "mustHaveFeatures":
      return `List at least ${MIN_FEATURES} atomic must-have features for V1 (one per line, action-first).`;
    case "nonGoals":
      return "What is explicitly out of scope for V1?";
    case "successMetrics":
      return "How will we measure success in MVP terms?";
    case "constraints":
      return "List hard constraints (time, budget, compliance, performance, dependencies).";
    case "qualityGates":
      return "Provide at least 2 runnable quality gates including both static checks and tests.";
    default:
      return "What single detail would most reduce implementation ambiguity right now?";
  }
};

export const compactIdea = (input: string): string => {
  return input
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
};

export const escapeDoubleQuoted = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");

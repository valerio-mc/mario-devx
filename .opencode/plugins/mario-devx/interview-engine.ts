import type { PrdJson } from "./prd";
import {
  MIN_FEATURES,
  hasNonEmpty,
  inferLanguageFromText,
  inferPlatformFromText,
  inferUiDesignSystemFromText,
  isAtomicFeatureStatement,
  parseBooleanReply,
  parseFeatureListReply,
  parseLooseListReply,
} from "./interview";

export type DeterministicInterviewResult = {
  handled: boolean;
  prd: PrdJson;
  error?: string;
};

export const applyDeterministicInterviewUpdate = (
  prd: PrdJson,
  missingField: string,
  rawInput: string,
): DeterministicInterviewResult => {
  const answer = rawInput.trim();
  if (!answer) {
    return { handled: false, prd };
  }

  switch (missingField) {
    case "platform": {
      const inferred = inferPlatformFromText(answer);
      if (!inferred) return { handled: false, prd };
      return {
        handled: true,
        prd: {
          ...prd,
          platform: inferred,
          frontend: typeof prd.frontend === "boolean" ? prd.frontend : inferred === "web",
        },
      };
    }

    case "frontend": {
      const boolReply = parseBooleanReply(answer);
      if (typeof boolReply !== "boolean") return { handled: false, prd };
      return { handled: true, prd: { ...prd, frontend: boolReply } };
    }

    case "uiVerificationRequired": {
      const boolReply = parseBooleanReply(answer);
      if (typeof boolReply !== "boolean") return { handled: false, prd };
      return {
        handled: true,
        prd: {
          ...prd,
          uiVerificationRequired: boolReply,
          verificationPolicy: {
            ...prd.verificationPolicy,
            uiPolicy: boolReply ? "required" : "best_effort",
          },
        },
      };
    }

    case "uiDesignSystem": {
      const inferred = inferUiDesignSystemFromText(answer);
      if (!inferred) return { handled: false, prd };
      return {
        handled: true,
        prd: {
          ...prd,
          ui: {
            ...prd.ui,
            designSystem: inferred,
          },
        },
      };
    }

    case "docsReadmeRequired": {
      const boolReply = parseBooleanReply(answer);
      if (typeof boolReply !== "boolean") return { handled: false, prd };
      return {
        handled: true,
        prd: {
          ...prd,
          docs: {
            ...prd.docs,
            readmeRequired: boolReply,
            readmeSections: boolReply ? prd.docs.readmeSections : [],
          },
        },
      };
    }

    case "language": {
      const inferred = inferLanguageFromText(answer);
      if (!inferred) return { handled: false, prd };
      return { handled: true, prd: { ...prd, language: inferred } };
    }

    case "framework":
      return hasNonEmpty(answer)
        ? { handled: true, prd: { ...prd, framework: answer } }
        : { handled: false, prd };

    case "uiVisualDirection":
      return hasNonEmpty(answer)
        ? { handled: true, prd: { ...prd, ui: { ...prd.ui, visualDirection: answer } } }
        : { handled: false, prd };

    case "uiUxRequirements": {
      const items = parseLooseListReply(answer);
      if (items.length === 0) return { handled: false, prd };
      return { handled: true, prd: { ...prd, ui: { ...prd.ui, uxRequirements: items } } };
    }

    case "docsReadmeSections": {
      const items = parseLooseListReply(answer);
      if (items.length === 0) return { handled: false, prd };
      return { handled: true, prd: { ...prd, docs: { ...prd.docs, readmeSections: items } } };
    }

    case "targetUsers": {
      const items = parseLooseListReply(answer);
      if (items.length === 0) return { handled: false, prd };
      return { handled: true, prd: { ...prd, product: { ...prd.product, targetUsers: items } } };
    }

    case "userProblems": {
      const items = parseLooseListReply(answer);
      if (items.length === 0) return { handled: false, prd };
      return { handled: true, prd: { ...prd, product: { ...prd.product, userProblems: items } } };
    }

    case "mustHaveFeatures": {
      const features = parseFeatureListReply(answer);
      if (features.length >= MIN_FEATURES && features.every(isAtomicFeatureStatement)) {
        return {
          handled: true,
          prd: {
            ...prd,
            product: {
              ...prd.product,
              mustHaveFeatures: features,
            },
          },
        };
      }
      return {
        handled: true,
        prd,
        error: `I captured ${features.length} feature(s). Please list at least ${MIN_FEATURES} atomic must-have features (one per line; each should start with a concrete action verb).`,
      };
    }

    case "nonGoals": {
      const items = parseLooseListReply(answer);
      if (items.length === 0) return { handled: false, prd };
      return { handled: true, prd: { ...prd, product: { ...prd.product, nonGoals: items } } };
    }

    case "successMetrics": {
      const items = parseLooseListReply(answer);
      if (items.length === 0) return { handled: false, prd };
      return { handled: true, prd: { ...prd, product: { ...prd.product, successMetrics: items } } };
    }

    case "constraints": {
      const items = parseLooseListReply(answer);
      if (items.length === 0) return { handled: false, prd };
      return { handled: true, prd: { ...prd, product: { ...prd.product, constraints: items } } };
    }

    case "qualityGates": {
      const items = parseLooseListReply(answer);
      if (items.length === 0) return { handled: false, prd };
      return {
        handled: true,
        prd: {
          ...prd,
          qualityGates: items,
          verificationPolicy: {
            ...prd.verificationPolicy,
            globalGates: items,
          },
        },
      };
    }

    default:
      return { handled: false, prd };
  }
};

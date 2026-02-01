const extractBackticked = (line: string): string | null => {
  const match = line.match(/`([^`]+)`/);
  if (!match) {
    return null;
  }
  const cmd = (match[1] ?? "").trim();
  if (!cmd || cmd.toLowerCase().includes("todo")) {
    return null;
  }
  return cmd;
};

const countMatches = (text: string, re: RegExp): number => {
  const matches = text.match(re);
  return matches ? matches.length : 0;
};

export const isPrdReadyForPlan = (prd: string): boolean => {
  if (!prd || prd.trim().length === 0) {
    return false;
  }

  const lines = prd.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "## Quality Gates");
  if (start === -1) {
    return false;
  }

  let hasGate = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      break;
    }
    if (!trimmed.startsWith("-")) {
      continue;
    }
    if (extractBackticked(trimmed)) {
      hasGate = true;
      break;
    }
  }

  const userStories = countMatches(prd, /^###\s+US-\d+/gim);
  const acceptanceHeadings = countMatches(prd, /acceptance criteria/gi);
  const acceptanceCheckboxes = countMatches(prd, /-\s+\[\s\]/g);

  const hasAcceptanceEvidence = acceptanceCheckboxes >= 3 || acceptanceHeadings >= 3;
  return hasGate && userStories >= 3 && hasAcceptanceEvidence;
};

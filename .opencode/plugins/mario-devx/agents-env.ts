export const parseEnvValue = (raw: string): string => {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
};

export const parseAgentsEnv = (content: string): { env: Record<string, string>; warnings: string[] } => {
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  const lines = content.split(/\r?\n/);
  const envKeyPattern = /^[A-Z][A-Z0-9_]*$/;
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("```")) {
      continue;
    }
    if (line.startsWith("export ")) {
      const rest = line.slice("export ".length).trim();
      const idx = rest.indexOf("=");
      if (idx === -1) {
        warnings.push(`Line ${i + 1}: ignored malformed export: ${line}`);
        continue;
      }
      const key = rest.slice(0, idx).trim();
      const value = rest.slice(idx + 1);
      if (!key) {
        warnings.push(`Line ${i + 1}: ignored export with empty key: ${line}`);
        continue;
      }
      env[key] = parseEnvValue(value);
      continue;
    }
    const idx = line.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (!envKeyPattern.test(key)) {
      continue;
    }
    env[key] = parseEnvValue(value);
  }
  return { env, warnings };
};

export const upsertAgentsKey = (content: string, key: string, value: string): string => {
  const quoted = `'${value.replace(/'/g, "'\\''")}'`;
  const lines = content.split(/\r?\n/);
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  let replaced = false;
  const out = lines.map((line) => {
    if (re.test(line)) {
      replaced = true;
      return `${key}=${quoted}`;
    }
    return line;
  });
  const nextLine = `${key}=${quoted}`;
  if (replaced) {
    return `${out.join("\n").trimEnd()}\n`;
  }
  return `${content.trimEnd()}\n${nextLine}\n`;
};

export const hasAgentsKey = (content: string, key: string): boolean => {
  const pattern = new RegExp(`^\\s*${key}=`, "m");
  return pattern.test(content);
};

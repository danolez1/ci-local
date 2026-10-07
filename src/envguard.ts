// Firebase web keys (AIza...) are shipped to every browser by design, so they are deliberately not matched.
const SECRET_VALUE = /sk_live_|rk_live_|sk-[A-Za-z0-9]{20,}|whsec_|FLWSECK|-----BEGIN|ghp_|gho_|github_pat_|xox[bpas]-|AKIA[0-9A-Z]{16}/;
// A JWT is refused unless the key is named in public_jwt_keys: anon and publishable keys are JWTs that ship to every browser.
const JWT_VALUE = /eyJ[A-Za-z0-9_-]{10,}\./;

export function parseEnvLines(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2") });
  }
  return out;
}

// Whoever can pull an image can read what is baked into it, so only browser-facing values may go in.
export function guardBuildEnv(text: string, prefixes: string[], label: string, jwtKeys: readonly string[] = []): string[] {
  const problems: string[] = [];
  for (const { key, value } of parseEnvLines(text)) {
    if (!prefixes.some((p) => key.startsWith(p))) problems.push(`${label}: '${key}' does not start with a public prefix (${prefixes.join(", ")})`);
    if (SECRET_VALUE.test(value) || (JWT_VALUE.test(value) && !jwtKeys.includes(key))) problems.push(`${label}: the value of '${key}' looks like a secret`);
  }
  return problems;
}

const SECRET_LIKE =
  /(sk-[A-Za-z0-9_-]{8,})|(Bearer\s+\S+)|(api[_-]?key["'\s:=]+)[^\s"',}]+/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

const BLOCKED_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api_key",
  "apikey",
  "token",
  "secret",
  "password",
  "content",
  "text",
  "thinking",
  "input",
  "args",
  "result",
  "prompt",
  "system",
  "messages",
  "email",
  "useremail",
  "identity",
  "user",
  "account",
  "spending",
]);

export function redactSecrets(text: string, canaries: string[] = []): string {
  let out = text.replace(URL_CREDENTIALS, "$1[redacted]@").replace(SECRET_LIKE, "[redacted]");
  const home = typeof process !== "undefined" ? process.env.HOME : undefined;
  if (home && home.length > 1) out = out.split(home).join("[home]");
  const user = typeof process !== "undefined" ? process.env.USER || process.env.LOGNAME : undefined;
  if (user && user.length > 1) {
    out = out.replaceAll(`/${user}/`, "/[user]/");
    out = out.replaceAll(`\\${user}\\`, "\\[user]\\");
  }
  for (const canary of canaries) {
    if (canary && canary.length >= 4 && out.includes(canary)) {
      out = out.split(canary).join("[redacted]");
    }
  }
  return out;
}

export function redactValue(value: unknown, canaries: string[] = []): unknown {
  if (typeof value === "string") return redactSecrets(value, canaries);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, canaries));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (BLOCKED_KEYS.has(key.toLowerCase())) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = redactValue(nested, canaries);
    }
    return out;
  }
  return value;
}

export function receiptContainsCanary(serialized: string, canaries: string[]): boolean {
  return canaries.some((canary) => Boolean(canary) && canary.length >= 4 && serialized.includes(canary));
}

export function assertNoCanary(serialized: string, canaries: string[]): void {
  if (receiptContainsCanary(serialized, canaries)) {
    throw new Error("refusing to emit receipt: secret canary present");
  }
}

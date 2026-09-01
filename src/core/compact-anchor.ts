import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Clock } from "../clock.js";
import { digestJson, stableStringify } from "../digest.js";
import { GatewayError, invalidRequest, sessionConflict } from "../errors.js";
import { ensurePrivateDir } from "./lineage-store.js";
import type { RuntimeProfile } from "./runtime-profile.js";
import { boundRuntimeProfile } from "./runtime-profile.js";
import type { ParsedMessages } from "../protocols/anthropic/types.js";
import { sessionPolicyFingerprintFromParsed } from "./session-policy.js";

/** Gateway-local compact token namespace. Never mint `v3.` tokens. */
export const COMPACT_TOKEN_PREFIX = "csgw1.";
export const COMPACT_HMAC_KEY_BYTES = 32;
export const COMPACT_TTL_SECONDS = 7 * 24 * 60 * 60;

const COMPACT_ID_RE = /^cmp_[A-Za-z0-9._-]+$/;
const PAYLOAD_KEYS = ["account", "compactId", "exp", "model", "policyDigest", "profile", "v"] as const;

export interface CompactAnchorPayload {
  v: 1;
  account: string;
  profile: RuntimeProfile;
  policyDigest: string;
  model: string;
  compactId: string;
  exp: number;
}

export interface CompactRecord {
  compactId: string;
  transcriptDigest: string;
  account: string;
  profile: RuntimeProfile;
  policyDigest: string;
  model: string;
  sessionId?: string;
  createdAt: number;
  exp: number;
}

export interface CompactBinding {
  account: string;
  profile: RuntimeProfile;
  policyDigest: string;
  model: string;
  transcriptDigest: string;
  sessionId?: string;
}

export function compactPolicyDigest(parsed: ParsedMessages, profile: RuntimeProfile): string {
  return sessionPolicyFingerprintFromParsed(parsed, parsed.modelParams, profile);
}

export function compactTranscriptDigest(input: {
  model: string;
  systemText: string;
  messages: ParsedMessages["messages"];
  tools: ParsedMessages["tools"];
}): string {
  return digestJson({
    model: input.model,
    systemText: input.systemText,
    messages: input.messages,
    tools: input.tools,
  });
}

export class CompactAnchorStore {
  readonly dir: string;
  private readonly keyPath: string;
  private secret?: Buffer;

  constructor(
    stateDir: string,
    private readonly clock: Clock,
  ) {
    ensurePrivateDir(stateDir);
    this.dir = join(stateDir, "compacts");
    this.keyPath = join(stateDir, "compact-hmac.key");
    ensurePrivateDir(this.dir);
  }

  mint(binding: CompactBinding): { token: string; record: CompactRecord } {
    const compactId = `cmp_${randomUUID()}`;
    const now = this.clock.now();
    const exp = Math.floor(now / 1000) + COMPACT_TTL_SECONDS;
    const profile = boundRuntimeProfile(binding.profile);
    const payload: CompactAnchorPayload = {
      v: 1,
      account: binding.account,
      profile,
      policyDigest: binding.policyDigest,
      model: binding.model,
      compactId,
      exp,
    };
    const token = this.sign(payload);
    const record: CompactRecord = {
      compactId,
      transcriptDigest: binding.transcriptDigest,
      account: binding.account,
      profile,
      policyDigest: binding.policyDigest,
      model: binding.model,
      ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
      createdAt: now,
      exp,
    };
    this.writeRecord(record);
    return { token, record };
  }

  verify(token: string, expected: Omit<CompactBinding, "transcriptDigest" | "sessionId">): CompactRecord {
    const payload = this.decode(token);
    if (payload.exp <= Math.floor(this.clock.now() / 1000)) {
      throw sessionConflict("This compact context has expired.");
    }
    if (payload.account !== expected.account) {
      throw sessionConflict("This compact context belongs to a different account.");
    }
    if (payload.profile !== boundRuntimeProfile(expected.profile)) {
      throw sessionConflict("This compact context does not match the current runtime profile.");
    }
    if (payload.model !== expected.model || payload.policyDigest !== expected.policyDigest) {
      throw sessionConflict("This compact context does not match the current model or tools.");
    }
    const record = this.readRecord(payload.compactId);
    if (!record) {
      throw sessionConflict("This compact context is no longer available.");
    }
    if (
      record.account !== payload.account ||
      record.profile !== payload.profile ||
      record.policyDigest !== payload.policyDigest ||
      record.model !== payload.model ||
      record.exp !== payload.exp
    ) {
      throw sessionConflict("This compact context is no longer available.");
    }
    return record;
  }

  sweep(): void {
    const nowSeconds = Math.floor(this.clock.now() / 1000);
    for (const name of this.recordFiles()) {
      const record = this.readFile(join(this.dir, name));
      if (!record || record.exp <= nowSeconds) {
        try {
          unlinkSync(join(this.dir, name));
        } catch {
          // ignore
        }
      }
    }
  }

  private sign(payload: CompactAnchorPayload): string {
    const canonical = stableStringify(payload);
    const mac = createHmac("sha256", this.loadSecret()).update(canonical).digest();
    return `${COMPACT_TOKEN_PREFIX}${Buffer.from(canonical, "utf8").toString("base64url")}.${mac.toString("base64url")}`;
  }

  private decode(token: string): CompactAnchorPayload {
    const trimmed = token.trim();
    if (!trimmed.startsWith(COMPACT_TOKEN_PREFIX) || trimmed.startsWith("v3.")) {
      throw invalidCompactToken();
    }
    const rest = trimmed.slice(COMPACT_TOKEN_PREFIX.length);
    const dot = rest.lastIndexOf(".");
    if (dot <= 0 || dot === rest.length - 1) throw invalidCompactToken();
    const payloadB64 = rest.slice(0, dot);
    const macB64 = rest.slice(dot + 1);
    let canonical: string;
    let presentedMac: Buffer;
    try {
      canonical = Buffer.from(payloadB64, "base64url").toString("utf8");
      presentedMac = Buffer.from(macB64, "base64url");
    } catch {
      throw invalidCompactToken();
    }
    const expectedMac = createHmac("sha256", this.loadSecret()).update(canonical).digest();
    if (presentedMac.length !== expectedMac.length || !timingSafeEqual(presentedMac, expectedMac)) {
      throw invalidCompactToken();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(canonical) as unknown;
    } catch {
      throw invalidCompactToken();
    }
    return requirePayload(parsed);
  }

  private loadSecret(): Buffer {
    if (this.secret) return this.secret;
    if (existsSync(this.keyPath)) {
      const loaded = readFileSync(this.keyPath);
      if (loaded.length !== COMPACT_HMAC_KEY_BYTES) {
        throw new GatewayError("cursor_upstream_error", "Gateway compact state is unavailable", 500);
      }
      this.secret = loaded;
      return loaded;
    }
    const secret = randomBytes(COMPACT_HMAC_KEY_BYTES);
    try {
      writeFileSync(this.keyPath, secret, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const loaded = readFileSync(this.keyPath);
        if (loaded.length !== COMPACT_HMAC_KEY_BYTES) {
          throw new GatewayError("cursor_upstream_error", "Gateway compact state is unavailable", 500);
        }
        this.secret = loaded;
        return loaded;
      }
      throw error;
    }
    try {
      chmodSync(this.keyPath, 0o600);
    } catch {
      // best-effort on filesystems that ignore mode
    }
    this.secret = secret;
    return secret;
  }

  private writeRecord(record: CompactRecord): void {
    if (!COMPACT_ID_RE.test(record.compactId)) {
      throw new GatewayError("cursor_upstream_error", "Gateway compact state is unavailable", 500);
    }
    const path = join(this.dir, `${record.compactId}.json`);
    const tmp = `${path}.${process.pid}.${this.clock.now()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, path);
      try {
        chmodSync(path, 0o600);
      } catch {
        // best-effort
      }
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // leftover tmp must not crash the process
      }
      throw error;
    }
  }

  private readRecord(compactId: string): CompactRecord | undefined {
    if (!COMPACT_ID_RE.test(compactId)) return undefined;
    return this.readFile(join(this.dir, `${compactId}.json`));
  }

  private readFile(path: string): CompactRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isCompactRecord(parsed)) throw new Error("invalid compact record");
      return parsed;
    } catch {
      try {
        renameSync(path, `${path}.corrupt.${this.clock.now()}`);
      } catch {
        try {
          unlinkSync(path);
        } catch {
          // leave in place rather than crash
        }
      }
      return undefined;
    }
  }

  private recordFiles(): string[] {
    try {
      return readdirSync(this.dir).filter((name) => name.endsWith(".json") && !name.includes(".corrupt"));
    } catch {
      return [];
    }
  }
}

function invalidCompactToken(): GatewayError {
  return invalidRequest("This compact context must be a valid continuation token issued by this gateway.");
}

function requirePayload(value: unknown): CompactAnchorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidCompactToken();
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  if (keys.length !== PAYLOAD_KEYS.length || keys.some((key, index) => key !== PAYLOAD_KEYS[index])) {
    throw invalidCompactToken();
  }
  if (raw.v !== 1) throw invalidCompactToken();
  if (typeof raw.account !== "string" || !raw.account) throw invalidCompactToken();
  if (raw.profile !== "sdk" && raw.profile !== "sand") throw invalidCompactToken();
  if (typeof raw.policyDigest !== "string" || !raw.policyDigest) throw invalidCompactToken();
  if (typeof raw.model !== "string" || !raw.model) throw invalidCompactToken();
  if (typeof raw.compactId !== "string" || !COMPACT_ID_RE.test(raw.compactId)) throw invalidCompactToken();
  if (typeof raw.exp !== "number" || !Number.isFinite(raw.exp) || raw.exp <= 0) throw invalidCompactToken();
  return {
    v: 1,
    account: raw.account,
    profile: raw.profile,
    policyDigest: raw.policyDigest,
    model: raw.model,
    compactId: raw.compactId,
    exp: raw.exp,
  };
}

function isCompactRecord(value: unknown): value is CompactRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (typeof raw.compactId !== "string" || !COMPACT_ID_RE.test(raw.compactId)) return false;
  if (typeof raw.transcriptDigest !== "string" || !raw.transcriptDigest) return false;
  if (typeof raw.account !== "string" || !raw.account) return false;
  if (raw.profile !== "sdk" && raw.profile !== "sand") return false;
  if (typeof raw.policyDigest !== "string" || !raw.policyDigest) return false;
  if (typeof raw.model !== "string" || !raw.model) return false;
  if (raw.sessionId !== undefined && (typeof raw.sessionId !== "string" || !raw.sessionId)) return false;
  if (typeof raw.createdAt !== "number" || typeof raw.exp !== "number") return false;
  return true;
}

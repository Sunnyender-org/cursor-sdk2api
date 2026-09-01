import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir } from "../core/lineage-store.js";
import { credentialFingerprint } from "../digest.js";
import { DEFAULT_RUNTIME_PROFILE, type RuntimeProfile } from "../core/runtime-profile.js";

interface AccountFile {
  version: 1;
  id: string;
  type: "cursor";
  api_key: string;
  added_at: number;
  default_profile?: RuntimeProfile;
}

export interface StoredCursorAccount {
  id: string;
  apiKey: string;
  addedAt: number;
  keyHint: string;
  defaultProfile: RuntimeProfile;
}

const FILE_RE = /^acct_[A-Za-z0-9-]+\.json$/;

function keyHint(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 4 ? "••••" : `••••${trimmed.slice(-4)}`;
}

function readStoredProfile(value: unknown): RuntimeProfile {
  return value === "sand" ? "sand" : DEFAULT_RUNTIME_PROFILE;
}

function isAccountFile(value: unknown): value is AccountFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<AccountFile>;
  return record.version === 1
    && record.type === "cursor"
    && typeof record.id === "string"
    && typeof record.api_key === "string"
    && Boolean(record.api_key.trim())
    && typeof record.added_at === "number";
}

export class CursorAccountFileStore {
  readonly dir: string;

  constructor(stateDir: string, seedCursorKey?: string) {
    this.dir = join(stateDir, "auths");
    ensurePrivateDir(stateDir);
    ensurePrivateDir(this.dir);
    if (seedCursorKey?.trim()) this.add(seedCursorKey);
  }

  list(): StoredCursorAccount[] {
    const accounts: StoredCursorAccount[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!FILE_RE.test(name)) continue;
      const account = this.read(join(this.dir, name));
      if (account) accounts.push(this.toPublic(account));
    }
    return accounts.sort((left, right) => left.addedAt - right.addedAt);
  }

  findByFingerprint(fingerprint: string): StoredCursorAccount | undefined {
    return this.list().find((account) => credentialFingerprint(account.apiKey) === fingerprint);
  }

  get(id: string): StoredCursorAccount | undefined {
    const name = `${id}.json`;
    if (!FILE_RE.test(name)) return undefined;
    const account = this.read(join(this.dir, name));
    return account ? this.toPublic(account) : undefined;
  }

  add(rawApiKey: string): StoredCursorAccount {
    const apiKey = rawApiKey.trim();
    if (!apiKey) throw new Error("Cursor API key is required");
    const fingerprint = credentialFingerprint(apiKey);
    const existing = this.list().find((account) => credentialFingerprint(account.apiKey) === fingerprint);
    if (existing) return existing;
    const account: AccountFile = {
      version: 1,
      id: `acct_${randomUUID()}`,
      type: "cursor",
      api_key: apiKey,
      added_at: Date.now(),
    };
    this.write(account);
    return this.toPublic(account);
  }

  remove(id: string): boolean {
    const name = `${id}.json`;
    if (!FILE_RE.test(name)) return false;
    const path = join(this.dir, name);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  setDefaultProfile(id: string, profile: RuntimeProfile): StoredCursorAccount | undefined {
    const name = `${id}.json`;
    if (!FILE_RE.test(name)) return undefined;
    const path = join(this.dir, name);
    const account = this.read(path);
    if (!account) return undefined;
    const next: AccountFile = { ...account, default_profile: profile };
    this.write(next);
    return this.toPublic(next);
  }

  dirMode(): number {
    return statSync(this.dir).mode & 0o777;
  }

  fileMode(id: string): number | undefined {
    try {
      return statSync(join(this.dir, `${id}.json`)).mode & 0o777;
    } catch {
      return undefined;
    }
  }

  private read(path: string): AccountFile | undefined {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return isAccountFile(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private write(account: AccountFile): void {
    const path = join(this.dir, `${account.id}.json`);
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(account), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, path);
      try {
        chmodSync(path, 0o600);
      } catch {
        // best effort on filesystems that ignore mode
      }
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // best effort cleanup
      }
      throw error;
    }
  }

  private toPublic(account: AccountFile): StoredCursorAccount {
    return {
      id: account.id,
      apiKey: account.api_key,
      addedAt: account.added_at,
      keyHint: keyHint(account.api_key),
      defaultProfile: readStoredProfile(account.default_profile),
    };
  }
}

import type { LedgerErrorCode } from "./types.js";

export class RuntimeLedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RuntimeLedgerError";
    this.code = code;
  }
}

export function mapSqliteError(error: unknown): never {
  const err = error instanceof Error ? error : new Error(String(error));
  if (error instanceof RuntimeLedgerError) throw error;
  const code =
    error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = `${code} ${err.message}`;
  if (/SQLITE_BUSY|database is locked|SQLITE_LOCKED/i.test(message)) {
    throw new RuntimeLedgerError("busy", "sqlite is busy; write was not dropped", { cause: err });
  }
  if (/UNIQUE constraint failed/i.test(err.message)) {
    throw new RuntimeLedgerError("conflict", "runtime ledger unique constraint conflict", { cause: err });
  }
  throw new RuntimeLedgerError("invalid", err.message, { cause: err });
}

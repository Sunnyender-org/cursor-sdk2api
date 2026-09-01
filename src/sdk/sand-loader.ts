import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { sha256Hex } from "../digest.js";
import { ensurePrivateDir } from "../core/lineage-store.js";
import {
  SAND_SDK_PACKAGE_NAME,
  SAND_SDK_VERSION,
  sandSdkPatchContract,
} from "./sand-patch-contract.js";
import { sandSdkCloneDir } from "./sand-paths.js";

export {
  SAND_SDK_PACKAGE_NAME,
  SAND_SDK_PATCH_FILES,
  SAND_SDK_PATCHES,
  SAND_SDK_VERSION,
  sandSdkPatchContract,
} from "./sand-patch-contract.js";
export { sandSdkCloneDir, sandStoreDir, sandWorkspaceDir } from "./sand-paths.js";

export type SandLoaderMismatchReason =
  | "missing_file"
  | "original_hash"
  | "target_hash"
  | "replacement_count"
  | "extra_occurrence"
  | "version_mismatch"
  | "source_mutation_refused";

export class SandLoaderContractError extends Error {
  readonly code = "sand_loader_contract_mismatch" as const;
  readonly reason: SandLoaderMismatchReason;
  readonly file?: string;
  readonly expected?: string | number;
  readonly found?: string | number;

  constructor(
    message: string,
    details: {
      reason: SandLoaderMismatchReason;
      file?: string;
      expected?: string | number;
      found?: string | number;
    },
  ) {
    super(message);
    this.name = "SandLoaderContractError";
    this.reason = details.reason;
    this.file = details.file;
    this.expected = details.expected;
    this.found = details.found;
  }
}

export interface SandReplacement {
  file: string;
  from: string;
  to: string;
  count: number;
}

export interface SandRewriteResult {
  source: string;
  replacements: SandReplacement[];
}

export interface SandContractFileReceipt {
  file: string;
  originalSha256: string;
  targetSha256: string;
  replacementCount: number;
}

export interface SandContractAssertion {
  replacementCount: number;
  files: SandContractFileReceipt[];
}

export interface SandSdkCloneReceipt extends SandContractAssertion {
  sourceDir: string;
  targetDir: string;
}

function occurrenceCount(haystack: string, needle: string): number {
  if (needle.length === 0) {
    throw new SandLoaderContractError("Sand patch needle must not be empty", {
      reason: "replacement_count",
    });
  }
  return haystack.split(needle).length - 1;
}

function isSameOrInside(inner: string, outer: string): boolean {
  const resolvedInner = resolve(inner);
  const resolvedOuter = resolve(outer);
  if (resolvedInner === resolvedOuter) return true;
  const prefix = resolvedOuter.endsWith(sep) ? resolvedOuter : `${resolvedOuter}${sep}`;
  return resolvedInner.startsWith(prefix);
}

function mismatch(
  reason: SandLoaderMismatchReason,
  message: string,
  details: { file?: string; expected?: string | number; found?: string | number } = {},
): SandLoaderContractError {
  return new SandLoaderContractError(message, { reason, ...details });
}

export function rewriteSandSdkSource(relativePath: string, original: string): SandRewriteResult {
  const patches = sandSdkPatchContract.patches.filter((patch) => patch.file === relativePath);
  if (patches.length === 0) return { source: original, replacements: [] };

  let source = original;
  const replacements: SandReplacement[] = [];
  for (const patch of patches) {
    const found = occurrenceCount(source, patch.from);
    if (found !== patch.expected) {
      throw mismatch(
        found > patch.expected ? "extra_occurrence" : "replacement_count",
        `Refusing Sand SDK patch: ${relativePath} expected ${patch.expected} exact client-type match(es), found ${found}`,
        { file: relativePath, expected: patch.expected, found },
      );
    }
    source = source.split(patch.from).join(patch.to);
    replacements.push({ file: relativePath, from: patch.from, to: patch.to, count: found });
  }
  return { source, replacements };
}

function readPackageVersion(sourceDir: string): { name?: string; version?: string } {
  const packagePath = join(sourceDir, "package.json");
  if (!existsSync(packagePath)) {
    throw mismatch("missing_file", "Refusing Sand SDK loader: package.json is missing", {
      file: "package.json",
    });
  }
  try {
    return JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string; version?: string };
  } catch {
    throw mismatch("version_mismatch", "Refusing Sand SDK loader: package.json is not valid JSON", {
      file: "package.json",
    });
  }
}

function assertNoUncontractedEsmPatches(sourceDir: string): void {
  const esmDir = join(sourceDir, "dist/esm");
  if (!existsSync(esmDir)) return;
  const contracted = new Set(sandSdkPatchContract.files.map((file) => file.file));
  const needles = [...new Set(sandSdkPatchContract.patches.map((patch) => patch.from))];
  for (const name of readdirSync(esmDir)) {
    if (!name.endsWith(".js")) continue;
    const relativePath = `dist/esm/${name}`;
    if (contracted.has(relativePath)) continue;
    const source = readFileSync(join(esmDir, name), "utf8");
    for (const needle of needles) {
      const found = occurrenceCount(source, needle);
      if (found > 0) {
        throw mismatch(
          "extra_occurrence",
          `Refusing Sand SDK patch: ${relativePath} has ${found} uncontracted client-type match(es)`,
          { file: relativePath, expected: 0, found },
        );
      }
    }
  }
}

export function assertSandContract(sourceDir: string): SandContractAssertion {
  const resolvedSource = resolve(sourceDir);
  const pkg = readPackageVersion(resolvedSource);
  if (pkg.name !== SAND_SDK_PACKAGE_NAME || pkg.version !== SAND_SDK_VERSION) {
    throw mismatch(
      "version_mismatch",
      `Refusing Sand SDK loader: expected ${SAND_SDK_PACKAGE_NAME} ${SAND_SDK_VERSION}, found ${pkg.name ?? "unknown"} ${pkg.version ?? "unknown"}`,
      {
        file: "package.json",
        expected: `${SAND_SDK_PACKAGE_NAME}@${SAND_SDK_VERSION}`,
        found: `${pkg.name ?? "unknown"}@${pkg.version ?? "unknown"}`,
      },
    );
  }

  for (const fileContract of sandSdkPatchContract.files) {
    const path = join(resolvedSource, fileContract.file);
    if (!existsSync(path)) {
      throw mismatch("missing_file", `Refusing Sand SDK loader: ${fileContract.file} is missing`, {
        file: fileContract.file,
      });
    }
  }

  const files: SandContractFileReceipt[] = [];
  let replacementCount = 0;
  for (const fileContract of sandSdkPatchContract.files) {
    const original = readFileSync(join(resolvedSource, fileContract.file), "utf8");
    const originalSha256 = sha256Hex(original);
    if (originalSha256 !== fileContract.originalSha256) {
      throw mismatch(
        "original_hash",
        `Refusing Sand SDK loader: ${fileContract.file} original SHA256 mismatch`,
        { file: fileContract.file, expected: fileContract.originalSha256, found: originalSha256 },
      );
    }
    const rewritten = rewriteSandSdkSource(fileContract.file, original);
    const count = rewritten.replacements.reduce((sum, replacement) => sum + replacement.count, 0);
    const targetSha256 = sha256Hex(rewritten.source);
    if (targetSha256 !== fileContract.targetSha256) {
      throw mismatch(
        "target_hash",
        `Refusing Sand SDK loader: ${fileContract.file} target SHA256 mismatch`,
        { file: fileContract.file, expected: fileContract.targetSha256, found: targetSha256 },
      );
    }
    replacementCount += count;
    files.push({
      file: fileContract.file,
      originalSha256,
      targetSha256,
      replacementCount: count,
    });
  }

  if (replacementCount !== sandSdkPatchContract.expectedReplacementCount) {
    throw mismatch(
      "replacement_count",
      `Refusing Sand SDK loader: expected ${sandSdkPatchContract.expectedReplacementCount} replacements, found ${replacementCount}`,
      { expected: sandSdkPatchContract.expectedReplacementCount, found: replacementCount },
    );
  }

  assertNoUncontractedEsmPatches(resolvedSource);
  return { replacementCount, files };
}

export function resolveInstalledCursorSdkDir(): string {
  const require = createRequire(import.meta.url);
  try {
    const entry = require.resolve("@cursor/sdk");
    let dir = dirname(entry);
    for (let i = 0; i < 5; i += 1) {
      const packagePath = join(dir, "package.json");
      if (existsSync(packagePath)) {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
        if (pkg.name === SAND_SDK_PACKAGE_NAME) return dir;
      }
      dir = dirname(dir);
    }
  } catch {
    // Package exports may not expose package.json; fall through to cwd.
  }
  const fallback = join(process.cwd(), "node_modules", "@cursor", "sdk");
  if (existsSync(join(fallback, "package.json"))) return fallback;
  throw mismatch("missing_file", "Refusing Sand SDK loader: installed @cursor/sdk 1.0.30 was not found", {
    file: "node_modules/@cursor/sdk",
  });
}

export async function createSandSdkClone(options: {
  sourceDir: string;
  targetDir: string;
}): Promise<SandSdkCloneReceipt> {
  const sourceDir = resolve(options.sourceDir);
  const targetDir = resolve(options.targetDir);
  if (isSameOrInside(targetDir, sourceDir)) {
    throw mismatch(
      "source_mutation_refused",
      "Refusing Sand SDK loader: clone target must not mutate the installed SDK tree",
      { file: sourceDir },
    );
  }

  const asserted = assertSandContract(sourceDir);
  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true, force: false });
  ensurePrivateDir(targetDir);

  for (const fileContract of sandSdkPatchContract.files) {
    const path = join(targetDir, fileContract.file);
    if (!existsSync(path)) {
      throw mismatch("missing_file", `Refusing Sand SDK loader: cloned ${fileContract.file} is missing`, {
        file: fileContract.file,
      });
    }
    const original = await readFile(path, "utf8");
    const originalSha256 = sha256Hex(original);
    if (originalSha256 !== fileContract.originalSha256) {
      throw mismatch(
        "original_hash",
        `Refusing Sand SDK loader: cloned ${fileContract.file} original SHA256 mismatch`,
        { file: fileContract.file, expected: fileContract.originalSha256, found: originalSha256 },
      );
    }
    const rewritten = rewriteSandSdkSource(fileContract.file, original);
    const targetSha256 = sha256Hex(rewritten.source);
    if (targetSha256 !== fileContract.targetSha256) {
      throw mismatch(
        "target_hash",
        `Refusing Sand SDK loader: cloned ${fileContract.file} target SHA256 mismatch`,
        { file: fileContract.file, expected: fileContract.targetSha256, found: targetSha256 },
      );
    }
    await writeFile(path, rewritten.source, { encoding: "utf8", mode: 0o600 });
    try {
      await chmod(path, 0o600);
    } catch {
      // best-effort on filesystems that ignore mode
    }
    const written = await readFile(path, "utf8");
    if (sha256Hex(written) !== fileContract.targetSha256) {
      throw mismatch(
        "target_hash",
        `Refusing Sand SDK loader: wrote ${fileContract.file} with unexpected SHA256`,
        { file: fileContract.file, expected: fileContract.targetSha256, found: sha256Hex(written) },
      );
    }
  }

  return {
    sourceDir,
    targetDir,
    replacementCount: asserted.replacementCount,
    files: asserted.files,
  };
}

export interface SandLoaderHealth {
  ready: boolean;
  sdk_version: string;
  patch_contract_version: string;
  reason?: SandLoaderMismatchReason;
}

export function inspectSandLoader(sourceDir?: string): SandLoaderHealth {
  const version = {
    sdk_version: SAND_SDK_VERSION,
    patch_contract_version: SAND_SDK_VERSION,
  };
  try {
    const resolved = sourceDir ?? resolveInstalledCursorSdkDir();
    assertSandContract(resolved);
    return { ready: true, ...version };
  } catch (error) {
    const reason = error instanceof SandLoaderContractError ? error.reason : "missing_file";
    return { ready: false, ...version, reason };
  }
}

function cloneMatchesContract(targetDir: string): boolean {
  try {
    for (const fileContract of sandSdkPatchContract.files) {
      const written = readFileSync(join(targetDir, fileContract.file), "utf8");
      if (sha256Hex(written) !== fileContract.targetSha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function ensureSandSdkClone(stateDir: string, sourceDir?: string): Promise<string> {
  const resolvedSource = sourceDir ?? resolveInstalledCursorSdkDir();
  assertSandContract(resolvedSource);
  const targetDir = sandSdkCloneDir(stateDir);
  if (cloneMatchesContract(targetDir)) return targetDir;
  rmSync(targetDir, { recursive: true, force: true });
  await createSandSdkClone({ sourceDir: resolvedSource, targetDir });
  return targetDir;
}

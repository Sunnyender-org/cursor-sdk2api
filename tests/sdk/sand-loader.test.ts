import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { sha256Hex } from "../../src/digest.js";
import {
  SandLoaderContractError,
  assertSandContract,
  createSandSdkClone,
  resolveInstalledCursorSdkDir,
  rewriteSandSdkSource,
  sandSdkCloneDir,
  sandSdkPatchContract,
  sandStoreDir,
  sandWorkspaceDir,
} from "../../src/sdk/sand-loader.js";

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [relativePath, body] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
  }
}

function expectMismatch(
  fn: () => unknown,
  reason: SandLoaderContractError["reason"],
): SandLoaderContractError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SandLoaderContractError);
    const typed = error as SandLoaderContractError;
    expect(typed.code).toBe("sand_loader_contract_mismatch");
    expect(typed.reason).toBe(reason);
    return typed;
  }
  throw new Error(`expected sand_loader_contract_mismatch (${reason})`);
}

const INDEX_FROM_OBJECT = '"x-cursor-client-type":"sdk"';
const INDEX_FROM_SET = 'set("x-cursor-client-type","sdk")';

test("rewriteSandSdkSource applies the two index.js client-type replacements", () => {
  const original = `header ${INDEX_FROM_OBJECT} mid ${INDEX_FROM_SET} tail`;
  const rewritten = rewriteSandSdkSource("dist/esm/index.js", original);
  expect(rewritten.replacements.reduce((sum, item) => sum + item.count, 0)).toBe(2);
  expect(rewritten.source).toContain('"x-cursor-client-type":"sand"');
  expect(rewritten.source).toContain('set("x-cursor-client-type","sand")');
  expect(rewritten.source).not.toContain(INDEX_FROM_OBJECT);
  expect(rewritten.source).not.toContain(INDEX_FROM_SET);
});

test("rewriteSandSdkSource fails closed on extra occurrence", () => {
  const original = `${INDEX_FROM_OBJECT}${INDEX_FROM_OBJECT} ${INDEX_FROM_SET}`;
  const error = expectMismatch(() => rewriteSandSdkSource("dist/esm/index.js", original), "extra_occurrence");
  expect(error.file).toBe("dist/esm/index.js");
  expect(error.expected).toBe(1);
  expect(error.found).toBe(2);
});

test("rewriteSandSdkSource fails closed on replacement count mismatch", () => {
  const error = expectMismatch(
    () => rewriteSandSdkSource("dist/esm/357.js", "no client-type header here"),
    "replacement_count",
  );
  expect(error.file).toBe("dist/esm/357.js");
  expect(error.expected).toBe(1);
  expect(error.found).toBe(0);
});

test("assertSandContract fails closed when a contracted file is missing", () => {
  const root = tempDir("cursor-sand-missing-");
  writeTree(root, {
    "package.json": JSON.stringify({ name: "@cursor/sdk", version: "1.0.30" }),
    "dist/esm/index.js": `${INDEX_FROM_OBJECT}${INDEX_FROM_SET}`,
  });
  const error = expectMismatch(() => assertSandContract(root), "missing_file");
  expect(error.file).toBe("dist/esm/357.js");
});

test("assertSandContract fails closed on original hash mismatch", () => {
  const root = tempDir("cursor-sand-hash-");
  writeTree(root, {
    "package.json": JSON.stringify({ name: "@cursor/sdk", version: "1.0.30" }),
    "dist/esm/index.js": `changed ${INDEX_FROM_OBJECT} ${INDEX_FROM_SET}`,
    "dist/esm/357.js": INDEX_FROM_OBJECT,
  });
  const error = expectMismatch(() => assertSandContract(root), "original_hash");
  expect(error.file).toBe("dist/esm/index.js");
  expect(error.expected).toBe(sandSdkPatchContract.files[0]?.originalSha256);
  expect(error.found).toBe(sha256Hex(`changed ${INDEX_FROM_OBJECT} ${INDEX_FROM_SET}`));
});

test("assertSandContract fails closed when an extra ESM file needs a patch", () => {
  const sourceDir = resolveInstalledCursorSdkDir();
  const root = tempDir("cursor-sand-extra-");
  writeTree(root, {
    "package.json": readFileSync(join(sourceDir, "package.json"), "utf8"),
    "dist/esm/index.js": readFileSync(join(sourceDir, "dist/esm/index.js"), "utf8"),
    "dist/esm/357.js": readFileSync(join(sourceDir, "dist/esm/357.js"), "utf8"),
    "dist/esm/999.js": INDEX_FROM_OBJECT,
  });
  const error = expectMismatch(() => assertSandContract(root), "extra_occurrence");
  expect(error.file).toBe("dist/esm/999.js");
  expect(error.found).toBe(1);
});

test("sand store and workspace paths are isolated 0700 directories", () => {
  const stateDir = tempDir("cursor-sand-paths-");
  const store = sandStoreDir(stateDir);
  const workspace = sandWorkspaceDir(stateDir);
  const clone = sandSdkCloneDir(stateDir);
  expect(store).toBe(join(stateDir, "sand", "store"));
  expect(workspace).toBe(join(stateDir, "sand", "workspace"));
  expect(clone).toBe(join(stateDir, "sand-sdk"));
  expect(store).not.toBe(join(stateDir, "sdk-store"));
  expect(workspace).not.toBe(join(stateDir, "empty-workspace"));
  expect(clone).not.toBe(store);
  expect(statSync(join(stateDir, "sand")).mode & 0o777).toBe(0o700);
  expect(statSync(store).mode & 0o777).toBe(0o700);
  expect(statSync(workspace).mode & 0o777).toBe(0o700);
  expect(statSync(clone).mode & 0o777).toBe(0o700);
});

test("createSandSdkClone refuses to write back into the source SDK tree", async () => {
  const sourceDir = tempDir("cursor-sand-src-");
  await expect(createSandSdkClone({ sourceDir, targetDir: join(sourceDir, "nested") })).rejects.toMatchObject({
    code: "sand_loader_contract_mismatch",
    reason: "source_mutation_refused",
  });
});

test(
  "createSandSdkClone patches installed @cursor/sdk 1.0.30 without mutating the source tree",
  async () => {
    const sourceDir = resolveInstalledCursorSdkDir();
    const indexPath = join(sourceDir, "dist/esm/index.js");
    const statsigPath = join(sourceDir, "dist/esm/357.js");
    const sourceIndexBefore = readFileSync(indexPath, "utf8");
    const sourceStatsigBefore = readFileSync(statsigPath, "utf8");
    const root = tempDir("cursor-sand-clone-");
    const targetDir = join(root, "sdk");

    const receipt = await createSandSdkClone({ sourceDir, targetDir });
    const sourceIndexAfter = readFileSync(indexPath, "utf8");
    const sourceStatsigAfter = readFileSync(statsigPath, "utf8");
    const patchedIndex = readFileSync(join(targetDir, "dist/esm/index.js"), "utf8");
    const patchedStatsig = readFileSync(join(targetDir, "dist/esm/357.js"), "utf8");
    const clonedCjs = readFileSync(join(targetDir, "dist/cjs/index.js"), "utf8");

    expect(sandSdkPatchContract.expectedReplacementCount).toBe(3);
    expect(receipt.replacementCount).toBe(3);
    expect(sourceIndexAfter).toBe(sourceIndexBefore);
    expect(sourceStatsigAfter).toBe(sourceStatsigBefore);
    expect(sha256Hex(sourceIndexAfter)).toBe(sandSdkPatchContract.files[0]?.originalSha256);
    expect(sha256Hex(sourceStatsigAfter)).toBe(sandSdkPatchContract.files[1]?.originalSha256);
    expect(sha256Hex(patchedIndex)).toBe(sandSdkPatchContract.files[0]?.targetSha256);
    expect(sha256Hex(patchedStatsig)).toBe(sandSdkPatchContract.files[1]?.targetSha256);
    expect(patchedIndex).toContain('"x-cursor-client-type":"sand"');
    expect(patchedIndex).toContain('set("x-cursor-client-type","sand")');
    expect(patchedIndex).not.toContain(INDEX_FROM_SET);
    expect(patchedStatsig).toContain('"x-cursor-client-type":"sand"');
    expect(clonedCjs).toContain(INDEX_FROM_OBJECT);
    expect(statSync(targetDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(targetDir, "dist/esm/index.js")).mode & 0o777).toBe(0o600);
    expect(statSync(join(targetDir, "dist/esm/357.js")).mode & 0o777).toBe(0o600);
  },
  60_000,
);

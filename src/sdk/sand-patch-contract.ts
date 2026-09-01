/**
 * Frozen @cursor/sdk 1.0.30 ESM client-type patch fence.
 * Hashes were taken from the installed 1.0.30 tree. Do not reuse 1.0.28 hashes.
 */

export interface SandPatchSpec {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly expected: number;
}

export interface SandPatchedFileContract {
  readonly file: string;
  readonly originalSha256: string;
  readonly targetSha256: string;
}

export const SAND_SDK_PACKAGE_NAME = "@cursor/sdk";
export const SAND_SDK_VERSION = "1.0.30";

export const SAND_SDK_PATCHES: readonly SandPatchSpec[] = Object.freeze([
  {
    file: "dist/esm/index.js",
    from: '"x-cursor-client-type":"sdk"',
    to: '"x-cursor-client-type":"sand"',
    expected: 1,
  },
  {
    file: "dist/esm/index.js",
    from: 'set("x-cursor-client-type","sdk")',
    to: 'set("x-cursor-client-type","sand")',
    expected: 1,
  },
  {
    file: "dist/esm/357.js",
    from: '"x-cursor-client-type":"sdk"',
    to: '"x-cursor-client-type":"sand"',
    expected: 1,
  },
]);

export const SAND_SDK_PATCH_FILES: readonly SandPatchedFileContract[] = Object.freeze([
  {
    file: "dist/esm/index.js",
    originalSha256: "c74f18ef1879920da37749d420dce55299fd3c4978696439b0c80e73193a4de0",
    targetSha256: "569de07206285c0b0ac61a38a5a160e65ca611af38292d4754f7d2effaad0077",
  },
  {
    file: "dist/esm/357.js",
    originalSha256: "d26b0bb021b127811affef9196e08b1bea751dc26d3b55221376194e91c3d0fc",
    targetSha256: "534dd95800534c48397fd0d8f8904c468157ca61fa00e7b9ebd21c49c64ee032",
  },
]);

const derivedReplacementCount = SAND_SDK_PATCHES.reduce((sum, patch) => sum + patch.expected, 0);
if (derivedReplacementCount !== 3) {
  throw new Error("Sand patch contract must lock exactly 3 replacements for @cursor/sdk 1.0.30");
}

export const sandSdkPatchContract = Object.freeze({
  packageName: SAND_SDK_PACKAGE_NAME,
  sdkVersion: SAND_SDK_VERSION,
  expectedReplacementCount: 3,
  patches: SAND_SDK_PATCHES,
  files: SAND_SDK_PATCH_FILES,
});

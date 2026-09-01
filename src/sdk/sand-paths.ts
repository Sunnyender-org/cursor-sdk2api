import { join } from "node:path";
import { ensurePrivateDir } from "../core/lineage-store.js";

export function sandRootDir(stateDir: string): string {
  const dir = join(stateDir, "sand");
  ensurePrivateDir(dir);
  return dir;
}

export function sandStoreDir(stateDir: string): string {
  const dir = join(sandRootDir(stateDir), "store");
  ensurePrivateDir(dir);
  return dir;
}

export function sandWorkspaceDir(stateDir: string): string {
  const dir = join(sandRootDir(stateDir), "workspace");
  ensurePrivateDir(dir);
  return dir;
}

export function sandSdkCloneDir(stateDir: string): string {
  const dir = join(stateDir, "sand-sdk");
  ensurePrivateDir(dir);
  return dir;
}

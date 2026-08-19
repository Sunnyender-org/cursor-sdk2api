import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "./redact.js";
import { proxyEnvironment } from "../../../src/sdk/proxy.js";

export interface ChildGateway {
  baseUrl: string;
  stateDir: string;
  workspaceDir: string;
  restart(): Promise<void>;
  restartWithoutLineage(): Promise<void>;
  stop(): Promise<void>;
  cleanup(): void;
}

export async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error("failed to allocate loopback port");
  return port;
}

export async function startChildGateway(input: {
  repoRoot: string;
  distEntry: string;
  canaries: string[];
  readyTimeoutMs?: number;
}): Promise<ChildGateway> {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-smoke-state-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-smoke-ws-"));
  let port = await freeLoopbackPort();
  let child = spawnChild({
    distEntry: input.distEntry,
    repoRoot: input.repoRoot,
    port,
    stateDir,
    workspaceDir,
  });

  const readyTimeoutMs = input.readyTimeoutMs ?? 15_000;
  try {
    await waitHealth(`http://127.0.0.1:${port}`, readyTimeoutMs, child, input.canaries);
  } catch (error) {
    await stopProcess(child);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    throw error;
  }

  const handle: ChildGateway = {
    get baseUrl() {
      return `http://127.0.0.1:${port}`;
    },
    stateDir,
    workspaceDir,
    async restart() {
      await stopProcess(child);
      port = await freeLoopbackPort();
      child = spawnChild({
        distEntry: input.distEntry,
        repoRoot: input.repoRoot,
        port,
        stateDir,
        workspaceDir,
      });
      await waitHealth(`http://127.0.0.1:${port}`, readyTimeoutMs, child, input.canaries);
    },
    async restartWithoutLineage() {
      await stopProcess(child);
      rmSync(join(stateDir, "lineage"), { recursive: true, force: true });
      port = await freeLoopbackPort();
      child = spawnChild({
        distEntry: input.distEntry,
        repoRoot: input.repoRoot,
        port,
        stateDir,
        workspaceDir,
      });
      await waitHealth(`http://127.0.0.1:${port}`, readyTimeoutMs, child, input.canaries);
    },
    async stop() {
      await stopProcess(child);
    },
    cleanup() {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
  return handle;
}

function spawnChild(input: {
  distEntry: string;
  repoRoot: string;
  port: number;
  stateDir: string;
  workspaceDir: string;
}): ChildProcess {
  const child = spawn(process.execPath, [input.distEntry], {
    cwd: input.repoRoot,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(input.port),
      AUTH_MODE: "byok",
      STATE_DIR: input.stateDir,
      EMPTY_WORKSPACE_DIR: input.workspaceDir,
      LOG_LEVEL: "error",
      DEBUG_PAYLOADS: "false",
      ...proxyEnvironment(process.env),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

async function waitHealth(
  baseUrl: string,
  timeoutMs: number,
  child: ChildProcess,
  canaries: string[],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "not contacted";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gateway child exited before ready (${child.exitCode})`);
    }
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
      last = `http ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? redactSecrets(error.message, canaries) : "fetch failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`gateway health not ready: ${last}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

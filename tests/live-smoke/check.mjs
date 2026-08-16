#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CURSOR_LIVE_SMOKE !== "1") {
  console.error("Refusing live smoke. Set CURSOR_LIVE_SMOKE=1 to opt in.");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, ["--import", "tsx", join(here, "run.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});

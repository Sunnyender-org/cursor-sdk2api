import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;
let consoleDir: string | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  if (consoleDir) await rm(consoleDir, { recursive: true, force: true });
});

test("operator console redirects to its canonical trailing-slash path", async () => {
  consoleDir = await mkdtemp(join(tmpdir(), "cursor-sdk2api-console-"));
  await writeFile(join(consoleDir, "index.html"), "<!doctype html><title>Console</title>");
  ctx = await startTestApp({ config: { consoleDir } });

  const response = await fetch(`${ctx.url}/console`, { redirect: "manual" });
  expect(response.status).toBe(308);
  expect(response.headers.get("location")).toBe("/console/");
});

test("operator console serves static assets with restrictive browser headers", async () => {
  consoleDir = await mkdtemp(join(tmpdir(), "cursor-sdk2api-console-"));
  await writeFile(join(consoleDir, "index.html"), "<!doctype html><title>BF Labs operator console</title>");
  ctx = await startTestApp({ config: { consoleDir } });

  const response = await fetch(`${ctx.url}/console/`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
  expect(await response.text()).toContain("BF Labs operator console");

  const head = await fetch(`${ctx.url}/console/`, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
});

test("operator console blocks traversal outside its build directory", async () => {
  consoleDir = await mkdtemp(join(tmpdir(), "cursor-sdk2api-console-"));
  await writeFile(join(consoleDir, "index.html"), "safe");
  ctx = await startTestApp({ config: { consoleDir } });

  const response = await fetch(`${ctx.url}/console/%2e%2e%2fpackage.json`);
  expect(response.status).toBe(404);
});

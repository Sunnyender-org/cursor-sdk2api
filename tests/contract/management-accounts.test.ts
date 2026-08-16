import { statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
});

test("accounts persist across gateway restarts with CPA-style private files", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-persistent-"));
  ctx = await startTestApp({ config: { stateDir } });

  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "fixture-account-key" }),
  });
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { account: { id: string; api_key: string } };
  expect(createdBody.account.api_key).toBe("fixture-account-key");
  expect(statSync(join(stateDir, "auths")).mode & 0o777).toBe(0o700);
  expect(statSync(join(stateDir, "auths", `${createdBody.account.id}.json`)).mode & 0o777).toBe(0o600);

  await closeTestApp(ctx);
  ctx = await startTestApp({ config: { stateDir } });
  const restored = await fetch(`${ctx.url}/v0/management/accounts`);
  const restoredBody = (await restored.json()) as { accounts: Array<{ id: string; api_key: string }> };
  expect(restoredBody.accounts).toEqual([
    expect.objectContaining({ id: createdBody.account.id, api_key: "fixture-account-key" }),
  ]);

  const removed = await fetch(`${ctx.url}/v0/management/accounts?id=${encodeURIComponent(createdBody.account.id)}`, {
    method: "DELETE",
  });
  expect(removed.status).toBe(200);
  const empty = await fetch(`${ctx.url}/v0/management/accounts`);
  expect(await empty.json()).toMatchObject({ accounts: [] });
});

test("adding the same Cursor key is idempotent", async () => {
  ctx = await startTestApp();
  const add = () => fetch(`${ctx!.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "same-key" }),
  });
  const first = (await (await add()).json()) as { account: { id: string } };
  const second = (await (await add()).json()) as { account: { id: string } };
  expect(second.account.id).toBe(first.account.id);
  const listed = await fetch(`${ctx.url}/v0/management/accounts`);
  const body = (await listed.json()) as { accounts: unknown[] };
  expect(body.accounts).toHaveLength(1);
});

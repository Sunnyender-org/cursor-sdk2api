import type { AccountPayload, HealthPayload, ModelsPayload, Protocol } from "./types.js";

export interface ManagementAccount {
  id: string;
  key_hint: string;
  added_at: number;
  default_profile?: "sdk" | "sand";
}

export async function getHealth(): Promise<HealthPayload> {
  return getJson<HealthPayload>("/health");
}

export async function getModels(apiKey: string): Promise<ModelsPayload> {
  return getJson<ModelsPayload>("/v1/models", apiKey);
}

export async function getAccount(apiKey: string): Promise<AccountPayload> {
  return getJson<AccountPayload>("/v1/account", apiKey);
}

export async function probeManagedAccount(id: string): Promise<{ models: ModelsPayload; account: AccountPayload }> {
  return managementJson<{ models: ModelsPayload; account: AccountPayload }>({
    method: "GET",
    path: `/probe?id=${encodeURIComponent(id)}`,
  });
}

export async function getManagedAccounts(): Promise<ManagementAccount[]> {
  const body = await managementJson<{ accounts: ManagementAccount[] }>({
    method: "GET",
  });
  return body.accounts;
}

export async function addManagedAccount(apiKey: string): Promise<ManagementAccount> {
  const body = await managementJson<{ account: ManagementAccount }>({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  return body.account;
}

export async function setManagedDefaultProfile(
  id: string,
  defaultProfile: "sdk" | "sand",
): Promise<AccountPayload> {
  const body = await managementJson<{ account: AccountPayload }>({
    method: "PUT",
    path: "/default_profile",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, default_profile: defaultProfile }),
  });
  return body.account;
}

export async function removeManagedAccount(id: string): Promise<void> {
  await managementJson<{ deleted: true }>({
    method: "DELETE",
    path: `?id=${encodeURIComponent(id)}`,
  });
}

export async function runPrompt(input: {
  accountId: string;
  protocol: Protocol;
  model: string;
  prompt: string;
  stream: boolean;
  onChunk: (value: string) => void;
}): Promise<void> {
  const body =
    input.protocol === "messages"
      ? {
          model: input.model,
          max_tokens: 2048,
          stream: input.stream,
          messages: [{ role: "user", content: input.prompt }],
        }
      : input.protocol === "chat"
        ? {
          model: input.model,
          stream: input.stream,
          stream_options: input.stream ? { include_usage: true } : undefined,
          messages: [{ role: "user", content: input.prompt }],
          }
        : {
            model: input.model,
            stream: input.stream,
            input: input.prompt,
          };
  const response = await fetch("/v0/management/accounts/run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ account_id: input.accountId, protocol: input.protocol, request: body }),
  });
  if (!response.ok) throw new Error(await errorMessage(response));

  if (!input.stream) {
    input.onChunk(JSON.stringify(await response.json(), null, 2));
    return;
  }
  if (!response.body) throw new Error("The browser did not expose the response stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
    input.onChunk(output);
  }
  output += decoder.decode();
  input.onChunk(output);
}

export function protocolEndpoint(protocol: Protocol): string {
  if (protocol === "messages") return "/v1/messages";
  if (protocol === "chat") return "/v1/chat/completions";
  return "/v1/responses";
}

async function getJson<T>(path: string, apiKey?: string): Promise<T> {
  const response = await fetch(path, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as T;
}

async function managementJson<T>(
  init: RequestInit & { path?: string },
): Promise<T> {
  const headers = new Headers(init.headers);
  const response = await fetch(`/v0/management/accounts${init.path ?? ""}`, { ...init, headers });
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json()) as T;
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string };
    };
    return body.error?.message || `${response.status} ${response.statusText}`;
  } catch {
    return text || `${response.status} ${response.statusText}`;
  }
}

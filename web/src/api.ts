import type { AccountPayload, HealthPayload, ModelsPayload, Protocol } from "./types";

export async function getHealth(): Promise<HealthPayload> {
  return getJson<HealthPayload>("/health");
}

export async function getModels(apiKey: string): Promise<ModelsPayload> {
  return getJson<ModelsPayload>("/v1/models", apiKey);
}

export async function getAccount(apiKey: string): Promise<AccountPayload> {
  return getJson<AccountPayload>("/v1/account", apiKey);
}

export async function runPrompt(input: {
  apiKey: string;
  protocol: Protocol;
  model: string;
  prompt: string;
  stream: boolean;
  onChunk: (value: string) => void;
}): Promise<void> {
  const endpoint = input.protocol === "messages" ? "/v1/messages" : "/v1/chat/completions";
  const body =
    input.protocol === "messages"
      ? {
          model: input.model,
          max_tokens: 2048,
          stream: input.stream,
          messages: [{ role: "user", content: input.prompt }],
        }
      : {
          model: input.model,
          stream: input.stream,
          stream_options: input.stream ? { include_usage: true } : undefined,
          messages: [{ role: "user", content: input.prompt }],
        };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
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

async function getJson<T>(path: string, apiKey?: string): Promise<T> {
  const response = await fetch(path, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
  });
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

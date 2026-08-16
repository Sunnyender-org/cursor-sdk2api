#!/usr/bin/env node
import process from "node:process";

const tool = (name, description) => ({
  name,
  description,
  input_schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
});

export function buildTextRequest(model) {
  return {
    path: "/v1/chat/completions",
    body: { model, messages: [{ role: "user", content: "Reply with exactly: new-api cursor text ok" }] },
  };
}

export function buildSonnetFirstRequest(model) {
  return {
    path: "/v1/messages",
    headers: { "anthropic-version": "2023-06-01" },
    body: {
      model,
      max_tokens: 256,
      tools: [tool("lookup_temperature", "Return the supplied temperature")],
      tool_choice: { type: "tool", name: "lookup_temperature" },
      messages: [{ role: "user", content: "Call lookup_temperature with value 72F, then use its result." }],
    },
  };
}

export function buildSonnetContinuation(model, first) {
  const uses = first.content?.filter((block) => block.type === "tool_use") ?? [];
  if (uses.length !== 1) throw new Error(`Sonnet expected one tool_use, received ${uses.length}`);
  return {
    path: "/v1/messages",
    headers: { "anthropic-version": "2023-06-01" },
    body: {
      model,
      max_tokens: 256,
      tools: [tool("lookup_temperature", "Return the supplied temperature")],
      messages: [
        { role: "user", content: "Call lookup_temperature with value 72F, then use its result." },
        { role: "assistant", content: first.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: uses[0].id, content: "72F" }] },
      ],
    },
  };
}

const openAiTool = (name) => ({
  type: "function",
  function: {
    name,
    description: `Return ${name}`,
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
});

export function buildGrokFirstRequest(model) {
  return {
    path: "/v1/chat/completions",
    body: {
      model,
      reasoning_effort: "xhigh",
      parallel_tool_calls: true,
      tool_choice: "required",
      tools: [openAiTool("lookup_alpha"), openAiTool("lookup_beta")],
      messages: [{ role: "user", content: "Call both lookup_alpha(value=A) and lookup_beta(value=B) in one turn." }],
    },
  };
}

export function buildGrokContinuation(model, first) {
  const message = first.choices?.[0]?.message;
  const calls = message?.tool_calls ?? [];
  const names = new Set(calls.map((call) => call.function?.name));
  if (calls.length !== 2 || !names.has("lookup_alpha") || !names.has("lookup_beta")) {
    throw new Error(`Grok expected two parallel tool calls, received ${calls.length}`);
  }
  return {
    path: "/v1/chat/completions",
    body: {
      model,
      reasoning_effort: "xhigh",
      tools: [openAiTool("lookup_alpha"), openAiTool("lookup_beta")],
      messages: [
        { role: "user", content: "Call both lookup_alpha(value=A) and lookup_beta(value=B) in one turn." },
        message,
        ...calls.map((call) => ({
          role: "tool",
          tool_call_id: call.id,
          content: call.function.name === "lookup_alpha" ? "alpha=A" : "beta=B",
        })),
      ],
    },
  };
}

async function request(baseUrl, token, spec) {
  const response = await fetch(`${baseUrl}${spec.path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...spec.headers,
    },
    body: JSON.stringify(spec.body),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${spec.path} returned non-JSON ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok || body.error) {
    throw new Error(`${spec.path} failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

export async function runSmoke(env = process.env) {
  const baseUrl = (env.NEW_API_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
  const token = env.NEW_API_TOKEN;
  if (!token) throw new Error("NEW_API_TOKEN is required; use a new-api user token, not a Cursor key");

  const textModel = env.TEXT_MODEL || "composer-2.5";
  const sonnetModel = env.SONNET_MODEL || "claude-sonnet-4-6";
  const grokModel = env.GROK_MODEL || "grok-4.6";

  const text = await request(baseUrl, token, buildTextRequest(textModel));
  if (!text.choices?.[0]?.message?.content) throw new Error("text smoke returned no assistant content");

  const sonnetFirst = await request(baseUrl, token, buildSonnetFirstRequest(sonnetModel));
  const sonnetFinal = await request(baseUrl, token, buildSonnetContinuation(sonnetModel, sonnetFirst));
  if (!sonnetFinal.content?.some((block) => block.type === "text" && block.text)) {
    throw new Error("Sonnet continuation returned no final text");
  }

  const grokFirst = await request(baseUrl, token, buildGrokFirstRequest(grokModel));
  const grokFinal = await request(baseUrl, token, buildGrokContinuation(grokModel, grokFirst));
  if (!grokFinal.choices?.[0]?.message?.content) throw new Error("Grok continuation returned no final text");

  return { text: "passed", sonnet_tool_continuation: "passed", grok_parallel_tool: "passed" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSmoke()
    .then((receipt) => console.log(JSON.stringify(receipt, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}

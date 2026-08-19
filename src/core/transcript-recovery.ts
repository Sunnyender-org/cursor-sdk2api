import { digestJson } from "../digest.js";
import { sessionLost } from "../errors.js";
import { asBlocks, renderPrompt, stringifyToolResult } from "../protocols/anthropic/parse.js";
import type { ParsedMessages, ParsedToolResult } from "../protocols/anthropic/types.js";
import type { SdkCustomToolResult } from "../sdk/port.js";
import { completedToolSignature } from "./tool-bridge.js";

interface TranscriptCall {
  name: string;
  input: unknown;
}

export interface TranscriptRecovery {
  digest: string;
  prompt: string;
  completedResults: Map<string, SdkCustomToolResult[]>;
}

export function buildTranscriptRecovery(
  parsed: ParsedMessages,
  currentResults: ParsedToolResult[],
): TranscriptRecovery {
  if (parsed.tools.length === 0) {
    throw sessionLost("Expired tool continuation cannot recover without its tool catalog");
  }
  const catalog = new Set(parsed.tools.map((tool) => tool.name));
  const calls = new Map<string, TranscriptCall>();
  for (const message of parsed.messages) {
    if (message.role !== "assistant") continue;
    for (const block of asBlocks(message.content)) {
      if (block.type !== "tool_use") continue;
      if (calls.has(block.id)) {
        throw sessionLost(`Tool transcript contains duplicate tool_use id: ${block.id}`);
      }
      calls.set(block.id, { name: block.name, input: block.input ?? {} });
    }
  }

  const currentIds = new Set<string>();
  for (const result of currentResults) {
    if (currentIds.has(result.toolUseId)) {
      throw sessionLost(`Tool transcript contains duplicate current result: ${result.toolUseId}`);
    }
    currentIds.add(result.toolUseId);
    const call = calls.get(result.toolUseId);
    if (!call || !catalog.has(call.name)) {
      throw sessionLost(`Tool transcript is missing a catalogued call for: ${result.toolUseId}`);
    }
  }
  const latestAssistantBatch = [...parsed.messages]
    .reverse()
    .find((message) =>
      message.role === "assistant" && asBlocks(message.content).some((block) => block.type === "tool_use"));
  const latestBatchIds = latestAssistantBatch
    ? asBlocks(latestAssistantBatch.content)
        .filter((block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use")
        .map((block) => block.id)
        .sort()
    : [];
  const providedIds = [...currentIds].sort();
  if (
    latestBatchIds.length !== providedIds.length ||
    latestBatchIds.some((id, index) => id !== providedIds[index])
  ) {
    throw sessionLost("Tool transcript results do not exactly match the latest assistant tool batch");
  }

  const completedResults = new Map<string, SdkCustomToolResult[]>();
  const completedIds = new Set<string>();
  for (const message of parsed.messages) {
    if (message.role !== "user") continue;
    for (const block of asBlocks(message.content)) {
      if (block.type !== "tool_result") continue;
      const call = calls.get(block.tool_use_id);
      if (!call || !catalog.has(call.name)) continue;
      const signature = completedToolSignature(call.name, call.input);
      const queue = completedResults.get(signature) ?? [];
      queue.push(
        block.is_error === true
          ? { content: [{ type: "text", text: stringifyToolResult(block.content) }], isError: true }
          : stringifyToolResult(block.content),
      );
      completedResults.set(signature, queue);
      completedIds.add(block.tool_use_id);
    }
  }
  for (const result of currentResults) {
    if (!completedIds.has(result.toolUseId)) {
      throw sessionLost(`Tool transcript is incomplete for: ${result.toolUseId}`);
    }
  }

  const rendered = renderPrompt(parsed, { includeContinuation: true });
  const lines = currentResults.map((result) => {
    const call = calls.get(result.toolUseId) as TranscriptCall;
    return `TOOL_RESULT tool_use_id=${result.toolUseId} tool=${call.name} is_error=${result.isError} content=${JSON.stringify(result.content)}`;
  });
  const prompt = [
    rendered.text,
    "HOST_SESSION_RECOVERY:",
    "The original Cursor SDK run is no longer attachable, but the complete conversation and exact external tool results are present above.",
    "Continue the same task. Treat every completed tool call as already executed exactly once and do not repeat its external side effect.",
    "If you request an identical completed call, the host will replay its recorded result. Call only genuinely new tools if the task still requires them.",
    ...lines,
  ].join("\n\n");

  return {
    digest: digestJson({
      model: parsed.model,
      modelParams: parsed.modelParams,
      messages: parsed.messages,
      tools: parsed.tools,
      results: currentResults,
    }),
    prompt,
    completedResults,
  };
}

import { digestJson } from "../digest.js";
import type { Clock } from "../clock.js";
import type { SdkCustomTool, SdkCustomToolResult } from "../sdk/port.js";
import type { AnthropicTool } from "../protocols/anthropic/types.js";
import type { Session } from "./session.js";

export function mapClientTools(
  tools: AnthropicTool[],
  session: Session,
  clock: Clock,
  onExecute: (session: Session) => void,
  completedResults?: Map<string, SdkCustomToolResult[]>,
): Record<string, SdkCustomTool> {
  const mapped: Record<string, SdkCustomTool> = {};
  for (const tool of tools) {
    mapped[tool.sdk_name ?? tool.name] = {
      description: tool.description,
      inputSchema: tool.input_schema,
      async execute(args, context) {
        const completed = completedResults?.get(completedToolSignature(tool.name, args));
        const replay = completed?.shift();
        if (replay !== undefined) return replay;
        const call = session.createPending(
          tool.name,
          args,
          clock,
          context.toolCallId,
          tool.tool_kind,
          tool.namespace,
        );
        onExecute(session);
        if (session.pump) session.pump.notifyTool(call);
        else session.earlyCalls.push(call);
        return call.promise;
      },
    };
  }
  return mapped;
}

export function completedToolSignature(name: string, input: unknown): string {
  return digestJson({ name, input: input ?? {} });
}

export function resultDigest(toolUseId: string, content: string, isError: boolean): string {
  return digestJson({ tool_use_id: toolUseId, content, is_error: isError });
}

export function batchDigest(
  results: Array<{ toolUseId: string; content: string; isError: boolean }>,
): string {
  return digestJson(
    [...results]
      .sort((a, b) => a.toolUseId.localeCompare(b.toolUseId))
      .map((result) => ({
        tool_use_id: result.toolUseId,
        digest: resultDigest(result.toolUseId, result.content, result.isError),
      })),
  );
}

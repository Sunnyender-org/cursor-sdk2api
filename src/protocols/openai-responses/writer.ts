import { responseId } from "../../ids.js";
import type { TurnWriter, TurnWriterContext, TurnWriterFactory } from "../../core/turn-writer.js";
import { sendJson, sendOpenAIError } from "../../server/http-util.js";
import type { AnthropicContentBlock, AssistantTurn } from "../anthropic/types.js";
import {
  encodeFunctionCallItem,
  encodeMessageItem,
  encodeReasoningItem,
  encodeResponse,
  encodeInProgressResponse,
  functionCallItemId,
  reasoningItemId,
  textOf,
} from "./encode.js";
import { beginResponsesSse, writeResponsesEvent, writeResponsesStreamError } from "./sse.js";

export function createResponsesWriterFactory(): TurnWriterFactory {
  return (ctx) => new ResponsesTurnWriter(ctx);
}

class ResponsesTurnWriter implements TurnWriter {
  private started = false;
  private sequence = 0;
  private nextOutputIndex = 0;
  private reasoning?: StreamItem;
  private message?: StreamItem;
  private readonly id: string;
  private readonly createdAt: number;

  constructor(private readonly ctx: TurnWriterContext) {
    this.id = responseId(ctx.messageId);
    this.createdAt = Math.floor(ctx.session.createdAt / 1000);
  }

  onThinking(text: string): void {
    if (!this.ctx.stream || this.dead() || !text) return;
    this.ensureStart();
    const item = this.ensureReasoning();
    item.text += text;
    this.emit("response.reasoning_summary_text.delta", {
      item_id: item.itemId,
      output_index: item.outputIndex,
      summary_index: 0,
      delta: text,
    });
  }

  onText(text: string): void {
    if (!this.ctx.stream || this.dead() || !text) return;
    this.ensureStart();
    const item = this.ensureMessage();
    item.text += text;
    this.emit("response.output_text.delta", {
      item_id: item.itemId,
      output_index: item.outputIndex,
      content_index: 0,
      delta: text,
    });
  }

  finish(turn: AssistantTurn, extra?: { replayed?: boolean }): void {
    if (!this.ctx.stream) {
      if (!this.dead()) {
        sendJson(
          this.ctx.res,
          200,
          encodeResponse(turn, this.createdAt, extra?.replayed ? { replayed: true } : {}),
          this.ctx.requestId,
          { "x-cursor-session-id": turn.sessionId },
        );
      }
      return;
    }
    if (this.dead()) return;
    this.ensureStart();
    this.emitRemaining(turn);
    this.emit(
      "response.completed",
      {
        response: encodeResponse(turn, this.createdAt, extra?.replayed ? { replayed: true } : {}),
      },
    );
    this.ctx.res.end();
  }

  fail(error: unknown): void {
    if (this.dead()) return;
    if (this.ctx.stream && this.ctx.res.headersSent) {
      writeResponsesStreamError(this.ctx.res, error, this.ctx.requestId, this.sequence++);
      this.ctx.res.end();
      return;
    }
    sendOpenAIError(this.ctx.res, error, this.ctx.requestId);
  }

  private emitRemaining(turn: AssistantTurn): void {
    if (!this.reasoning) {
      const thinking = textOf(turn.blocks, "thinking");
      if (thinking) this.onThinking(thinking);
    }
    if (!this.message) {
      const text = textOf(turn.blocks, "text");
      if (text) this.onText(text);
    }
    this.finalizeItems();
    const tools = turn.blocks.filter(
      (block): block is Extract<AnthropicContentBlock, { type: "tool_use" }> => block.type === "tool_use",
    );
    for (const block of tools) this.emitFunctionCall(block);
  }

  private ensureReasoning(): StreamItem {
    if (this.reasoning) return this.reasoning;
    const outputIndex = this.nextOutputIndex++;
    const itemId = reasoningItemId(this.ctx.messageId);
    const item = { ...encodeReasoningItem(this.ctx.messageId, ""), summary: [] };
    this.emit("response.output_item.added", { output_index: outputIndex, item });
    this.emit("response.reasoning_summary_part.added", {
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    });
    this.reasoning = { outputIndex, itemId, text: "", done: false };
    return this.reasoning;
  }

  private ensureMessage(): StreamItem {
    if (this.message) return this.message;
    const outputIndex = this.nextOutputIndex++;
    const itemId = this.ctx.messageId;
    this.emit("response.output_item.added", {
      output_index: outputIndex,
      item: encodeMessageItem(itemId, "", "in_progress"),
    });
    this.emit("response.content_part.added", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    this.message = { outputIndex, itemId, text: "", done: false };
    return this.message;
  }

  private finalizeItems(): void {
    if (this.reasoning && !this.reasoning.done) this.closeReasoning(this.reasoning);
    if (this.message && !this.message.done) this.closeMessage(this.message);
  }

  private closeReasoning(open: StreamItem): void {
    this.emit("response.reasoning_summary_text.done", {
      item_id: open.itemId,
      output_index: open.outputIndex,
      summary_index: 0,
      text: open.text,
    });
    this.emit("response.reasoning_summary_part.done", {
      item_id: open.itemId,
      output_index: open.outputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: open.text },
    });
    this.emit("response.output_item.done", {
      output_index: open.outputIndex,
      item: encodeReasoningItem(this.ctx.messageId, open.text),
    });
    open.done = true;
  }

  private closeMessage(open: StreamItem): void {
    this.emit("response.output_text.done", {
      item_id: open.itemId,
      output_index: open.outputIndex,
      content_index: 0,
      text: open.text,
    });
    this.emit("response.content_part.done", {
      item_id: open.itemId,
      output_index: open.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: open.text, annotations: [] },
    });
    this.emit("response.output_item.done", {
      output_index: open.outputIndex,
      item: encodeMessageItem(open.itemId, open.text),
    });
    open.done = true;
  }

  private emitFunctionCall(block: Extract<AnthropicContentBlock, { type: "tool_use" }>): void {
    const outputIndex = this.nextOutputIndex++;
    const itemId = functionCallItemId(block.id);
    const argumentsJson = JSON.stringify(block.input ?? {});
    this.emit("response.output_item.added", {
      output_index: outputIndex,
      item: {
        ...encodeFunctionCallItem(block, "in_progress"),
        arguments: "",
      },
    });
    if (argumentsJson) {
      this.emit("response.function_call_arguments.delta", {
        item_id: itemId,
        output_index: outputIndex,
        delta: argumentsJson,
      });
    }
    this.emit("response.function_call_arguments.done", {
      item_id: itemId,
      output_index: outputIndex,
      name: block.name,
      arguments: argumentsJson,
    });
    this.emit("response.output_item.done", {
      output_index: outputIndex,
      item: encodeFunctionCallItem(block),
    });
  }

  private emit(event: string, data: Record<string, unknown>): void {
    if (this.dead()) return;
    writeResponsesEvent(this.ctx.res, event, data, this.sequence++);
  }

  private ensureStart(): void {
    if (this.started || this.dead()) return;
    this.started = true;
    beginResponsesSse(this.ctx.res, this.ctx.requestId, this.ctx.session.sessionId);
    const response = encodeInProgressResponse({
      id: this.id,
      createdAt: this.createdAt,
      model: this.ctx.session.modelId,
      sessionId: this.ctx.session.sessionId,
    });
    this.emit("response.created", { response });
    this.emit("response.in_progress", { response });
  }

  private dead(): boolean {
    return this.ctx.res.destroyed || this.ctx.res.writableEnded;
  }
}

interface StreamItem {
  outputIndex: number;
  itemId: string;
  text: string;
  done: boolean;
}

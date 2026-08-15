import { chatCompletionId } from "../../ids.js";
import type { TurnWriter, TurnWriterContext, TurnWriterFactory } from "../../core/turn-writer.js";
import { sendJson, sendOpenAIError } from "../../server/http-util.js";
import type { AnthropicContentBlock, AssistantTurn } from "../anthropic/types.js";
import { encodeChatChunk, encodeChatCompletion, encodeChatToolCall, encodeChatUsage, mapChatFinishReason } from "./encode.js";
import { beginChatSse, writeChatDone, writeChatFrame, writeChatStreamError } from "./sse.js";

export function createChatWriterFactory(options: { includeUsage: boolean }): TurnWriterFactory {
  return (ctx) => new ChatTurnWriter(ctx, options.includeUsage);
}

class ChatTurnWriter implements TurnWriter {
  private started = false;
  private roleSent = false;
  private emittedText = false;
  private emittedThinking = false;
  private readonly completionId: string;
  private readonly created: number;

  constructor(
    private readonly ctx: TurnWriterContext,
    private readonly includeUsage: boolean,
  ) {
    this.completionId = chatCompletionId(ctx.messageId);
    this.created = Math.floor(ctx.session.createdAt / 1000);
  }

  onThinking(text: string): void {
    if (!this.ctx.stream || this.dead() || !text) return;
    this.ensureStart();
    this.emittedThinking = true;
    this.writeDelta({ reasoning_content: text });
  }

  onText(text: string): void {
    if (!this.ctx.stream || this.dead() || !text) return;
    this.ensureStart();
    this.emittedText = true;
    this.writeDelta({ content: text });
  }

  finish(turn: AssistantTurn, extra?: { replayed?: boolean }): void {
    if (!this.ctx.stream) {
      if (!this.dead()) {
        sendJson(this.ctx.res, 200, encodeChatCompletion(turn, this.created, extra?.replayed ? { replayed: true } : {}), this.ctx.requestId, {
          "x-cursor-session-id": turn.sessionId,
        });
      }
      return;
    }
    if (this.dead()) return;
    this.ensureStart();
    this.emitRemaining(turn);
    writeChatFrame(
      this.ctx.res,
      encodeChatChunk({
        id: this.completionId,
        created: this.created,
        model: this.ctx.session.modelId,
        delta: {},
        finishReason: mapChatFinishReason(turn.stopReason),
        ...(extra?.replayed ? { extra: { replayed: true } } : {}),
      }),
    );
    if (this.includeUsage) {
      writeChatFrame(
        this.ctx.res,
        encodeChatChunk({
          id: this.completionId,
          created: this.created,
          model: this.ctx.session.modelId,
          emptyChoices: true,
          usage: encodeChatUsage(turn),
        }),
      );
    }
    writeChatDone(this.ctx.res);
    this.ctx.res.end();
  }

  fail(error: unknown): void {
    if (this.dead()) return;
    if (this.ctx.stream && this.ctx.res.headersSent) {
      writeChatStreamError(this.ctx.res, error, this.ctx.requestId);
      this.ctx.res.end();
      return;
    }
    sendOpenAIError(this.ctx.res, error, this.ctx.requestId);
  }

  private emitRemaining(turn: AssistantTurn): void {
    if (this.dead()) return;
    if (!this.emittedThinking) {
      const thinking = textOf(turn.blocks, "thinking");
      if (thinking) this.writeDelta({ reasoning_content: thinking });
    }
    if (!this.emittedText) {
      const text = textOf(turn.blocks, "text");
      if (text) this.writeDelta({ content: text });
    }
    const tools = turn.blocks.filter(
      (block): block is Extract<AnthropicContentBlock, { type: "tool_use" }> => block.type === "tool_use",
    );
    if (tools.length === 0) return;
    writeChatFrame(
      this.ctx.res,
      encodeChatChunk({
        id: this.completionId,
        created: this.created,
        model: this.ctx.session.modelId,
        delta: {
          tool_calls: tools.map((block, index) => ({
            index,
            ...encodeChatToolCall(block),
          })),
        },
      }),
    );
  }

  private writeDelta(delta: Record<string, unknown>): void {
    writeChatFrame(
      this.ctx.res,
      encodeChatChunk({
        id: this.completionId,
        created: this.created,
        model: this.ctx.session.modelId,
        delta,
      }),
    );
  }

  private ensureStart(): void {
    if (this.dead()) return;
    if (!this.started) {
      this.started = true;
      beginChatSse(this.ctx.res, this.ctx.requestId, this.ctx.session.sessionId);
    }
    if (this.roleSent) return;
    this.roleSent = true;
    this.writeDelta({ role: "assistant" });
  }

  private dead(): boolean {
    return this.ctx.res.destroyed || this.ctx.res.writableEnded;
  }
}

function textOf(blocks: AnthropicContentBlock[], type: "text" | "thinking"): string {
  return blocks
    .filter((block) => block.type === type)
    .map((block) => (block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : ""))
    .join("");
}

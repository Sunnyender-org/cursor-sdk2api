import type { TurnWriter, TurnWriterContext } from "../../core/turn-writer.js";
import { sendError, sendJson } from "../../server/http-util.js";
import { encodeMessage } from "./encode.js";
import {
  beginSse,
  writeBlockStop,
  writeMessageStart,
  writeMessageStop,
  writeCompletedTurn,
  writeSseError,
  writeTextDelta,
  writeThinkingDelta,
  writeToolUse,
} from "./sse.js";
import type { AssistantTurn } from "./types.js";

export function createAnthropicWriter(ctx: TurnWriterContext): TurnWriter {
  return new AnthropicTurnWriter(ctx);
}

class AnthropicTurnWriter implements TurnWriter {
  private started = false;
  private nextIndex = 0;
  private open?: { kind: "thinking" | "text"; index: number };
  private emitted = new Set<"thinking" | "text">();

  constructor(private readonly ctx: TurnWriterContext) {}

  onThinking(text: string): void {
    if (!this.ctx.stream || this.dead()) return;
    this.ensureStart();
    this.openBlock("thinking");
    if (text && this.open) writeThinkingDelta(this.ctx.res, this.open.index, text, true);
  }

  onText(text: string): void {
    if (!this.ctx.stream || this.dead()) return;
    this.ensureStart();
    this.openBlock("text");
    if (text && this.open) writeTextDelta(this.ctx.res, this.open.index, text, true);
  }

  finish(turn: AssistantTurn, extra?: { replayed?: boolean }): void {
    if (!this.ctx.stream) {
      if (!this.dead()) {
        sendJson(
          this.ctx.res,
          200,
          encodeMessage(turn, extra?.replayed ? { replayed: true } : {}),
          this.ctx.requestId,
          { "x-cursor-session-id": turn.sessionId },
        );
      }
      return;
    }
    if (this.dead()) return;
    if (extra?.replayed) {
      writeCompletedTurn(this.ctx.res, turn, this.ctx.requestId);
      return;
    }
    this.ensureStart();
    this.closeOpen();
    for (const block of turn.blocks) {
      if (block.type === "thinking" && !this.emitted.has("thinking")) {
        const index = this.nextIndex++;
        writeThinkingDelta(this.ctx.res, index, block.thinking, false);
        writeBlockStop(this.ctx.res, index);
        this.emitted.add("thinking");
      } else if (block.type === "text" && !this.emitted.has("text")) {
        const index = this.nextIndex++;
        writeTextDelta(this.ctx.res, index, block.text, false);
        writeBlockStop(this.ctx.res, index);
        this.emitted.add("text");
      } else if (block.type === "tool_use") {
        writeToolUse(this.ctx.res, this.nextIndex++, block);
      }
    }
    writeMessageStop(this.ctx.res, turn);
    this.ctx.res.end();
  }

  fail(error: unknown): void {
    if (this.dead()) return;
    if (this.ctx.stream && this.ctx.res.headersSent) {
      writeSseError(this.ctx.res, error);
      this.ctx.res.end();
      return;
    }
    sendError(this.ctx.res, error, this.ctx.requestId);
  }

  private openBlock(kind: "thinking" | "text"): void {
    if (this.open?.kind === kind) return;
    this.closeOpen();
    const index = this.nextIndex++;
    if (kind === "thinking") writeThinkingDelta(this.ctx.res, index, "", false);
    else writeTextDelta(this.ctx.res, index, "", false);
    this.open = { kind, index };
    this.emitted.add(kind);
  }

  private closeOpen(): void {
    if (!this.open || this.dead()) {
      this.open = undefined;
      return;
    }
    writeBlockStop(this.ctx.res, this.open.index);
    this.open = undefined;
  }

  private ensureStart(): void {
    if (this.started || this.dead()) return;
    this.started = true;
    beginSse(this.ctx.res, this.ctx.requestId, this.ctx.session.sessionId);
    writeMessageStart(this.ctx.res, {
      messageId: this.ctx.messageId,
      model: this.ctx.session.modelId,
      sessionId: this.ctx.session.sessionId,
    });
  }

  private dead(): boolean {
    return this.ctx.res.destroyed || this.ctx.res.writableEnded;
  }
}

import type { Clock } from "../clock.js";
import { emptyTurn, sdkFailure, timeoutError, upstreamError } from "../errors.js";
import { messageId } from "../ids.js";
import type { AnthropicContentBlock, AssistantTurn } from "../protocols/anthropic/types.js";
import type { SdkDeltaUpdate, SdkRun, SdkStreamEvent } from "../sdk/port.js";
import { deferredUsage, fromSdkUsage } from "./usage.js";
import type { PendingCall, Session } from "./session.js";

export type PumpBoundary =
  | { type: "tools"; turn: AssistantTurn }
  | { type: "final"; turn: AssistantTurn }
  | { type: "error"; error: unknown };

export type DeltaRecord = { kind: "text" | "thinking"; text: string };

export interface ResponseSink {
  onThinking?(text: string): void;
  onText?(text: string): void;
  onBoundary?(boundary: PumpBoundary): void;
}

export class EventPump {
  private readonly sinks = new Set<ResponseSink>();
  private openBatch: PendingCall[] = [];
  private settleGeneration = 0;
  private boundaryWaiters: Array<(boundary: PumpBoundary) => void> = [];
  private finished = false;
  private consumer: Promise<void> | undefined;
  private firstEvent = false;
  private text = "";
  private thinking = "";
  private error: unknown;
  /** Current response-segment boundary. All same-segment waiters read this. */
  private publishedBoundary?: PumpBoundary;
  /** Deltas for the current HTTP response segment. Replayed to every attach. */
  private readonly deltaHistory: DeltaRecord[] = [];
  /** Once official onDelta is seen, ignore stream assistant/thinking snapshots. */
  private preferOnDelta = false;
  private segmentMessageId = messageId();

  constructor(
    private readonly session: Session,
    private readonly run: SdkRun,
    private readonly clock: Clock,
    private readonly settleMs: number,
    private readonly firstEventTimeoutMs: number,
  ) {}

  start(): void {
    if (this.consumer) return;
    this.consumer = this.loop();
  }

  attach(sink: ResponseSink): void {
    this.sinks.add(sink);
    for (const delta of this.deltaHistory) {
      if (delta.kind === "thinking") sink.onThinking?.(delta.text);
      else sink.onText?.(delta.text);
    }
  }

  detach(sink: ResponseSink): void {
    this.sinks.delete(sink);
  }

  /**
   * Start a new HTTP response segment. Only the first real tool_result
   * continuation (awaiting -> resuming) should call this.
   */
  beginNextSegment(): void {
    this.publishedBoundary = undefined;
    this.error = undefined;
    this.deltaHistory.length = 0;
    this.boundaryWaiters = [];
    this.text = "";
    this.thinking = "";
    this.segmentMessageId = messageId();
  }

  currentMessageId(): string {
    return this.segmentMessageId;
  }

  notifyTool(call: PendingCall): void {
    if (this.publishedBoundary?.type === "tools") {
      call.resolved = true;
      const error = upstreamError("SDK emitted a tool call after the assistant tool batch closed");
      call.reject(error);
      this.session.state = "failed";
      void this.run.cancel().catch(() => undefined);
      this.fail(error);
      return;
    }
    this.firstEvent = true;
    this.session.hasSemanticOutput = true;
    this.session.sawToolBatch = true;
    this.openBatch.push(call);
    const generation = ++this.settleGeneration;
    const flush = () => {
      if (generation !== this.settleGeneration || this.finished) return;
      this.flushToolBatch();
    };
    if (this.settleMs <= 0) {
      queueMicrotask(flush);
      return;
    }
    void this.clock.sleep(this.settleMs).then(flush);
  }

  waitForBoundary(): Promise<PumpBoundary> {
    if (this.publishedBoundary) {
      return Promise.resolve(this.publishedBoundary);
    }
    return new Promise((resolve) => {
      this.boundaryWaiters.push(resolve);
    });
  }

  ingestEarly(calls: PendingCall[]): void {
    for (const call of calls) this.notifyTool(call);
  }

  ingestDelta(update: SdkDeltaUpdate): void {
    if (update.type === "turn-ended") {
      this.firstEvent = true;
      // Per-turn usage is diagnostic only. Cumulative usage is confirmed via run.wait().
      return;
    }
    if (update.type !== "text-delta" && update.type !== "thinking-delta") return;
    if (!update.text) return;
    this.preferOnDelta = true;
    this.firstEvent = true;
    this.session.hasSemanticOutput = true;
    if (update.type === "thinking-delta") {
      this.thinking += update.text;
      this.deltaHistory.push({ kind: "thinking", text: update.text });
      for (const sink of this.sinks) sink.onThinking?.(update.text);
      return;
    }
    this.text += update.text;
    this.deltaHistory.push({ kind: "text", text: update.text });
    for (const sink of this.sinks) sink.onText?.(update.text);
  }

  ingestDeltas(updates: SdkDeltaUpdate[]): void {
    for (const update of updates) this.ingestDelta(update);
  }

  private async loop(): Promise<void> {
    const firstTimer = this.clock.sleep(this.firstEventTimeoutMs).then(() => {
      if (!this.firstEvent && !this.finished) {
        this.fail(timeoutError("Timed out waiting for the first SDK event"));
      }
    });
    try {
      for await (const event of this.run.stream()) {
        this.firstEvent = true;
        this.handle(event);
      }
      // Stream EOF is progress; do not empty-fail before wait().
      this.firstEvent = true;
      const result = await this.run.wait();
      if (this.finished) return;
      if (result.status === "error") {
        this.fail(sdkFailure(result.error?.message ?? "SDK run error"));
        return;
      }
      if (result.status === "cancelled") {
        this.fail(upstreamError("SDK run cancelled", 499));
        return;
      }
      const finalText = result.result || this.text;
      if (!finalText && !this.thinking && !this.session.sawToolBatch) {
        this.fail(emptyTurn());
        return;
      }
      if (!this.session.usageConfirmed) {
        this.session.usageConfirmed = true;
      }
      const blocks: AnthropicContentBlock[] = [];
      if (this.thinking) blocks.push({ type: "thinking", thinking: this.thinking });
      if (finalText) blocks.push({ type: "text", text: finalText });
      if (blocks.length === 0) {
        this.fail(emptyTurn());
        return;
      }
      this.session.hasSemanticOutput = true;
      this.publish({
        type: "final",
        turn: {
          messageId: this.segmentMessageId,
          sessionId: this.session.sessionId,
          model: this.session.modelId,
          stopReason: "end_turn",
          blocks,
          usage: fromSdkUsage(result.usage),
        },
      });
    } catch (error) {
      this.fail(sdkFailure(error));
    } finally {
      this.finished = true;
      void firstTimer;
    }
  }

  private handle(event: SdkStreamEvent): void {
    if (this.preferOnDelta && (event.type === "thinking" || event.type === "assistant")) {
      return;
    }
    if (event.type === "thinking" && event.text) {
      this.thinking += event.text;
      this.session.hasSemanticOutput = true;
      this.deltaHistory.push({ kind: "thinking", text: event.text });
      for (const sink of this.sinks) sink.onThinking?.(event.text);
      return;
    }
    if (event.type === "assistant" && event.text) {
      this.text += event.text;
      this.session.hasSemanticOutput = true;
      this.deltaHistory.push({ kind: "text", text: event.text });
      for (const sink of this.sinks) sink.onText?.(event.text);
    }
  }

  private flushToolBatch(): void {
    if (this.openBatch.length === 0 || this.finished) return;
    const batch = this.openBatch;
    this.openBatch = [];
    const blocks: AnthropicContentBlock[] = [];
    if (this.thinking) blocks.push({ type: "thinking", thinking: this.thinking });
    if (this.text) blocks.push({ type: "text", text: this.text });
    this.thinking = "";
    this.text = "";
    for (const call of batch) {
      blocks.push({
        type: "tool_use",
        id: call.toolUseId,
        name: call.name,
        input: call.input,
      });
    }
    this.publish({
      type: "tools",
      turn: {
        messageId: this.segmentMessageId,
        sessionId: this.session.sessionId,
        model: this.session.modelId,
        stopReason: "tool_use",
        blocks,
        usage: deferredUsage(),
      },
    });
  }

  private fail(error: unknown): void {
    this.error = error;
    this.publish({ type: "error", error });
  }

  private publish(boundary: PumpBoundary): void {
    if (boundary.type === "final") this.finished = true;
    this.publishedBoundary = boundary;
    const waiters = this.boundaryWaiters;
    this.boundaryWaiters = [];
    for (const waiter of waiters) waiter(boundary);
    for (const sink of this.sinks) sink.onBoundary?.(boundary);
  }
}

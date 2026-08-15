import type { ServerResponse } from "node:http";
import type { AssistantTurn } from "../protocols/anthropic/types.js";
import type { ResponseSink } from "./event-pump.js";
import type { Session } from "./session.js";

export interface TurnWriter extends ResponseSink {
  finish(turn: AssistantTurn, extra?: { replayed?: boolean }): void;
  fail(error: unknown): void;
}

export interface TurnWriterContext {
  res: ServerResponse;
  requestId: string;
  session: Session;
  stream: boolean;
  messageId: string;
}

export type TurnWriterFactory = (ctx: TurnWriterContext) => TurnWriter;

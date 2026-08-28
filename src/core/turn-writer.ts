import type { ServerResponse } from "node:http";
import type { AssistantTurn } from "../protocols/anthropic/types.js";
import type { ResponseSink } from "./event-pump.js";
import type { Session } from "./session.js";

export interface TurnWriter extends ResponseSink {
  finish(turn: AssistantTurn, extra?: { replayed?: boolean }): void;
  fail(error: unknown): void;
}

export type TurnWriterSession = Pick<Session, "sessionId" | "modelId" | "createdAt">;

export interface TurnWriterContext {
  res: ServerResponse;
  requestId: string;
  session: TurnWriterSession;
  stream: boolean;
  messageId: string;
}

export type TurnWriterFactory = (ctx: TurnWriterContext) => TurnWriter;

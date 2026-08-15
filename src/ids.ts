import { randomUUID } from "node:crypto";

export function requestId(): string {
  return `req_${randomUUID()}`;
}

export function messageId(): string {
  return `msg_${randomUUID()}`;
}

export function chatCompletionId(fromMessageId?: string): string {
  if (fromMessageId?.startsWith("msg_")) return `chatcmpl_${fromMessageId.slice(4)}`;
  if (fromMessageId?.startsWith("chatcmpl_")) return fromMessageId;
  return `chatcmpl_${randomUUID()}`;
}

export function responseId(fromMessageId?: string): string {
  if (fromMessageId?.startsWith("msg_")) return `resp_${fromMessageId.slice(4)}`;
  if (fromMessageId?.startsWith("resp_")) return fromMessageId;
  return `resp_${randomUUID()}`;
}

export function sessionId(): string {
  return `ses_${randomUUID()}`;
}

export function toolUseId(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit;
  return `toolu_${randomUUID()}`;
}

export function instanceId(configured?: string): string {
  return configured && configured.trim() ? configured.trim() : `inst_${randomUUID()}`;
}

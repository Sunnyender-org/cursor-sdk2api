export type GatewayErrorCode =
  | "invalid_request"
  | "authentication_error"
  | "forbidden"
  | "cursor_session_conflict"
  | "cursor_session_lost"
  | "rate_limited"
  | "cursor_empty_turn"
  | "cursor_upstream_error"
  | "cursor_timeout"
  | "client_closed"
  | "not_found";

export class GatewayError extends Error {
  readonly httpStatus: number;
  readonly code: GatewayErrorCode;
  readonly requestId?: string;

  constructor(
    code: GatewayErrorCode,
    message: string,
    httpStatus: number,
    requestId?: string,
  ) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
  }
}

export function invalidRequest(message: string): GatewayError {
  const status = /mixed|tool_result|schema|must/i.test(message) ? 422 : 400;
  return new GatewayError("invalid_request", message, status);
}

export function authenticationError(message = "Missing or invalid credential"): GatewayError {
  return new GatewayError("authentication_error", message, 401);
}

export function forbiddenError(message: string): GatewayError {
  return new GatewayError("forbidden", message, 403);
}

export function sessionConflict(message: string): GatewayError {
  return new GatewayError("cursor_session_conflict", message, 409);
}

export function sessionLost(message: string): GatewayError {
  return new GatewayError("cursor_session_lost", message, 409);
}

export function rateLimited(message: string): GatewayError {
  return new GatewayError("rate_limited", message, 429);
}

export function emptyTurn(message = "SDK finished without text, thinking, tool use, or an explicit error"): GatewayError {
  return new GatewayError("cursor_empty_turn", message, 502);
}

export function upstreamError(message: string, status = 502): GatewayError {
  return new GatewayError("cursor_upstream_error", message, status);
}

function stringProperty(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : "";
}

// Upper-cased `aiserver.v1.ErrorDetails` names and Connect codes the SDK maps to AuthenticationError and RateLimitError.
const SDK_AUTH_CODES = new Set([
  "NOT_LOGGED_IN",
  "INVALID_AUTH_ID",
  "NOT_HIGH_ENOUGH_PERMISSIONS",
  "AGENT_REQUIRES_LOGIN",
  "AUTH_TOKEN_NOT_FOUND",
  "AUTH_TOKEN_EXPIRED",
  "UNAUTHORIZED",
  "UNAUTHENTICATED",
]);

const SDK_RATE_LIMIT_CODES = new Set([
  "API_KEY_RATE_LIMIT",
  "FREE_USER_RATE_LIMIT_EXCEEDED",
  "FREE_USER_USAGE_LIMIT",
  "GENERIC_RATE_LIMIT_EXCEEDED",
  "GPT_4_VISION_PREVIEW_RATE_LIMIT",
  "OPENAI_RATE_LIMIT_EXCEEDED",
  "PRO_USER_RATE_LIMIT_EXCEEDED",
  "PRO_USER_USAGE_LIMIT",
  "RATE_LIMITED",
  "RATE_LIMITED_CHANGEABLE",
  "RESOURCE_EXHAUSTED",
]);

export function sdkFailure(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const name = error instanceof Error ? error.name : "";
  const code = stringProperty(error, "code").toUpperCase();
  const message = redactSecrets(
    error && typeof error === "object" ? stringProperty(error, "message") || "SDK error" : String(error ?? "SDK error"),
  );
  // The SDK's own code outranks whatever prose an upstream error happens to carry.
  if (SDK_AUTH_CODES.has(code)) return authenticationError(message);
  if (SDK_RATE_LIMIT_CODES.has(code)) return rateLimited(message);
  if (/AuthenticationError/i.test(name)) return authenticationError(message);
  if (/RateLimitError/i.test(name)) return rateLimited(message);
  if (
    /unauthenticated|invalid api key|invalid credential|not[ _-]?logged[ _-]?in|logging out and back in/i.test(
      `${code} ${message}`,
    )
  ) {
    return authenticationError(message);
  }
  if (/rate.?limit|resource_exhausted/i.test(`${code} ${message}`)) return rateLimited(message);
  if (/not supported in your region|model not available|permission|forbidden|not allowed/i.test(message)) {
    return forbiddenError(message);
  }
  return upstreamError(message);
}

export function timeoutError(message: string): GatewayError {
  return new GatewayError("cursor_timeout", message, 504);
}

export function notFound(message = "Not found"): GatewayError {
  return new GatewayError("not_found", message, 404);
}

export function openaiErrorType(code: string): string {
  switch (code) {
    case "invalid_request":
    case "not_found":
      return "invalid_request_error";
    case "authentication_error":
      return "authentication_error";
    case "forbidden":
      return "permission_error";
    case "rate_limited":
      return "rate_limit_error";
    default:
      return "api_error";
  }
}

export function toOpenAIErrorBody(
  error: unknown,
  requestId: string,
): {
  error: { message: string; type: string; param: null; code: string };
} {
  const publicBody = toPublicErrorBody(error, requestId);
  return {
    error: {
      message: publicBody.error.message,
      type: openaiErrorType(publicBody.error.type),
      param: null,
      code: publicBody.error.type,
    },
  };
}

export function toPublicErrorBody(error: unknown, requestId: string): {
  type: "error";
  error: { type: string; message: string };
  request_id: string;
} {
  if (error instanceof GatewayError) {
    return {
      type: "error",
      error: { type: error.code, message: redactSecrets(error.message) },
      request_id: requestId,
    };
  }
  return {
    type: "error",
    error: {
      type: "cursor_upstream_error",
      message: redactSecrets(error instanceof Error ? error.message : "Unexpected error"),
    },
    request_id: requestId,
  };
}

export function httpStatusOf(error: unknown): number {
  if (error instanceof GatewayError) return error.httpStatus;
  return 502;
}

const SECRET_LIKE =
  /(sk-[A-Za-z0-9_-]{8,})|(Bearer\s+\S+)|(api[_-]?key["'\s:=]+)[^\s"',}]+/gi;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

export function redactSecrets(text: string): string {
  return text.replace(URL_CREDENTIALS, "$1[redacted]@").replace(SECRET_LIKE, "[redacted]");
}

import { expect, test } from "vitest";
import { sdkFailure } from "../../src/errors.js";

const STALE_SDK_AUTH = "Authentication error If you are logged in, try logging out and back in.";

test("SDK rate-limit codes outrank auth-like message text", () => {
  for (const code of ["FREE_USER_USAGE_LIMIT", "PRO_USER_USAGE_LIMIT", "RESOURCE_EXHAUSTED"]) {
    const error = sdkFailure({ code, message: STALE_SDK_AUTH });
    expect(error.code).toBe("rate_limited");
    expect(error.httpStatus).toBe(429);
  }
});

test("an SDK auth code outranks rate-limit message text", () => {
  const error = sdkFailure({ code: "AUTH_TOKEN_EXPIRED", message: "resource_exhausted: rate limit reached" });
  expect(error.code).toBe("authentication_error");
  expect(error.httpStatus).toBe(401);
});

test("an unrecognised code still falls back to the message heuristics", () => {
  expect(sdkFailure({ code: "BAD_API_KEY", message: "invalid api key" }).code).toBe("authentication_error");
  expect(sdkFailure({ code: "unknown", message: "provider connection reset" }).code).toBe("cursor_upstream_error");
});

test("an SDK error name outranks message text when no code matches", () => {
  const error = sdkFailure(Object.assign(new Error("invalid api key"), { name: "RateLimitError" }));
  expect(error.code).toBe("rate_limited");
  expect(error.httpStatus).toBe(429);
});

test("lowercase Connect codes classify like their ErrorDetails names", () => {
  expect(sdkFailure({ code: "resource_exhausted", message: STALE_SDK_AUTH }).code).toBe("rate_limited");
  expect(sdkFailure({ code: "unauthenticated", message: "rate limit reached" }).code).toBe("authentication_error");
});

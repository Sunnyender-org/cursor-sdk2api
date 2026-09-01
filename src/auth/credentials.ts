import type { IncomingMessage } from "node:http";
import { authenticationError } from "../errors.js";
import { credentialFingerprint } from "../digest.js";
import type { GatewayConfig } from "../config.js";
import type { RuntimeProfile } from "../core/runtime-profile.js";
import { headerValue } from "../server/http-util.js";

export interface AuthContext {
  mode: "byok" | "managed";
  cursorApiKey: string;
  fingerprint: string;
  defaultProfile?: RuntimeProfile;
}

export type ClientAuthorization =
  | { mode: "byok"; auth: AuthContext }
  | { mode: "managed" };

export function authorizeClient(req: IncomingMessage, config: GatewayConfig): ClientAuthorization {
  const presented = presentedSecret(req);
  if (!presented) {
    throw authenticationError("Provide Authorization: Bearer or x-api-key");
  }

  if (config.authMode === "managed") {
    if (!config.gatewayAccessKey) {
      throw authenticationError("Managed auth is not configured");
    }
    if (presented !== config.gatewayAccessKey) {
      throw authenticationError("Invalid gateway access key");
    }
    return { mode: "managed" };
  }

  return {
    mode: "byok",
    auth: {
      mode: "byok",
      cursorApiKey: presented,
      fingerprint: credentialFingerprint(presented),
    },
  };
}

export function managedAccountAuth(apiKey: string, defaultProfile?: RuntimeProfile): AuthContext {
  return {
    mode: "managed",
    cursorApiKey: apiKey,
    fingerprint: credentialFingerprint(apiKey),
    ...(defaultProfile ? { defaultProfile } : {}),
  };
}

function presentedSecret(req: IncomingMessage): string | undefined {
  const apiKey = headerValue(req, "x-api-key");
  if (apiKey) return apiKey.trim();
  const authorization = headerValue(req, "authorization");
  if (!authorization) return undefined;
  const match = /^Bearer\s+(\S+)/i.exec(authorization);
  return match?.[1];
}

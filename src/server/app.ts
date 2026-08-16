import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authenticate } from "../auth/credentials.js";
import { readAccount } from "../account/service.js";
import type { Clock } from "../clock.js";
import type { GatewayConfig } from "../config.js";
import { RunCoordinator } from "../core/run-coordinator.js";
import type { PumpBoundary } from "../core/event-pump.js";
import { LineageStore } from "../core/lineage-store.js";
import { SessionRegistry } from "../core/session-registry.js";
import { GatewayError, invalidRequest, notFound, redactSecrets, toPublicErrorBody } from "../errors.js";
import { requestId as newRequestId } from "../ids.js";
import type { Logger } from "../log.js";
import { parseMessagesRequest } from "../protocols/anthropic/parse.js";
import { estimateAnthropicInputTokens } from "../protocols/anthropic/count-tokens.js";
import { writeSseError } from "../protocols/anthropic/sse.js";
import { parseChatCompletionsRequest } from "../protocols/openai-chat/parse.js";
import { writeChatStreamError } from "../protocols/openai-chat/sse.js";
import { createChatWriterFactory } from "../protocols/openai-chat/writer.js";
import { parseResponsesRequest } from "../protocols/openai-responses/parse.js";
import { writeResponsesStreamError } from "../protocols/openai-responses/sse.js";
import { createResponsesWriterFactory } from "../protocols/openai-responses/writer.js";
import type { SdkRuntime } from "../sdk/port.js";
import { ModelCatalog } from "../sdk/catalog.js";
import { headerValue, readJsonBody, requestPath, sendError, sendJson, sendOpenAIError } from "./http-util.js";
import { serveConsole } from "./console.js";

export interface App {
  config: GatewayConfig;
  registry: SessionRegistry;
  coordinator: RunCoordinator;
  catalog: ModelCatalog;
  lineage: LineageStore;
  sdk: SdkRuntime;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  listen(): Server;
  beginShutdown(): void;
}

export function createApp(input: {
  config: GatewayConfig;
  sdk: SdkRuntime;
  clock: Clock;
  logger: Logger;
  workspaceDir: string;
  beforeApplyBoundary?: (boundary: PumpBoundary) => Promise<void>;
}): App {
  const { config, sdk, clock, logger, workspaceDir, beforeApplyBoundary } = input;
  const registry = new SessionRegistry(clock, config.instanceId, {
    globalActiveRuns: config.globalActiveRuns,
    perCredentialActiveRuns: config.perCredentialActiveRuns,
    maxAwaitingSessions: config.maxAwaitingSessions,
    sessionTtlMs: config.sessionTtlMs,
    replayTtlMs: config.replayTtlMs,
    runDeadlineMs: config.runDeadlineMs,
  });
  const lineage = new LineageStore(config.stateDir, clock);
  const coordinator = new RunCoordinator({
    config,
    sdk,
    registry,
    clock,
    logger,
    workspaceDir,
    lineage,
    beforeApplyBoundary,
  });
  const catalog = new ModelCatalog(sdk, clock, config.catalogCacheMs);
  let shuttingDown = false;
  const sweepTimer = setInterval(() => {
    try {
      registry.sweep();
      lineage.sweep();
    } catch {
      // sweep must not crash the process
    }
  }, Math.max(20, config.sweepIntervalMs));
  sweepTimer.unref();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestId = headerValue(req, "x-request-id") || newRequestId();
    const path = requestPath(req);
    const method = (req.method ?? "GET").toUpperCase();
    try {
      if (
        (method === "GET" || method === "HEAD") &&
        serveConsole(res, path, requestId, config.consoleDir, method === "HEAD")
      ) {
        return;
      }

      if (method === "GET" && path === "/health") {
        sendJson(
          res,
          200,
          {
            status: shuttingDown ? "not_ready" : "ok",
            service: "cursor-sdk2api",
            version: config.version,
            sdk_version:
              sdk.sdkVersion && sdk.sdkVersion !== "unavailable" ? sdk.sdkVersion : config.sdkVersion,
            network: {
              proxy_configured: config.proxyConfigured,
              agent_transport: config.agentTransport,
              fetch_transport: config.fetchTransport,
            },
            runtime: "local",
            instance_id: config.instanceId,
            readiness: {
              accepting_sessions: !shuttingDown && !registry.shuttingDown,
              shutting_down: shuttingDown,
            },
            capabilities: {
              ...config.capabilities,
              agent_resume: config.capabilities.agent_resume,
              pending_tool_restart_resume: config.capabilities.pending_tool_restart_resume,
              store_backend: config.capabilities.store_backend ?? "jsonl",
            },
            verification: {
              live_smoke: false,
              chat_completions: "contract_tested_unverified_live",
              responses: "contract_tested_unverified_live",
              streaming: "sdk_onDelta",
              thinking: "implemented_unverified_live",
              images: "implemented_unverified_live",
              parallel_tools: "implemented_unverified_live",
            },
          },
          requestId,
        );
        return;
      }

      if (method === "GET" && path === "/v1/models") {
        const auth = authenticate(req, config);
        const listed = await catalog.list(auth.cursorApiKey, auth.fingerprint);
        sendJson(
          res,
          listed.status === "unavailable" ? 200 : 200,
          {
            object: "list",
            data: listed.models.map((model) => ({
              id: model.id,
              object: "model",
              display_name: model.displayName,
              description: model.description,
              parameters: model.parameters,
              variants: model.variants,
            })),
            status: listed.status,
            ...(listed.reason ? { reason: listed.reason } : {}),
            cache: listed.stale
              ? { stale: true, reason: listed.reason ?? "refresh_failed" }
              : { stale: false },
          },
          requestId,
        );
        return;
      }

      if (method === "GET" && path === "/v1/account") {
        const auth = authenticate(req, config);
        const account = await readAccount(sdk, auth.cursorApiKey);
        sendJson(res, 200, account, requestId);
        return;
      }

      if (method === "POST" && path === "/v1/messages/count_tokens") {
        authenticate(req, config);
        const body = await readJsonBody(req, config.maxBodyBytes);
        if (body === undefined) throw invalidRequest("JSON body is required");
        const parsed = parseMessagesRequest(body);
        res.setHeader("x-cursor-sdk2api-token-count", "estimated");
        sendJson(res, 200, { input_tokens: estimateAnthropicInputTokens(body, parsed) }, requestId);
        return;
      }

      if (method === "POST" && path === "/v1/messages") {
        const auth = authenticate(req, config);
        const body = await readJsonBody(req, config.maxBodyBytes);
        if (body === undefined) throw invalidRequest("JSON body is required");
        const parsed = parseMessagesRequest(body);
        const sessionHint = headerValue(req, "x-cursor-session-id");
        await coordinator.handleMessages(req, res, auth, parsed, requestId, sessionHint);
        return;
      }

      if (method === "POST" && path === "/v1/chat/completions") {
        const auth = authenticate(req, config);
        const body = await readJsonBody(req, config.maxBodyBytes);
        if (body === undefined) throw invalidRequest("JSON body is required");
        const chat = parseChatCompletionsRequest(body);
        const sessionHint = headerValue(req, "x-cursor-session-id");
        await coordinator.handleMessages(
          req,
          res,
          auth,
          chat.parsed,
          requestId,
          sessionHint,
          createChatWriterFactory({ includeUsage: chat.includeUsage }),
        );
        return;
      }

      if (method === "POST" && path === "/v1/responses") {
        const auth = authenticate(req, config);
        const body = await readJsonBody(req, config.maxBodyBytes);
        if (body === undefined) throw invalidRequest("JSON body is required");
        const responses = parseResponsesRequest(body);
        const sessionHint = headerValue(req, "x-cursor-session-id");
        await coordinator.handleMessages(
          req,
          res,
          auth,
          responses.parsed,
          requestId,
          sessionHint,
          createResponsesWriterFactory(),
        );
        return;
      }

      throw notFound(`No route for ${method} ${path}`);
    } catch (error) {
      logger.warn(
        {
          request_id: requestId,
          path,
          method,
          status: error instanceof GatewayError ? error.httpStatus : 502,
          error_type: error instanceof GatewayError ? error.code : "cursor_upstream_error",
          error: redactSecrets(error instanceof Error ? error.message : String(error ?? "Unexpected error")),
        },
        "request failed",
      );
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        if (path === "/v1/chat/completions") writeChatStreamError(res, error, requestId);
        else if (path === "/v1/responses") writeResponsesStreamError(res, error, requestId);
        else writeSseError(res, toPublicErrorBody(error, requestId));
        res.end();
        return;
      }
      if (path === "/v1/chat/completions" || path === "/v1/responses") sendOpenAIError(res, error, requestId);
      else sendError(res, error, requestId);
    }
  };

  return {
    config,
    registry,
    coordinator,
    catalog,
    lineage,
    sdk,
    handler,
    listen() {
      const server = createServer((req, res) => {
        void handler(req, res);
      });
      server.listen(config.port, config.host);
      return server;
    },
    beginShutdown() {
      shuttingDown = true;
      clearInterval(sweepTimer);
      registry.beginShutdown();
    },
  };
}

#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { SystemClock } from "./clock.js";
import { createLogger } from "./log.js";
import { createApp } from "./server/app.js";
import { createCursorRuntime } from "./sdk/cursor-runtime.js";
import { ensureEmptyWorkspace } from "./sdk/empty-workspace.js";
import { configureSdkOutboundProxy } from "./sdk/proxy.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const proxy = configureSdkOutboundProxy();
const sdk = createCursorRuntime({ stateDir: config.stateDir });
const workspaceDir = ensureEmptyWorkspace(config.instanceId, config.emptyWorkspaceDir);
const app = createApp({
  config,
  sdk,
  clock: new SystemClock(),
  logger,
  workspaceDir,
});

const server = app.listen();
logger.info(
  {
    host: config.host,
    port: config.port,
    auth_mode: config.authMode,
    instance_id: config.instanceId,
    sdk_version: sdk.sdkVersion,
    proxy_configured: proxy.configured,
    agent_transport: proxy.agentTransport,
    fetch_transport: proxy.fetchTransport,
  },
  "cursor-sdk2api listening",
);

const shutdown = async (signal: string) => {
  logger.info({ signal }, "draining");
  app.beginShutdown();
  await app.coordinator.drain(config.runDeadlineMs);
  app.close();
  server.close(() => {
    logger.info({}, "shutdown complete");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

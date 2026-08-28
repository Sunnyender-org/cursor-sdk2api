import { createRequire } from "node:module";
import { join } from "node:path";
import { Agent, Cursor, JsonlLocalAgentStore, type Run, type SDKAgent } from "@cursor/sdk";
import {
  AMBIENT_DISALLOWED_TOOLS,
  apiProfileToolAllowlist,
  type CreateAgentInput,
  type ResumeAgentInput,
  type SdkAccountResult,
  type SdkAgent,
  type SdkCatalogResult,
  type SdkCustomTool,
  type SdkRun,
  type SdkRunResult,
  type SdkRuntime,
  type SdkSendInput,
  type SdkStreamEvent,
  type SdkUsage,
} from "./port.js";
import { redactSecrets, sdkFailure } from "../errors.js";
import { ensurePrivateDir } from "../core/lineage-store.js";
import { credentialFingerprint } from "../digest.js";
import { fetchCursorDashboardQuota } from "../account/cursor-dashboard.js";

const require = createRequire(import.meta.url);

function readSdkVersion(): string {
  try {
    const pkg = require("@cursor/sdk/package.json") as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {
    // Package exports do not always expose package.json.
  }
  try {
    const self = require("../../package.json") as { dependencies?: Record<string, string> };
    const pinned = self.dependencies?.["@cursor/sdk"];
    if (pinned) return pinned;
  } catch {
    // fall through
  }
  return "1.0.30";
}

function mapUsage(raw: unknown): SdkUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.inputTokens !== "number" || typeof value.outputTokens !== "number") {
    return undefined;
  }
  const usage: SdkUsage = {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
  };
  if (typeof value.cacheReadTokens === "number") usage.cacheReadTokens = value.cacheReadTokens;
  if (typeof value.cacheWriteTokens === "number") usage.cacheWriteTokens = value.cacheWriteTokens;
  if (typeof value.totalTokens === "number") usage.totalTokens = value.totalTokens;
  if (typeof value.reasoningTokens === "number") usage.reasoningTokens = value.reasoningTokens;
  return usage;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function asText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const value = event as Record<string, unknown>;
  if (typeof value.text === "string") return value.text;
  const message = value.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
  if (message?.content) {
    return message.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("");
  }
  return "";
}

function wrapRun(run: Run, options: { suppressMessageDeltas: boolean }): SdkRun {
  let streamed = false;
  return {
    id: run.id,
    requestId: run.requestId,
    get usage() {
      return mapUsage(run.usage);
    },
    stream(): AsyncIterable<SdkStreamEvent> {
      if (streamed) {
        throw new Error("SDK run.stream() is single-consumer");
      }
      streamed = true;
      return (async function* () {
        try {
          for await (const event of run.stream()) {
            if (!event || typeof event !== "object") continue;
            const typed = event as { type?: string; call_id?: string; name?: string; status?: string };
            if (typed.type === "assistant") {
              if (options.suppressMessageDeltas) continue;
              const text = asText(event);
              if (text) yield { type: "assistant", text };
              continue;
            }
            if (typed.type === "thinking") {
              if (options.suppressMessageDeltas) continue;
              const text = asText(event);
              if (text) yield { type: "thinking", text };
              continue;
            }
            if (typed.type === "usage") {
              const usage = mapUsage((event as { usage?: unknown }).usage);
              if (usage) yield { type: "usage", usage };
              continue;
            }
            if (typed.type === "tool_call") {
              yield {
                type: "tool_call",
                callId: typed.call_id ?? "",
                name: typed.name ?? "",
                status: typed.status ?? "",
              };
              continue;
            }
            if (typed.type === "status" && typed.status) {
              yield { type: "status", status: typed.status };
            }
          }
        } catch (error) {
          throw mapSdkFailure(error);
        }
      })();
    },
    async wait(): Promise<SdkRunResult> {
      let result;
      try {
        result = await run.wait();
      } catch (error) {
        throw mapSdkFailure(error);
      }
      return {
        id: String(result.id ?? run.id),
        requestId: typeof result.requestId === "string" ? result.requestId : run.requestId,
        status: result.status ?? "finished",
        result: typeof result.result === "string" ? result.result : undefined,
        error: result.error
          ? {
              message: redactSecrets(result.error.message ?? "upstream error"),
              code: result.error.code,
            }
          : undefined,
        usage: mapUsage(result.usage),
      };
    },
    cancel: () => run.cancel(),
  };
}

function wrapSdkAgent(agent: SDKAgent, fallbackTools: Record<string, SdkCustomTool>): SdkAgent {
  return {
    agentId: agent.agentId,
    async send(sendInput: SdkSendInput) {
      const customTools = sendInput.customTools ?? fallbackTools;
      const hasDeltaSink = Boolean(sendInput.onDelta || sendInput.onEvent);
      let run;
      try {
        run = await agent.send(
          sendInput.images?.length ? { text: sendInput.text, images: sendInput.images } : sendInput.text,
          {
          local: { customTools: customTools as never, force: sendInput.force === true },
          onDelta: hasDeltaSink
            ? async ({ update }: { update: { type?: string; text?: string; usage?: unknown } }) => {
                if (update.type === "text-delta" || update.type === "thinking-delta") {
                  const payload = { type: update.type, text: String(update.text ?? "") } as const;
                  await sendInput.onDelta?.(payload);
                  await sendInput.onEvent?.(payload);
                  return;
                }
                if (update.type === "turn-ended") {
                  const usage = mapUsage(update.usage);
                  const payload = usage
                    ? ({ type: "turn-ended", usage } as const)
                    : ({ type: "turn-ended" } as const);
                  await sendInput.onDelta?.(payload);
                  await sendInput.onEvent?.(payload);
                }
              }
            : undefined,
          },
        );
      } catch (error) {
        throw mapSdkFailure(error);
      }
      return wrapRun(run, { suppressMessageDeltas: hasDeltaSink });
    },
    close() {
      agent.close();
    },
  };
}

export function createCursorRuntime(options: { stateDir: string }): SdkRuntime {
  const storeDir = join(options.stateDir, "sdk-store");
  ensurePrivateDir(storeDir);
  const tenantResources = (apiKey: string, workspaceRoot: string) => {
    const partition = credentialFingerprint(apiKey);
    const tenantStoreDir = join(storeDir, partition);
    const tenantWorkspaceDir = join(workspaceRoot, partition);
    ensurePrivateDir(tenantStoreDir);
    ensurePrivateDir(tenantWorkspaceDir);
    return {
      store: new JsonlLocalAgentStore(tenantStoreDir),
      workspaceDir: tenantWorkspaceDir,
    };
  };
  return {
    sdkVersion: readSdkVersion(),
    async createAgent(input: CreateAgentInput): Promise<SdkAgent> {
      const customTools = input.customTools;
      const resources = tenantResources(input.apiKey, input.workspaceDir);
      let agent;
      try {
        agent = await Agent.create({
          apiKey: input.apiKey,
          model: {
            id: input.modelId,
            params: input.modelParams,
          },
          tools: apiProfileToolAllowlist(input.clientToolNames) as never,
          disallowedTools: [...AMBIENT_DISALLOWED_TOOLS] as never,
          local: {
            cwd: resources.workspaceDir,
            settingSources: [],
            customTools: customTools as never,
            store: resources.store,
          },
        });
      } catch (error) {
        throw mapSdkFailure(error);
      }
      return wrapSdkAgent(agent, customTools);
    },
    async resumeAgent(input: ResumeAgentInput): Promise<SdkAgent> {
      const customTools = input.customTools;
      const resources = tenantResources(input.apiKey, input.workspaceDir);
      let agent;
      try {
        agent = await Agent.resume(input.agentId, {
          apiKey: input.apiKey,
          model: {
            id: input.modelId,
            params: input.modelParams,
          },
          tools: apiProfileToolAllowlist(input.clientToolNames) as never,
          disallowedTools: [...AMBIENT_DISALLOWED_TOOLS] as never,
          local: {
            cwd: resources.workspaceDir,
            settingSources: [],
            customTools: customTools as never,
            store: resources.store,
          },
        });
      } catch (error) {
        throw mapSdkFailure(error);
      }
      return wrapSdkAgent(agent, customTools);
    },
    async listModels(apiKey: string): Promise<SdkCatalogResult> {
      try {
        const models = await Cursor.models.list({ apiKey });
        return {
          ok: true,
          models: models.map((model) => ({
            id: model.id,
            displayName: model.displayName,
            description: model.description,
            parameters: model.parameters,
            variants: model.variants,
          })),
        };
      } catch (error) {
        return {
          ok: false,
          reason: "cursor_models_list_unavailable",
          message: redactSecrets(error instanceof Error ? error.message : "models.list failed"),
        };
      }
    },
    async getAccount(apiKey: string): Promise<SdkAccountResult> {
      try {
        const [me, quota] = await Promise.all([
          Cursor.me({ apiKey }),
          fetchCursorDashboardQuota(apiKey),
        ]);
        return {
          ok: true,
          identity: {
            apiKeyName: me.apiKeyName,
            userId: me.userId,
            createdAt: me.createdAt,
            firstName: me.userFirstName,
            lastName: me.userLastName,
          },
          ...(quota.available
            ? {
                spending: compactRecord({
                  source: quota.source,
                  plan_name: quota.planName,
                  plan_price: quota.planPrice,
                  plan_owner: quota.planOwner,
                  used_usd: quota.usedUsd,
                  total_spend_usd: quota.totalSpendUsd,
                  bonus_spend_usd: quota.bonusSpendUsd,
                  on_demand_spend_usd: quota.onDemandSpendUsd,
                }),
                limits: compactRecord({
                  remaining_usd: quota.remainingUsd,
                  limit_usd: quota.limitUsd,
                  used_percent: quota.usedPercent,
                  billing_cycle_start: quota.billingCycleStart,
                  billing_cycle_end: quota.billingCycleEnd,
                  cursor_models_percent_used: quota.cursorModelsPercentUsed,
                  other_models_percent_used: quota.otherModelsPercentUsed,
                  auto_models_percent_used: quota.autoModelsPercentUsed,
                  on_demand_limit_type: quota.onDemandLimitType,
                  on_demand_individual_limit: quota.onDemandIndividualLimit,
                  on_demand_individual_used: quota.onDemandIndividualUsed,
                  on_demand_individual_remaining: quota.onDemandIndividualRemaining,
                  on_demand_pooled_limit: quota.onDemandPooledLimit,
                  on_demand_pooled_used: quota.onDemandPooledUsed,
                  on_demand_pooled_remaining: quota.onDemandPooledRemaining,
                }),
              }
            : {
                spendingReason: quota.reason,
                limitsReason: quota.reason,
              }),
        };
      } catch (error) {
        return {
          ok: false,
          reason: "cursor_account_unavailable",
          message: redactSecrets(error instanceof Error ? error.message : "account lookup failed"),
        };
      }
    },
    async probeCredential(apiKey: string): Promise<"valid" | "invalid" | "unavailable"> {
      try {
        await Cursor.me({ apiKey });
        return "valid";
      } catch (error) {
        const mapped = sdkFailure(error);
        return mapped.code === "authentication_error" ? "invalid" : "unavailable";
      }
    },
  };
}

export function mapSdkFailure(error: unknown) {
  return sdkFailure(error);
}

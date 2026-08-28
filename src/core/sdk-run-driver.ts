import type { Clock } from "../clock.js";
import type { AnthropicTool } from "../protocols/anthropic/types.js";
import type {
  SdkAgent,
  SdkCustomToolResult,
  SdkDeltaUpdate,
  SdkRuntime,
} from "../sdk/port.js";
import { EventPump } from "./event-pump.js";
import type { Session } from "./session.js";
import { mapClientTools } from "./tool-bridge.js";

type AgentSource =
  | { type: "create"; apiKey: string; workspaceDir: string }
  | { type: "resume"; agentId: string; apiKey: string; workspaceDir: string }
  | { type: "existing"; agent: SdkAgent };

export interface DriveSdkRunInput {
  session: Session;
  tools: AnthropicTool[];
  agent: AgentSource;
  send: {
    text: string;
    images?: Array<{ data: string; mimeType: string }>;
    force?: boolean;
  };
  completedResults?: Map<string, SdkCustomToolResult[]>;
}

export interface SdkRunDriverDeps {
  sdk: SdkRuntime;
  clock: Clock;
  toolBatchSettleMs: number;
  firstEventTimeoutMs: number;
}

function createDeltaBridge() {
  const early: SdkDeltaUpdate[] = [];
  let pump: EventPump | undefined;
  const ingest = (update: SdkDeltaUpdate) => {
    early.push(update);
    flush();
  };
  const flush = () => {
    if (!pump) return;
    while (early.length > 0) {
      const next = early.shift();
      if (next) pump.ingestDelta(next);
    }
  };
  return {
    ingest,
    attach(next: EventPump) {
      pump = next;
      flush();
    },
  };
}

export class SdkRunDriver {
  constructor(private readonly deps: SdkRunDriverDeps) {}

  async start(input: DriveSdkRunInput): Promise<EventPump> {
    const { session } = input;
    session.run = undefined;
    session.pump = undefined;
    const customTools = mapClientTools(
      input.tools,
      session,
      this.deps.clock,
      () => undefined,
      input.completedResults,
    );
    const agent = await this.resolveAgent(input, customTools);
    session.agent = agent;
    session.sdkAgentId = agent.agentId;

    const deltas = createDeltaBridge();
    const run = await agent.send({
      text: input.send.text,
      images: input.send.images,
      customTools,
      force: input.send.force,
      onDelta: deltas.ingest,
    });
    session.run = run;
    const pump = new EventPump(
      session,
      run,
      this.deps.clock,
      this.deps.toolBatchSettleMs,
      this.deps.firstEventTimeoutMs,
    );
    session.pump = pump;
    deltas.attach(pump);
    pump.ingestEarly(session.earlyCalls.splice(0));
    return pump;
  }

  private resolveAgent(
    input: DriveSdkRunInput,
    customTools: ReturnType<typeof mapClientTools>,
  ): Promise<SdkAgent> {
    const common = {
      modelId: input.session.modelId,
      modelParams: input.session.modelParams,
      clientToolNames: input.tools.map((tool) => tool.name),
      customTools,
    };
    if (input.agent.type === "existing") return Promise.resolve(input.agent.agent);
    if (input.agent.type === "resume") {
      return this.deps.sdk.resumeAgent({
        ...common,
        agentId: input.agent.agentId,
        apiKey: input.agent.apiKey,
        workspaceDir: input.agent.workspaceDir,
      });
    }
    return this.deps.sdk.createAgent({
      ...common,
      apiKey: input.agent.apiKey,
      workspaceDir: input.agent.workspaceDir,
    });
  }
}

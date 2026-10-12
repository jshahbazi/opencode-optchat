import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { EvalFailure, loopbackURL, requestBody, resolveProvider, visibleResponse, type Backend, type ModelResult, type ProviderProfile } from "./local-memory-eval.ts";

// Preserve the earlier backend source and captures for the frozen 2K experiments.
export const highOutputBackendProtocol = { version: "local-high-output-backend-1", requestTimeoutMs: 600000 } as const;
type Messages = Parameters<Backend["complete"]>[0];
type ToolCall = NonNullable<Messages[number]["tool_calls"]>[number];
type FetchRequest = (input: URL, init: RequestInit) => Promise<Response>;
type CallMetric = { stage: string; latencyMs: number; inputTokens: number | null; outputTokens: number | null; success: boolean; code?: string };
type BackendState = { version: 1; endpoint: string; model: string; provider: ProviderProfile; startedAt: number; calls: number; metrics: (CallMetric & { call: number; invocation: string })[] };

function privateDirectory(directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); }
function writePrivate(path: string, value: unknown, immutable = false) {
  const data = JSON.stringify(value, null, 2) + "\n";
  if (immutable) { writeFileSync(path, data, { mode: 0o600, flag: "wx" }); return; }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600, flag: "wx" }); renameSync(temporary, path); chmodSync(path, 0o600);
}
function timeoutValue(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > highOutputBackendProtocol.requestTimeoutMs) throw new EvalFailure("INVALID_REQUEST_TIMEOUT");
  return value;
}

export class LocalBackend implements Backend {
  readonly endpoint: URL;
  readonly metrics: CallMetric[] = [];
  readonly started = Date.now();
  readonly requestTimeoutMs: number;
  constructor(url: string, readonly model: string, readonly directory: string, readonly maxCalls = 1, readonly maxMs = 3600000, readonly provider: ProviderProfile = "mlx", requestTimeoutMs = highOutputBackendProtocol.requestTimeoutMs as number, private readonly fetchRequest: FetchRequest = fetch) {
    this.endpoint = loopbackURL(url); this.requestTimeoutMs = timeoutValue(requestTimeoutMs);
    if (!model.trim() || model.length > 256) throw new EvalFailure("EXPLICIT_MODEL_REQUIRED");
  }
  async complete(messages: Messages, tools: unknown[], stage: string, maxTokens: number): Promise<ModelResult> {
    if (this.metrics.length >= this.maxCalls) throw new EvalFailure("CALL_LIMIT");
    const remaining = this.maxMs - (Date.now() - this.started);
    if (remaining <= 0) throw new EvalFailure("RUN_DEADLINE");
    const index = this.metrics.length, started = Date.now();
    const metric: CallMetric = { stage, latencyMs: 0, inputTokens: null, outputTokens: null, success: false };
    this.metrics.push(metric);
    writePrivate(resolve(this.directory, `call-${index.toString().padStart(3, "0")}-input.json`), requestBody(this.model, messages, tools, maxTokens, this.provider), true);
    try {
      const response = await this.fetchRequest(this.endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody(this.model, messages, tools, maxTokens, this.provider)), signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, remaining)) });
      if (!response.ok) throw new EvalFailure(`HTTP_${response.status}`);
      const raw: any = await response.json();
      writePrivate(resolve(this.directory, `call-${index.toString().padStart(3, "0")}-output.json`), visibleResponse(raw), true);
      metric.inputTokens = Number.isSafeInteger(raw.usage?.prompt_tokens) ? raw.usage.prompt_tokens : null;
      metric.outputTokens = Number.isSafeInteger(raw.usage?.completion_tokens) ? raw.usage.completion_tokens : null;
      if (["length", "content_filter"].includes(raw.choices?.[0]?.finish_reason)) throw new EvalFailure("MODEL_OUTPUT_INCOMPLETE");
      const received = raw.choices?.[0]?.message;
      if (!received || (received.content !== null && received.content !== undefined && typeof received.content !== "string") || (received.tool_calls !== undefined && !Array.isArray(received.tool_calls))) throw new EvalFailure("INVALID_MODEL_RESPONSE");
      const toolCalls = received.tool_calls ?? [];
      if (toolCalls.length > 12 || !toolCalls.every((call: ToolCall) => typeof call?.id === "string" && call.type === "function" && typeof call.function?.name === "string" && typeof call.function?.arguments === "string")) throw new EvalFailure("INVALID_TOOL_CALLS");
      metric.success = true;
      return { message: { role: "assistant", content: received.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls.map((call: ToolCall) => ({ id: call.id, type: call.type, function: { name: call.function.name, arguments: call.function.arguments } })) } : {}) }, inputTokens: metric.inputTokens, outputTokens: metric.outputTokens };
    } catch (error) { metric.code = error instanceof EvalFailure ? error.code : "TRANSPORT_FAILURE"; throw new EvalFailure(metric.code); }
    finally { metric.latencyMs = Date.now() - started; }
  }
}

export class ResumableLocalBackend implements Backend {
  readonly directory: string;
  readonly endpoint: URL;
  readonly model: string;
  readonly provider: ProviderProfile;
  readonly maxCalls: number;
  readonly maxMs: number;
  readonly requestTimeoutMs: number;
  readonly invocation = crypto.randomUUID();
  private readonly statePath: string;
  private state: BackendState;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly fetchRequest: FetchRequest;
  constructor(options: { url: string; model: string; directory: string; provider?: ProviderProfile; maxCalls?: number; maxMinutes?: number; requestTimeoutMs?: number; fetchRequest?: FetchRequest }) {
    this.endpoint = loopbackURL(options.url); this.model = options.model; this.provider = resolveProvider(options.provider ?? "mlx");
    this.maxCalls = options.maxCalls ?? 320;
    const minutes = options.maxMinutes ?? 60;
    if (!Number.isSafeInteger(this.maxCalls) || this.maxCalls < 1 || !Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw new EvalFailure("INVALID_LONG_LIMITS");
    if (!this.model.trim() || this.model.length > 256) throw new EvalFailure("EXPLICIT_MODEL_REQUIRED");
    this.requestTimeoutMs = timeoutValue(options.requestTimeoutMs ?? highOutputBackendProtocol.requestTimeoutMs);
    this.fetchRequest = options.fetchRequest ?? fetch;
    this.directory = resolve(options.directory);
    this.assertActive();
    this.maxMs = minutes * 60000; privateDirectory(this.directory);
    this.statePath = resolve(this.directory, "backend-state.json");
    this.state = existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, "utf8")) as BackendState : { version: 1, endpoint: this.endpoint.href, model: this.model, provider: this.provider, startedAt: Date.now(), calls: 0, metrics: [] };
    if (this.state.version !== 1 || this.state.endpoint !== this.endpoint.href || this.state.model !== this.model || this.state.provider !== this.provider || !Number.isSafeInteger(this.state.calls) || this.state.calls < 0 || !Number.isSafeInteger(this.state.startedAt) || !Array.isArray(this.state.metrics)) throw new EvalFailure("BACKEND_RESUME_MISMATCH");
    writePrivate(this.statePath, this.state);
    privateDirectory(resolve(this.directory, "calls", this.invocation));
    writePrivate(resolve(this.directory, "calls", this.invocation, "invocation.json"), { invocation: this.invocation, startedAt: Date.now(), cumulativeAtStart: this.state.calls, maxCalls: this.maxCalls, maxMinutes: minutes, requestTimeoutMs: this.requestTimeoutMs, provider: this.provider, model: this.model, endpoint: this.endpoint.href }, true);
  }
  private assertActive() { if (existsSync(resolve(this.directory, "user-requested-stop.json"))) throw new EvalFailure("MANAGED_USER_STOPPED"); }
  get calls() { return this.state.calls; }
  get metrics() { return this.state.metrics; }
  get startedAt() { return this.state.startedAt; }
  complete(messages: Messages, tools: unknown[], stage: string, maxTokens: number): Promise<ModelResult> {
    const operation = this.queue.then(() => this.perform(messages, tools, stage, maxTokens));
    this.queue = operation.catch(() => {}); return operation;
  }
  private async perform(messages: Messages, tools: unknown[], stage: string, maxTokens: number): Promise<ModelResult> {
    this.assertActive();
    const persisted = JSON.parse(readFileSync(this.statePath, "utf8")) as BackendState;
    if (persisted.calls !== this.state.calls) throw new EvalFailure("CONCURRENT_EVALUATION");
    const remaining = this.maxMs - (Date.now() - this.state.startedAt);
    if (this.state.calls >= this.maxCalls) throw new EvalFailure("CALL_LIMIT");
    if (remaining <= 0) throw new EvalFailure("RUN_DEADLINE");
    const call = ++this.state.calls;
    writePrivate(this.statePath, this.state);
    const directory = resolve(this.directory, "calls", this.invocation, String(call).padStart(6, "0")); privateDirectory(directory);
    const local = new LocalBackend(this.endpoint.href, this.model, directory, 1, remaining, this.provider, this.requestTimeoutMs, this.fetchRequest);
    try { this.assertActive(); return await local.complete(messages, tools, stage, maxTokens); }
    finally {
      const metric = local.metrics[0];
      if (metric) this.state.metrics.push({ ...metric, call, invocation: this.invocation });
      writePrivate(this.statePath, this.state);
    }
  }
}

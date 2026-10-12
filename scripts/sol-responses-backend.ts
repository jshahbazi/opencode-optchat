import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hash } from "../src/index.ts";
import { EvalFailure, type Backend, type ModelResult } from "./local-memory-eval.ts";

type Messages = Parameters<Backend["complete"]>[0];
type Message = Messages[number];
export type SolReasoning = "low" | "medium";
export type SolFetchRequest = (input: URL, init: RequestInit) => Promise<Response>;
export const solBackendProtocol = {
  version: "sol-responses-backend-1", model: "gpt-6.1-sol", endpoint: "https://api.openai.com/v1/responses",
  countEndpoint: "https://api.openai.com/v1/responses/input_tokens", answerReasoning: "medium", graderReasoning: "low",
  maxCalls: 420, maxCountCalls: 3000, maxMinutes: 120, maxCostUsd: 60, requestTimeoutMs: 600000,
  maxOutputTokens: 8192, inputUsdPerMillion: 2.5, outputUsdPerMillion: 10,
  contextTokens: 32768, safetyTokens: 1024, store: false, truncation: "disabled", parallelToolCalls: true, automaticRetries: 0,
  continuation: "Replay visible messages and complete tool pairs. Recompute reasoning without provider reasoning items.",
} as const;

export type SolMetric = {
  call: number; invocation: string; stage: string; reasoning: SolReasoning; requestHash: string; countHash: string;
  expectedInputTokens: number; maxOutputTokens: number; latencyMs: number; inputTokens: number | null;
  outputTokens: number | null; cachedInputTokens: number | null; cacheWriteInputTokens: number | null; reasoningTokens: number | null;
  totalTokens: number | null; costUsd: number | null; reservedCostUsd: number; success: boolean;
  status: "pending" | "complete"; code?: string; providerStatus?: string; providerModel?: string;
};
export type SolCountMetric = {
  call: number; invocation: string; requestHash: string; stage: string; reasoning: SolReasoning;
  latencyMs: number; inputTokens: number | null; success: boolean; status: "pending" | "complete"; code?: string;
};
type CountReceipt = { inputTokens: number; countCall: number; requestHash: string };
type State = {
  version: 1; profile: string; revision: number; startedAt: number; calls: number; countCalls: number;
  costUsd: number; reservedCostUsd: number; metrics: SolMetric[]; countMetrics: SolCountMetric[];
  counts: Record<string, CountReceipt>; haltedCode: string | null;
};
export type SolBackendOptions = {
  directory: string; keyFile: string; model?: "gpt-6.1-sol"; stopDirectory?: string;
  answerReasoning?: SolReasoning; graderReasoning?: SolReasoning; maxCalls?: number; maxCountCalls?: number;
  maxMinutes?: number; maxCostUsd?: number; requestTimeoutMs?: number; fetchRequest?: SolFetchRequest;
  stageClassifier?: (stage: string) => "answer" | "grader"; stageClassifierId?: string;
};
export const solPayloadHash = (value: unknown) => hash(canonicalSolJSON(value));
const digest = solPayloadHash;
export function canonicalSolJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalSolJSON).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalSolJSON((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function privateDirectory(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
function writePrivate(path: string, value: unknown, immutable = false) {
  const data = JSON.stringify(value, null, 2) + "\n";
  if (immutable) { writeFileSync(path, data, { mode: 0o600, flag: "wx" }); return; }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600, flag: "wx" }); renameSync(temporary, path); chmodSync(path, 0o600);
}
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function positiveLimit(value: number, maximum: number, code: string) {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new EvalFailure(code);
  return value;
}
function outputLimit(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > solBackendProtocol.maxOutputTokens) throw new EvalFailure("SOL_INVALID_OUTPUT_LIMIT");
  return value;
}
function reasoningValue(value: SolReasoning) {
  if (value !== "low" && value !== "medium") throw new EvalFailure("SOL_INVALID_REASONING");
  return value;
}
function safeFailure(error: unknown) {
  return error instanceof EvalFailure && /^[A-Z_0-9]{1,64}$/.test(error.code) ? error.code : "SOL_TRANSPORT_FAILURE";
}

// Provider reasoning items and provider message IDs do not enter this stateless transcript.
export function solInput(messages: Messages): unknown[] {
  const input: unknown[] = [], pending = new Set<string>(), seen = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message.role !== "string" || message.content !== null && typeof message.content !== "string") throw new EvalFailure("SOL_INVALID_MESSAGES");
    if (message.role === "tool") {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id) || message.tool_calls || typeof message.content !== "string") throw new EvalFailure("SOL_UNPAIRED_TOOL_PROTOCOL");
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content }); continue;
    }
    if (pending.size) throw new EvalFailure("SOL_UNPAIRED_TOOL_PROTOCOL");
    if (!["system", "developer", "user", "assistant"].includes(message.role) || message.tool_call_id || message.role !== "assistant" && message.tool_calls) throw new EvalFailure("SOL_INVALID_MESSAGES");
    if (message.content !== null) input.push({ role: message.role, content: message.content });
    const calls = message.tool_calls ?? [];
    if (!Array.isArray(calls) || calls.length > 64) throw new EvalFailure("SOL_INVALID_TOOL_CALLS");
    for (const call of calls) {
      if (!call || call.type !== "function" || typeof call.id !== "string" || !call.id || seen.has(call.id) || typeof call.function?.name !== "string" || !call.function.name || typeof call.function.arguments !== "string") throw new EvalFailure("SOL_INVALID_TOOL_CALLS");
      seen.add(call.id); pending.add(call.id);
      input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
    if (message.content === null && !calls.length) input.push({ role: message.role, content: "" });
  }
  if (pending.size) throw new EvalFailure("SOL_UNPAIRED_TOOL_PROTOCOL");
  return input;
}
export function solTools(tools: unknown[]): unknown[] {
  if (!Array.isArray(tools)) throw new EvalFailure("SOL_INVALID_TOOLS");
  const names = new Set<string>();
  return tools.map(value => {
    const tool = value as any, fn = tool?.function;
    if (tool?.type !== "function" || !fn || typeof fn.name !== "string" || !fn.name || names.has(fn.name) || typeof fn.description !== "string" || !fn.parameters || typeof fn.parameters !== "object" || Array.isArray(fn.parameters)) throw new EvalFailure("SOL_INVALID_TOOLS");
    names.add(fn.name);
    return { type: "function", name: fn.name, description: fn.description, parameters: structuredClone(fn.parameters), strict: false };
  });
}
export function solCountBody(model: string, messages: Messages, tools: unknown[], reasoning: SolReasoning) {
  if (model !== solBackendProtocol.model) throw new EvalFailure("SOL_EXPLICIT_MODEL_REQUIRED");
  return { model, input: solInput(messages), tools: solTools(tools), tool_choice: tools.length ? "auto" : "none",
    parallel_tool_calls: true, reasoning: { effort: reasoningValue(reasoning) }, truncation: "disabled" };
}
export function solRequestBody(model: string, messages: Messages, tools: unknown[], maxTokens: number, reasoning: SolReasoning) {
  return { ...solCountBody(model, messages, tools, reasoning), store: false, stream: false, max_output_tokens: outputLimit(maxTokens) };
}

// Keep only visible text, function calls, and aggregate usage from the provider response.
export function visibleSolResponse(raw: any) {
  const output: unknown[] = [];
  for (const item of Array.isArray(raw?.output) ? raw.output : []) {
    if (item?.type === "function_call") output.push({ type: "function_call", call_id: typeof item.call_id === "string" ? item.call_id : null,
      name: typeof item.name === "string" ? item.name : null, arguments: typeof item.arguments === "string" ? item.arguments : null,
      status: typeof item.status === "string" ? item.status : null });
    if (item?.type === "message") output.push({ type: "message", role: item.role === "assistant" ? "assistant" : null,
      status: typeof item.status === "string" ? item.status : null,
      content: (Array.isArray(item.content) ? item.content : []).flatMap((part: any) => part?.type === "output_text" && typeof part.text === "string" ? [{ type: "output_text", text: part.text }] : part?.type === "refusal" && typeof part.refusal === "string" ? [{ type: "refusal", refusal: part.refusal }] : []) });
  }
  const value = (number: unknown) => integer(number) ? number : null;
  return { id: typeof raw?.id === "string" ? raw.id : null, status: typeof raw?.status === "string" ? raw.status : null,
    model: typeof raw?.model === "string" ? raw.model : null, output,
    incomplete_details: raw?.incomplete_details?.reason === "max_output_tokens" ? { reason: "max_output_tokens" } : null,
    usage: { input_tokens: value(raw?.usage?.input_tokens), output_tokens: value(raw?.usage?.output_tokens), total_tokens: value(raw?.usage?.total_tokens),
      input_tokens_details: { cached_tokens: value(raw?.usage?.input_tokens_details?.cached_tokens), cache_write_tokens: value(raw?.usage?.input_tokens_details?.cache_write_tokens) },
      output_tokens_details: { reasoning_tokens: value(raw?.usage?.output_tokens_details?.reasoning_tokens) } } };
}
function modelMessage(raw: any): Message {
  if (!Array.isArray(raw?.output)) throw new EvalFailure("SOL_INVALID_MODEL_RESPONSE");
  const texts: string[] = [], calls: NonNullable<Message["tool_calls"]> = [], ids = new Set<string>();
  for (const item of raw.output) {
    if (item?.type === "reasoning") continue;
    if (item?.type === "function_call") {
      if (item.status !== undefined && item.status !== "completed") throw new EvalFailure("MODEL_OUTPUT_INCOMPLETE");
      if (typeof item.call_id !== "string" || !item.call_id || ids.has(item.call_id) || typeof item.name !== "string" || !item.name || typeof item.arguments !== "string") throw new EvalFailure("SOL_INVALID_TOOL_CALLS");
      ids.add(item.call_id); calls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }); continue;
    }
    if (item?.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) throw new EvalFailure("SOL_INVALID_MODEL_RESPONSE");
    if (item.status !== undefined && item.status !== "completed") throw new EvalFailure("MODEL_OUTPUT_INCOMPLETE");
    let text = "";
    for (const part of item.content) {
      if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
      else if (part?.type === "refusal" && typeof part.refusal === "string") throw new EvalFailure("MODEL_REFUSAL");
      else throw new EvalFailure("SOL_INVALID_MODEL_RESPONSE");
    }
    texts.push(text);
  }
  if (calls.length > 64 || !calls.length && !texts.length) throw new EvalFailure("SOL_INVALID_MODEL_RESPONSE");
  return { role: "assistant", content: texts.length ? texts.join("\n") : null, ...(calls.length ? { tool_calls: calls } : {}) };
}

export { modelMessage as solVisibleMessage };

export class SolBackend implements Backend {
  readonly model = solBackendProtocol.model;
  readonly directory: string;
  readonly endpoint = new URL(solBackendProtocol.endpoint);
  readonly countEndpoint = new URL(solBackendProtocol.countEndpoint);
  readonly invocation = crypto.randomUUID();
  readonly maxCalls: number; readonly maxCountCalls: number; readonly maxMs: number; readonly maxCostUsd: number;
  readonly requestTimeoutMs: number; readonly answerReasoning: SolReasoning; readonly graderReasoning: SolReasoning;
  private readonly keyFile: string; private readonly stopDirectory: string; private readonly statePath: string;
  private readonly lockPath: string; private readonly fetchRequest: SolFetchRequest;
  private readonly stageClassifier: (stage: string) => "answer" | "grader";
  private state: State; private queue: Promise<unknown> = Promise.resolve();
  constructor(options: SolBackendOptions) {
    if (options.model !== undefined && options.model !== this.model) throw new EvalFailure("SOL_EXPLICIT_MODEL_REQUIRED");
    this.directory = resolve(options.directory); this.keyFile = resolve(options.keyFile); this.stopDirectory = resolve(options.stopDirectory ?? this.directory);
    this.maxCalls = positiveLimit(options.maxCalls ?? solBackendProtocol.maxCalls, solBackendProtocol.maxCalls, "SOL_INVALID_LIMITS");
    this.maxCountCalls = positiveLimit(options.maxCountCalls ?? solBackendProtocol.maxCountCalls, solBackendProtocol.maxCountCalls, "SOL_INVALID_LIMITS");
    if (!Number.isSafeInteger(this.maxCalls) || !Number.isSafeInteger(this.maxCountCalls)) throw new EvalFailure("SOL_INVALID_LIMITS");
    const minutes = positiveLimit(options.maxMinutes ?? solBackendProtocol.maxMinutes, solBackendProtocol.maxMinutes, "SOL_INVALID_LIMITS");
    this.maxMs = minutes * 60000; this.maxCostUsd = positiveLimit(options.maxCostUsd ?? solBackendProtocol.maxCostUsd, solBackendProtocol.maxCostUsd, "SOL_INVALID_LIMITS");
    this.requestTimeoutMs = positiveLimit(options.requestTimeoutMs ?? solBackendProtocol.requestTimeoutMs, solBackendProtocol.requestTimeoutMs, "SOL_INVALID_REQUEST_TIMEOUT");
    if (!Number.isSafeInteger(this.requestTimeoutMs)) throw new EvalFailure("SOL_INVALID_REQUEST_TIMEOUT");
    this.answerReasoning = reasoningValue(options.answerReasoning ?? solBackendProtocol.answerReasoning);
    this.graderReasoning = reasoningValue(options.graderReasoning ?? solBackendProtocol.graderReasoning);
    this.stageClassifier = options.stageClassifier ?? (stage => /^(?:grade|judge|calibration)(?::|$)/.test(stage) ? "grader" : "answer");
    if (options.stageClassifier && !options.stageClassifierId?.trim()) throw new EvalFailure("SOL_CLASSIFIER_ID_REQUIRED");
    this.fetchRequest = options.fetchRequest ?? fetch; this.assertActive(); privateDirectory(this.directory);
    this.statePath = resolve(this.directory, "sol-backend-state.json"); this.lockPath = resolve(this.directory, "sol-backend-dispatch.lock");
    try { writeFileSync(this.lockPath, this.invocation, { mode: 0o600, flag: "wx" }); } catch { throw new EvalFailure("SOL_CONCURRENT_EVALUATION"); }
    const profile = digest({ protocol: solBackendProtocol, maxCalls: this.maxCalls, maxCountCalls: this.maxCountCalls, maxMs: this.maxMs,
      maxCostUsd: this.maxCostUsd, requestTimeoutMs: this.requestTimeoutMs, answerReasoning: this.answerReasoning, graderReasoning: this.graderReasoning,
      stageClassifierId: options.stageClassifierId ?? "grade-judge-calibration-prefix-1", stopDirectory: this.stopDirectory });
    try {
      try { this.state = existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, "utf8")) as State : {
      version: 1, profile, revision: 0, startedAt: Date.now(), calls: 0, countCalls: 0, costUsd: 0, reservedCostUsd: 0,
      metrics: [], countMetrics: [], counts: {}, haltedCode: null,
      }; } catch { throw new EvalFailure("SOL_RESUME_MISMATCH"); }
      this.validateState(profile);
      if (this.state.metrics.some(metric => metric.status === "pending") || this.state.reservedCostUsd > 0) this.state.haltedCode = "SOL_USAGE_UNRESOLVED";
      if (this.state.countMetrics.some(metric => metric.status === "pending")) this.state.haltedCode ??= "SOL_COUNT_FAILED";
      this.persist();
      privateDirectory(resolve(this.directory, "calls")); privateDirectory(resolve(this.directory, "counts"));
    } finally { unlinkSync(this.lockPath); }
  }
  get calls() { return this.state.calls; }
  get countCalls() { return this.state.countCalls; }
  get metrics() { return this.state.metrics; }
  get countMetrics() { return this.state.countMetrics; }
  get startedAt() { return this.state.startedAt; }
  get costUsd() { return this.state.costUsd; }
  get haltedCode() { return this.state.haltedCode; }
  private validateState(profile: string) {
    const state = this.state;
    if (state.version !== 1 || state.profile !== profile || !integer(state.revision) || !integer(state.startedAt) || !integer(state.calls) || !integer(state.countCalls)
      || state.calls > this.maxCalls || state.countCalls > this.maxCountCalls || !Number.isFinite(state.costUsd) || state.costUsd < 0
      || !Number.isFinite(state.reservedCostUsd) || state.reservedCostUsd < 0 || !Array.isArray(state.metrics) || !Array.isArray(state.countMetrics)
      || state.metrics.length !== state.calls || state.countMetrics.length !== state.countCalls || !state.counts || typeof state.counts !== "object" || Array.isArray(state.counts)
      || state.haltedCode !== null && (typeof state.haltedCode !== "string" || !/^[A-Z_0-9]{1,64}$/.test(state.haltedCode))) throw new EvalFailure("SOL_RESUME_MISMATCH");
    for (const [index, metric] of state.metrics.entries()) if (metric.call !== index + 1 || !["pending", "complete"].includes(metric.status) || !integer(metric.expectedInputTokens) || !integer(metric.maxOutputTokens)) throw new EvalFailure("SOL_RESUME_MISMATCH");
    for (const [index, metric] of state.countMetrics.entries()) if (metric.call !== index + 1 || !["pending", "complete"].includes(metric.status)) throw new EvalFailure("SOL_RESUME_MISMATCH");
    for (const [key, receipt] of Object.entries(state.counts)) if (!/^[a-f0-9]{64}$/.test(key) || receipt.requestHash !== key || !integer(receipt.inputTokens) || !integer(receipt.countCall) || receipt.countCall < 1 || receipt.countCall > state.countCalls
      || !state.countMetrics[receipt.countCall - 1]?.success || state.countMetrics[receipt.countCall - 1]?.requestHash !== key || state.countMetrics[receipt.countCall - 1]?.inputTokens !== receipt.inputTokens) throw new EvalFailure("SOL_RESUME_MISMATCH");
  }
  private persist() { this.state.revision++; writePrivate(this.statePath, this.state); }
  private assertActive() { if (existsSync(resolve(this.stopDirectory, "user-requested-stop.json")) || existsSync(resolve(this.directory, "user-requested-stop.json"))) throw new EvalFailure("SOL_USER_STOPPED"); }
  private assertDispatch() {
    this.assertActive();
    let persisted: State;
    try { persisted = JSON.parse(readFileSync(this.statePath, "utf8")) as State; } catch { throw new EvalFailure("SOL_RESUME_MISMATCH"); }
    if (persisted.revision !== this.state.revision || persisted.profile !== this.state.profile) throw new EvalFailure("SOL_CONCURRENT_EVALUATION");
    if (this.state.haltedCode) throw new EvalFailure(this.state.haltedCode);
    if (Date.now() - this.startedAt >= this.maxMs) throw new EvalFailure("SOL_RUN_DEADLINE");
  }
  private effort(stage: string) { return this.stageClassifier(stage) === "grader" ? this.graderReasoning : this.answerReasoning; }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    this.assertDispatch();
    try { writeFileSync(this.lockPath, this.invocation, { mode: 0o600, flag: "wx" }); } catch { throw new EvalFailure("SOL_CONCURRENT_EVALUATION"); }
    try { this.assertDispatch(); return await operation(); } finally { unlinkSync(this.lockPath); }
  }
  private async dispatch(endpoint: URL, body: unknown): Promise<any> {
    this.assertActive();
    if (endpoint.href !== solBackendProtocol.endpoint && endpoint.href !== solBackendProtocol.countEndpoint) throw new EvalFailure("SOL_ENDPOINT_MISMATCH");
    let key: string;
    try { key = readFileSync(this.keyFile, "utf8").trim(); } catch { throw new EvalFailure("SOL_KEY_FILE_UNAVAILABLE"); }
    if (!key || /\s/.test(key) || key.length > 4096) throw new EvalFailure("SOL_INVALID_KEY_FILE");
    const controller = new AbortController(); let stopped = false;
    const remaining = this.maxMs - (Date.now() - this.startedAt);
    if (remaining <= 0) throw new EvalFailure("SOL_RUN_DEADLINE");
    const timer = setTimeout(() => controller.abort(), Math.min(this.requestTimeoutMs, remaining));
    const watcher = setInterval(() => { try { this.assertActive(); } catch { stopped = true; controller.abort(); } }, 250);
    try {
      const response = await this.fetchRequest(endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body), signal: controller.signal });
      if (stopped) throw new EvalFailure("SOL_USER_STOPPED");
      if (!response.ok) throw new EvalFailure(`SOL_HTTP_${response.status}`);
      const raw = await response.json();
      if (stopped) throw new EvalFailure("SOL_USER_STOPPED");
      return raw;
    } catch (error) { if (stopped) throw new EvalFailure("SOL_USER_STOPPED"); throw new EvalFailure(safeFailure(error)); }
    finally { key = ""; clearTimeout(timer); clearInterval(watcher); }
  }
  readonly countRequestTokens = (messages: Messages, tools: unknown[], maxTokens: number, stage = "answer"): Promise<number> => {
    outputLimit(maxTokens);
    const clonedMessages = structuredClone(messages), clonedTools = structuredClone(tools);
    return this.enqueue(() => this.locked(() => this.count(clonedMessages, clonedTools, stage)));
  };
  private async count(messages: Messages, tools: unknown[], stage: string): Promise<number> {
    this.assertDispatch();
    const reasoning = this.effort(stage), body = solCountBody(this.model, messages, tools, reasoning), requestHash = digest(body);
    const cached = this.state.counts[requestHash]; if (cached) return cached.inputTokens;
    if (this.state.countCalls >= this.maxCountCalls) throw new EvalFailure("SOL_COUNT_CALL_LIMIT");
    const call = ++this.state.countCalls, directory = resolve(this.directory, "counts", String(call).padStart(6, "0")); privateDirectory(directory);
    const metric: SolCountMetric = { call, invocation: this.invocation, requestHash, stage, reasoning, latencyMs: 0, inputTokens: null, success: false, status: "pending" };
    this.state.countMetrics.push(metric); this.persist();
    writePrivate(resolve(directory, "input.json"), body, true);
    const started = Date.now();
    try {
      const raw = await this.dispatch(this.countEndpoint, body);
      writePrivate(resolve(directory, "output.json"), { object: raw?.object === "response.input_tokens" ? raw.object : null, input_tokens: integer(raw?.input_tokens) ? raw.input_tokens : null }, true);
      if (raw?.object !== "response.input_tokens" || !integer(raw.input_tokens)) throw new EvalFailure("SOL_INVALID_TOKEN_COUNT");
      metric.inputTokens = raw.input_tokens; metric.success = true;
      this.state.counts[requestHash] = { inputTokens: raw.input_tokens, countCall: call, requestHash };
      return raw.input_tokens;
    } catch (error) { metric.code = safeFailure(error); this.state.haltedCode = metric.code === "SOL_USER_STOPPED" ? "SOL_USER_STOPPED" : "SOL_COUNT_FAILED"; throw new EvalFailure(metric.code); }
    finally { metric.latencyMs = Date.now() - started; metric.status = "complete"; writePrivate(resolve(directory, "receipt.json"), metric, true); this.persist(); }
  }
  complete(messages: Messages, tools: unknown[], stage: string, maxTokens: number): Promise<ModelResult> {
    outputLimit(maxTokens);
    const clonedMessages = structuredClone(messages), clonedTools = structuredClone(tools);
    return this.enqueue(() => this.locked(() => this.perform(clonedMessages, clonedTools, stage, maxTokens)));
  }
  private async perform(messages: Messages, tools: unknown[], stage: string, maxTokens: number): Promise<ModelResult> {
    this.assertDispatch();
    if (this.calls >= this.maxCalls) throw new EvalFailure("SOL_CALL_LIMIT");
    const expectedInputTokens = await this.count(messages, tools, stage), reasoning = this.effort(stage);
    if (expectedInputTokens + maxTokens + solBackendProtocol.safetyTokens > solBackendProtocol.contextTokens) throw new EvalFailure("SOL_CONTEXT_BUDGET");
    const reservation = (expectedInputTokens * solBackendProtocol.inputUsdPerMillion + maxTokens * solBackendProtocol.outputUsdPerMillion) / 1000000;
    if (this.costUsd + this.state.reservedCostUsd + reservation > this.maxCostUsd) throw new EvalFailure("SOL_COST_LIMIT");
    this.assertDispatch();
    const body = solRequestBody(this.model, messages, tools, maxTokens, reasoning), requestHash = digest(body), countHash = digest(solCountBody(this.model, messages, tools, reasoning));
    const call = ++this.state.calls, directory = resolve(this.directory, "calls", String(call).padStart(6, "0")); privateDirectory(directory);
    const metric: SolMetric = { call, invocation: this.invocation, stage, reasoning, requestHash, countHash, expectedInputTokens, maxOutputTokens: maxTokens,
      latencyMs: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null, totalTokens: null,
      costUsd: null, reservedCostUsd: reservation, success: false, status: "pending" };
    this.state.metrics.push(metric); this.state.reservedCostUsd += reservation; this.persist();
    writePrivate(resolve(directory, "input.json"), body, true);
    const started = Date.now(); let authoritativeUsage = false;
    try {
      const raw = await this.dispatch(this.endpoint, body), visible = visibleSolResponse(raw);
      writePrivate(resolve(directory, "output.json"), visible, true);
      const usage = raw?.usage, cached = usage?.input_tokens_details?.cached_tokens, cacheWrite = usage?.input_tokens_details?.cache_write_tokens, reasoningTokens = usage?.output_tokens_details?.reasoning_tokens;
      if (!integer(usage?.input_tokens) || !integer(usage?.output_tokens) || !integer(usage?.total_tokens) || usage.total_tokens !== usage.input_tokens + usage.output_tokens
        || usage.output_tokens > maxTokens || cached !== undefined && (!integer(cached) || cached > usage.input_tokens)
        || cacheWrite !== undefined && (!integer(cacheWrite) || cacheWrite > usage.input_tokens)
        || reasoningTokens !== undefined && (!integer(reasoningTokens) || reasoningTokens > usage.output_tokens)) throw new EvalFailure("SOL_USAGE_UNRESOLVED");
      authoritativeUsage = true; metric.inputTokens = usage.input_tokens; metric.outputTokens = usage.output_tokens; metric.totalTokens = usage.total_tokens;
      metric.cachedInputTokens = cached ?? null; metric.cacheWriteInputTokens = cacheWrite ?? null; metric.reasoningTokens = reasoningTokens ?? null;
      metric.costUsd = (usage.input_tokens * solBackendProtocol.inputUsdPerMillion + usage.output_tokens * solBackendProtocol.outputUsdPerMillion) / 1000000;
      this.state.costUsd += metric.costUsd; this.state.reservedCostUsd = Math.max(0, this.state.reservedCostUsd - reservation);
      metric.providerStatus = typeof raw.status === "string" ? raw.status : undefined; metric.providerModel = typeof raw.model === "string" ? raw.model : undefined;
      if (metric.inputTokens !== expectedInputTokens) { this.state.haltedCode = "SOL_INPUT_COUNT_MISMATCH"; throw new EvalFailure("SOL_INPUT_COUNT_MISMATCH"); }
      if (raw.model !== this.model && !(typeof raw.model === "string" && raw.model.startsWith(`${this.model}-`))) throw new EvalFailure("SOL_MODEL_ID_MISMATCH");
      if (raw.status !== "completed") throw new EvalFailure("MODEL_OUTPUT_INCOMPLETE");
      const message = modelMessage(raw); metric.success = true;
      return { message, inputTokens: metric.inputTokens, outputTokens: metric.outputTokens };
    } catch (error) {
      metric.code = safeFailure(error);
      if (!authoritativeUsage) this.state.haltedCode = "SOL_USAGE_UNRESOLVED";
      throw new EvalFailure(metric.code);
    } finally { metric.latencyMs = Date.now() - started; metric.status = "complete"; writePrivate(resolve(directory, "receipt.json"), metric, true); this.persist(); }
  }
}

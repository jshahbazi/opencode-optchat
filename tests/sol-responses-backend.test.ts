import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SolBackend, solBackendProtocol, solCountBody, solInput, solPayloadHash, solRequestBody, visibleSolResponse, type SolBackendOptions } from "../scripts/sol-responses-backend.ts";
import type { Backend } from "../scripts/local-memory-eval.ts";

type Messages = Parameters<Backend["complete"]>[0];
const messages: Messages = [{ role: "system", content: "Synthetic instruction." }, { role: "user", content: "Synthetic question." }];
const tools = [{ type: "function", function: { name: "source", description: "Read a synthetic source.", parameters: { type: "object", properties: { id: { type: "string" }, offset: { type: "integer" } }, required: ["id"], additionalProperties: false } } }];
const count = (tokens = 100) => Response.json({ object: "response.input_tokens", input_tokens: tokens });
function response(options: { input?: number; output?: number; status?: string; outputItems?: unknown[]; noUsage?: boolean } = {}) {
  const input = options.input ?? 100, output = options.output ?? 5000;
  return Response.json({ id: "response_fixture", model: solBackendProtocol.model, status: options.status ?? "completed",
    incomplete_details: options.status === "incomplete" ? { reason: "max_output_tokens", private: "PRIVATE_SENTINEL" } : null,
    output: options.outputItems ?? [
      { type: "reasoning", id: "HIDDEN_ID_SENTINEL", encrypted_content: "HIDDEN_REASONING_SENTINEL", summary: [{ type: "summary_text", text: "HIDDEN_SUMMARY_SENTINEL" }] },
      { type: "message", id: "PROVIDER_ITEM_ID_SENTINEL", role: "assistant", status: "completed", phase: "PROVIDER_PHASE_SENTINEL", content: [{ type: "output_text", text: "Synthetic visible answer.", annotations: [{ private: "ANNOTATION_SENTINEL" }], logprobs: "LOGPROB_SENTINEL" }] },
    ], ...(options.noUsage ? {} : { usage: { input_tokens: input, output_tokens: output, total_tokens: input + output, input_tokens_details: { cached_tokens: 50 }, output_tokens_details: { reasoning_tokens: output - 1 } } }), private: "PRIVATE_PROVIDER_SENTINEL" });
}
function fixture(extra: Partial<SolBackendOptions> = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "sol-backend-fixture-")), keyFile = resolve(root, "synthetic-key.txt"), directory = resolve(root, "run");
  writeFileSync(keyFile, "SYNTHETIC_KEY_SENTINEL", { mode: 0o600 });
  return { root, directory, keyFile, options: { directory, keyFile, ...extra } };
}
function allFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => { const path = resolve(directory, name); return statSync(path).isDirectory() ? allFiles(path) : [path]; });
}

test("Sol translation retains complete tool pairs and optional function parameters", () => {
  const paired: Messages = [...messages,
    { role: "assistant", content: "Synthetic navigation.", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "source", arguments: '{"id":"synthetic"}' } }] },
    { role: "tool", tool_call_id: "call_fixture", content: '{"text":"Synthetic source."}' },
    { role: "assistant", content: "Synthetic conclusion." },
  ];
  const request = solRequestBody(solBackendProtocol.model, paired, tools, 8192, "medium"), counted = solCountBody(solBackendProtocol.model, paired, tools, "medium");
  expect(request.input).toEqual([
    { role: "system", content: "Synthetic instruction." }, { role: "user", content: "Synthetic question." },
    { role: "assistant", content: "Synthetic navigation." }, { type: "function_call", call_id: "call_fixture", name: "source", arguments: '{"id":"synthetic"}' },
    { type: "function_call_output", call_id: "call_fixture", output: '{"text":"Synthetic source."}' }, { role: "assistant", content: "Synthetic conclusion." },
  ]);
  expect(request.tools[0]).toEqual({ type: "function", name: "source", description: tools[0]!.function.description, parameters: tools[0]!.function.parameters, strict: false });
  expect(request).toMatchObject({ store: false, stream: false, truncation: "disabled", parallel_tool_calls: true, reasoning: { effort: "medium" }, max_output_tokens: 8192 });
  expect(request).not.toHaveProperty("temperature"); expect(request).not.toHaveProperty("previous_response_id");
  expect(counted).not.toHaveProperty("max_output_tokens"); expect(counted).not.toHaveProperty("store");
  const { store: _store, stream: _stream, max_output_tokens: _max, ...shared } = request;
  expect(counted).toEqual(shared);
  expect(solPayloadHash({ a: 1, b: { d: 2, c: 3 } })).toBe(solPayloadHash({ b: { c: 3, d: 2 }, a: 1 }));
});

test("unpaired and duplicate tool calls fail before transport", () => {
  expect(() => solInput([{ role: "tool", tool_call_id: "orphan", content: "Synthetic output." }])).toThrow("SOL_UNPAIRED_TOOL_PROTOCOL");
  const assistant: Messages[number] = { role: "assistant", content: null, tool_calls: [{ id: "duplicate", type: "function", function: { name: "source", arguments: "{}" } }] };
  expect(() => solInput([assistant])).toThrow("SOL_UNPAIRED_TOOL_PROTOCOL");
  expect(() => solInput([assistant, { role: "tool", tool_call_id: "duplicate", content: "first" }, assistant, { role: "tool", tool_call_id: "duplicate", content: "second" }])).toThrow("SOL_INVALID_TOOL_CALLS");
});

test("generation saves visible output and authoritative usage without credentials or provider reasoning", async () => {
  const f = fixture(), sent: { endpoint: string; body: any }[] = [];
  try {
    const backend = new SolBackend({ ...f.options, fetchRequest: async (url, init) => {
      expect(init.redirect).toBe("error"); expect((init.headers as any).authorization).toBe("Bearer SYNTHETIC_KEY_SENTINEL");
      sent.push({ endpoint: url.href, body: JSON.parse(init.body as string) });
      const state = JSON.parse(readFileSync(resolve(f.directory, "sol-backend-state.json"), "utf8"));
      if (url.pathname.endsWith("input_tokens")) { expect(state.countCalls).toBe(1); expect(state.countMetrics[0].status).toBe("pending"); return count(); }
      expect(state.calls).toBe(1); expect(state.metrics[0].status).toBe("pending"); expect(state.reservedCostUsd).toBeGreaterThan(0); return response();
    } });
    const result = await backend.complete(messages, tools, "answer:fixture", 8192);
    expect(result).toEqual({ message: { role: "assistant", content: "Synthetic visible answer." }, inputTokens: 100, outputTokens: 5000 });
    expect(backend.calls).toBe(1); expect(backend.countCalls).toBe(1); expect(backend.costUsd).toBeCloseTo(0.05025);
    expect(backend.metrics[0]).toMatchObject({ inputTokens: 100, outputTokens: 5000, reasoningTokens: 4999, cachedInputTokens: 50, success: true, providerStatus: "completed" });
    expect(sent.map(item => item.endpoint)).toEqual([solBackendProtocol.countEndpoint, solBackendProtocol.endpoint]);
    expect(sent[1]!.body.max_output_tokens).toBe(8192);
    for (const path of allFiles(f.directory)) {
      const captured = readFileSync(path, "utf8");
      for (const secret of ["SYNTHETIC_KEY_SENTINEL", "HIDDEN_REASONING_SENTINEL", "HIDDEN_SUMMARY_SENTINEL", "HIDDEN_ID_SENTINEL", "PRIVATE_PROVIDER_SENTINEL", "ANNOTATION_SENTINEL", "LOGPROB_SENTINEL", "PROVIDER_ITEM_ID_SENTINEL", "PROVIDER_PHASE_SENTINEL"]) expect(captured).not.toContain(secret);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(statSync(f.directory).mode & 0o777).toBe(0o700);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("function response replay uses call_id and excludes provider item IDs", async () => {
  const f = fixture();
  try {
    const backend = new SolBackend({ ...f.options, fetchRequest: async url => url.pathname.endsWith("input_tokens") ? count() : response({ output: 50, outputItems: [{ type: "function_call", id: "PROVIDER_FUNCTION_ID", call_id: "call_visible", name: "source", arguments: '{"id":"synthetic"}', status: "completed", private: "PRIVATE_FIELD" }] }) });
    const result = await backend.complete(messages, tools, "answer", 8192);
    expect(result.message).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "call_visible", type: "function", function: { name: "source", arguments: '{"id":"synthetic"}' } }] });
    const replay = solInput([...messages, result.message, { role: "tool", tool_call_id: "call_visible", content: "Synthetic output." }]);
    expect(replay.at(-2)).toEqual({ type: "function_call", call_id: "call_visible", name: "source", arguments: '{"id":"synthetic"}' });
    expect(JSON.stringify(replay)).not.toContain("PROVIDER_FUNCTION_ID");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("count caches separate answer and grader reasoning and survive resume", async () => {
  const f = fixture(), efforts: string[] = [];
  const fetchRequest = async (_url: URL, init: RequestInit) => { const body = JSON.parse(init.body as string); efforts.push(body.reasoning.effort); return count(body.reasoning.effort === "medium" ? 100 : 90); };
  try {
    const backend = new SolBackend({ ...f.options, fetchRequest });
    expect(await backend.countRequestTokens(messages, [], 8192, "answer")).toBe(100);
    expect(await backend.countRequestTokens(messages, [], 4096, "answer")).toBe(100);
    expect(await backend.countRequestTokens(messages, [], 8192, "grade:fixture")).toBe(90);
    const resumed = new SolBackend({ ...f.options, fetchRequest });
    expect(resumed.startedAt).toBe(backend.startedAt); expect(resumed.countCalls).toBe(2);
    expect(await resumed.countRequestTokens(messages, [], 8192, "grade:fixture")).toBe(90);
    expect(efforts).toEqual(["medium", "low"]);
    await expect(backend.countRequestTokens(messages, [], 8192, "answer")).rejects.toThrow("SOL_CONCURRENT_EVALUATION");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("missing usage blocks later spending and preserves the unresolved reservation without retries", async () => {
  const f = fixture(); let generated = 0;
  try {
    const backend = new SolBackend({ ...f.options, fetchRequest: async url => url.pathname.endsWith("input_tokens") ? count() : (generated++, response({ noUsage: true })) });
    await expect(backend.complete(messages, [], "answer", 8192)).rejects.toThrow("SOL_USAGE_UNRESOLVED");
    await expect(backend.complete(messages, [], "answer:next", 8192)).rejects.toThrow("SOL_USAGE_UNRESOLVED");
    expect(generated).toBe(1); expect(backend.calls).toBe(1); expect(backend.haltedCode).toBe("SOL_USAGE_UNRESOLVED");
    const state = JSON.parse(readFileSync(resolve(f.directory, "sol-backend-state.json"), "utf8"));
    expect(state.reservedCostUsd).toBeGreaterThan(0); expect(state.metrics[0].success).toBe(false);
    const resumed = new SolBackend({ ...f.options, fetchRequest: async () => { throw Error("MUST_NOT_DISPATCH"); } });
    await expect(resumed.countRequestTokens(messages, [], 8192)).rejects.toThrow("SOL_USAGE_UNRESOLVED");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("input-count mismatch records authoritative charges and halts later requests", async () => {
  const f = fixture(); let generated = 0;
  try {
    const backend = new SolBackend({ ...f.options, fetchRequest: async url => url.pathname.endsWith("input_tokens") ? count() : (generated++, response({ input: 101 })) });
    await expect(backend.complete(messages, [], "answer", 8192)).rejects.toThrow("SOL_INPUT_COUNT_MISMATCH");
    expect(backend.metrics[0]).toMatchObject({ inputTokens: 101, outputTokens: 5000, success: false, code: "SOL_INPUT_COUNT_MISMATCH" });
    expect(backend.costUsd).toBeCloseTo(0.0502525);
    await expect(backend.complete(messages, [], "next", 8192)).rejects.toThrow("SOL_INPUT_COUNT_MISMATCH"); expect(generated).toBe(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("incomplete output retains its usage and visible receipt without accepting its candidate", async () => {
  const f = fixture(); let generated = 0;
  try {
    const backend = new SolBackend({ ...f.options, fetchRequest: async url => url.pathname.endsWith("input_tokens") ? count() : (generated++, response({ status: "incomplete", output: 8192 })) });
    await expect(backend.complete(messages, [], "answer:final", 8192)).rejects.toThrow("MODEL_OUTPUT_INCOMPLETE");
    expect(generated).toBe(1); expect(backend.haltedCode).toBeNull();
    expect(backend.metrics[0]).toMatchObject({ expectedInputTokens: 100, inputTokens: 100, outputTokens: 8192, providerStatus: "incomplete", code: "MODEL_OUTPUT_INCOMPLETE", success: false });
    const capture = JSON.parse(readFileSync(resolve(f.directory, "calls", "000001", "output.json"), "utf8"));
    expect(capture.incomplete_details).toEqual({ reason: "max_output_tokens" }); expect(capture.usage.output_tokens).toBe(8192);
    expect(capture.output[0].content[0].text).toBe("Synthetic visible answer.");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("serial dispatch and resume retain request accounting and finite limits", async () => {
  const f = fixture({ maxCalls: 2 }); let active = 0, maximum = 0;
  const fetchRequest = async (url: URL) => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return url.pathname.endsWith("input_tokens") ? count() : response(); };
  try {
    const backend = new SolBackend({ ...f.options, fetchRequest });
    await Promise.all([backend.complete(messages, [], "answer:first", 8192), backend.complete(messages, [], "answer:second", 8192)]);
    expect(maximum).toBe(1); expect(backend.calls).toBe(2); expect(backend.countCalls).toBe(1);
    const resumed = new SolBackend({ ...f.options, fetchRequest });
    expect(resumed.calls).toBe(2); expect(resumed.startedAt).toBe(backend.startedAt); expect(resumed.costUsd).toBeCloseTo(backend.costUsd);
    await expect(resumed.complete(messages, [], "answer:third", 8192)).rejects.toThrow("SOL_CALL_LIMIT");
    expect(() => new SolBackend({ ...f.options, maxCalls: 3, fetchRequest })).toThrow("SOL_RESUME_MISMATCH");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("the price reservation rejects an unaffordable call before generation", async () => {
  const f = fixture({ maxCostUsd: 0.01 }); let generated = 0;
  try {
    const backend = new SolBackend({ ...f.options, fetchRequest: async url => url.pathname.endsWith("input_tokens") ? count() : (generated++, response()) });
    await expect(backend.complete(messages, [], "answer", 8192)).rejects.toThrow("SOL_COST_LIMIT");
    expect(generated).toBe(0); expect(backend.calls).toBe(0); expect(backend.countCalls).toBe(1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("stop markers reject constructor and abort an in-flight request", async () => {
  const f = fixture();
  try {
    writeFileSync(resolve(f.root, "user-requested-stop.json"), "{}", { mode: 0o600 });
    expect(() => new SolBackend({ ...f.options, stopDirectory: f.root })).toThrow("SOL_USER_STOPPED");
    rmSync(resolve(f.root, "user-requested-stop.json"));
    let generated = 0;
    const backend = new SolBackend({ ...f.options, stopDirectory: f.root, fetchRequest: async (url, init) => {
      if (url.pathname.endsWith("input_tokens")) return count();
      generated++; writeFileSync(resolve(f.root, "user-requested-stop.json"), "{}", { mode: 0o600 });
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(Error("HIDDEN_TRANSPORT_SENTINEL")), { once: true }));
    } });
    const outcomes = await Promise.allSettled([backend.complete(messages, [], "answer", 8192), backend.complete(messages, [], "queued", 8192)]);
    expect(outcomes[0]!.status).toBe("rejected"); expect(outcomes[1]!.status).toBe("rejected");
    for (const outcome of outcomes) if (outcome.status === "rejected") expect(outcome.reason.code).toBe("SOL_USER_STOPPED");
    expect(generated).toBe(1); expect(backend.calls).toBe(1); expect(backend.haltedCode).toBe("SOL_USAGE_UNRESOLVED");
    expect(JSON.stringify(backend.metrics)).not.toContain("HIDDEN_TRANSPORT_SENTINEL");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("HTTP failures do not capture or expose provider error bodies", async () => {
  const f = fixture(); let attempts = 0;
  try {
    const backend = new SolBackend({ ...f.options, fetchRequest: async url => url.pathname.endsWith("input_tokens") ? count() : (attempts++, new Response("HIDDEN_ERROR_SENTINEL", { status: 429 })) });
    await expect(backend.complete(messages, [], "answer", 8192)).rejects.toThrow("SOL_HTTP_429");
    expect(attempts).toBe(1); expect(backend.haltedCode).toBe("SOL_USAGE_UNRESOLVED");
    for (const path of allFiles(f.directory)) expect(readFileSync(path, "utf8")).not.toContain("HIDDEN_ERROR_SENTINEL");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("invalid profiles and context overflow reject generation before spending", async () => {
  const f = fixture(); let generated = 0;
  try {
    for (const maxCostUsd of [0, NaN, Infinity, 61]) expect(() => new SolBackend({ ...f.options, maxCostUsd })).toThrow("SOL_INVALID_LIMITS");
    expect(() => new SolBackend({ ...f.options, answerReasoning: "none" as any })).toThrow("SOL_INVALID_REASONING");
    const backend = new SolBackend({ ...f.options, fetchRequest: async url => url.pathname.endsWith("input_tokens") ? count(23553) : (generated++, response()) });
    await expect(backend.complete(messages, [], "answer", 8192)).rejects.toThrow("SOL_CONTEXT_BUDGET"); expect(generated).toBe(0); expect(backend.calls).toBe(0);
    expect(() => backend.complete(messages, [], "answer", 8193)).toThrow("SOL_INVALID_OUTPUT_LIMIT");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("the visible response whitelist ignores hidden and unknown output items", () => {
  const visible = visibleSolResponse({ id: "fixture", model: solBackendProtocol.model, status: "completed", output: [
    { type: "reasoning", encrypted_content: "HIDDEN_REASONING_SENTINEL" }, { type: "unknown", body: "HIDDEN_PROVIDER_SENTINEL" },
    { type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "Synthetic visible refusal.", extra: "HIDDEN_REFUSAL_METADATA" }] },
  ] });
  expect(visible.output).toEqual([{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "Synthetic visible refusal." }] }]);
  expect(JSON.stringify(visible)).not.toContain("HIDDEN_");
});

test("refusal output remains visible evidence and receives an explicit failure", async () => {
  const f = fixture();
  try {
    const backend = new SolBackend({ ...f.options, fetchRequest: async url => url.pathname.endsWith("input_tokens") ? count() : response({ output: 20, outputItems: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "Synthetic refusal." }] }] }) });
    await expect(backend.complete(messages, [], "answer", 8192)).rejects.toThrow("MODEL_REFUSAL");
    expect(backend.metrics[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, success: false, code: "MODEL_REFUSAL" });
    expect(backend.haltedCode).toBeNull();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("mutable endpoint changes cannot send authentication to another origin", async () => {
  const f = fixture(); let fetched = 0;
  try {
    const backend = new SolBackend({ ...f.options, fetchRequest: async () => { fetched++; return count(); } });
    backend.countEndpoint.hostname = "example.invalid";
    await expect(backend.countRequestTokens(messages, [], 8192)).rejects.toThrow("SOL_ENDPOINT_MISMATCH");
    expect(fetched).toBe(0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an active dispatch prevents a second constructor from changing its ledger", async () => {
  const f = fixture(); let release: ((value: Response) => void) | undefined;
  try {
    const backend = new SolBackend({ ...f.options, fetchRequest: async () => new Promise<Response>(resolve => { release = resolve; }) });
    const pending = backend.countRequestTokens(messages, [], 8192);
    await Promise.resolve(); await Promise.resolve();
    const previous = readFileSync(resolve(f.directory, "sol-backend-state.json"), "utf8");
    expect(() => new SolBackend(f.options)).toThrow("SOL_CONCURRENT_EVALUATION");
    expect(readFileSync(resolve(f.directory, "sol-backend-state.json"), "utf8")).toBe(previous);
    release!(count()); expect(await pending).toBe(100);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

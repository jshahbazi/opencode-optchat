import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Store, hash, sourceKey, type SourceRecord } from "../src/index.ts";
import { answerQuestion, archiveTexts, grade, LocalBackend, loopbackURL, parseAnswer, prepare, protocol, recentRecords, requestBody, resolveMaxCalls, resolveProvider, resolveSummaryOptions, runCLI, visibleResponse, type Backend, type ModelResult, type Receipt } from "../scripts/local-memory-eval.ts";

function fixtureSource(payload: string, seq = 0): SourceRecord {
  return { sessionId: "s-91e5", generation: 0, eventKey: `e-${seq}`, turnId: "turn", kind: "assistant", timestamp: "2026-01-01T00:00:00Z", payload, projectId: "fixture", seq, payloadHash: hash(payload) };
}
function response(content: string, calls?: ModelResult["message"]["tool_calls"]): ModelResult {
  return { message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) }, inputTokens: 1, outputTokens: 1 };
}
function call(name: string, input: unknown, id = "call-1") {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(input) } };
}
function compactorFixture(): Backend & { calls: number; stages: string[]; batchPrompts: number } {
  const text = "Synthetic evidence preserves accepted decisions and failed attempts. Original records remain available through retrieval references. Proposed work has no verified success. ".repeat(2);
  return { calls: 0, stages: [], batchPrompts: 0, async complete(messages, _tools, stage) {
    this.calls++; this.stages.push(stage);
    const prompt = messages[0]!.content!;
    if (prompt.includes("BATCH_CONTRACT")) {
      this.batchPrompts++;
      const rows = JSON.parse(prompt.split("UNTRUSTED_JSON_DATA:\n").at(-1)!);
      return response(JSON.stringify(rows.map((r: { id: number }) => ({ id: r.id, text }))));
    }
    return response(text);
  } };
}

test("local evaluation rejects non-loopback, credentials, redirects, and ambiguous endpoints", () => {
  expect(loopbackURL("http://127.0.0.1:18089/v1/chat/completions").port).toBe("18089");
  expect(loopbackURL("http://[::1]:18089/v1/chat/completions").hostname).toBe("[::1]");
  for (const value of ["https://localhost/v1/chat/completions", "http://remote.test/v1/chat/completions", "http://127.0.0.1.evil/v1/chat/completions", "http://user:secret@localhost/v1/chat/completions", "http://localhost/v1/chat/completions?key=x", "http://localhost/v1/models"]) expect(() => loopbackURL(value)).toThrow();
});

test("provider request profiles select the verified thinking flag without model calls", async () => {
  const messages = [{ role: "user", content: "Synthetic fixture." }];
  const llama = requestBody("fixture", messages, [], 512), mlx = requestBody("fixture", messages, [], 512, "mlx");
  expect(resolveProvider()).toBe("llama"); expect(resolveProvider("mlx")).toBe("mlx");
  expect("chat_template_kwargs" in llama ? llama.chat_template_kwargs : undefined).toEqual({ enable_thinking: false }); expect(Object.hasOwn(llama, "enable_thinking")).toBe(false);
  expect("enable_thinking" in mlx ? mlx.enable_thinking : undefined).toBe(false); expect(Object.hasOwn(mlx, "chat_template_kwargs")).toBe(false);
  expect(mlx.messages).toEqual(messages); expect(mlx.max_tokens).toBe(512);
  await expect(runCLI(["--dry-run", "--url", "http://127.0.0.1:11234/v1/chat/completions", "--model", "fixture", "--provider", "other"])).rejects.toThrow("INVALID_PROVIDER_PROFILE");
});

test("CLI call limits preserve the default and require an integer from one through 200", async () => {
  expect(resolveMaxCalls()).toBe(100); expect(resolveMaxCalls("160")).toBe(160); expect(resolveMaxCalls("1")).toBe(1); expect(resolveMaxCalls("200")).toBe(200);
  const base = ["--dry-run", "--url", "http://127.0.0.1:11234/v1/chat/completions", "--model", "fixture", "--max-calls"];
  for (const value of ["0", "201", "1.5", "invalid"]) await expect(runCLI([...base, value])).rejects.toThrow("INVALID_CALL_LIMIT");
});

test("answer parsing enforces exact schema and excludes prose, fences, and extra fields", () => {
  expect(parseAnswer('{"facts":{"value":null},"evidence":[]}')).toEqual({ facts: { value: null }, evidence: [] });
  for (const value of ['```json\n{"facts":{},"evidence":[]}\n```', '{"facts":{},"evidence":[],"extra":1}', '{"facts":{"value":8},"evidence":[]}', '{"facts":[],"evidence":[]}', '{"facts":{},"evidence":["x","x"]}']) expect(parseAnswer(value)).toBeNull();
});

test("exact facts require a complete original receipt and supporting source citation", () => {
  const source = fixtureSource("Recorded value is fixture-value."), id = sourceKey(source);
  const question = { id: "q-fixture", category: "fixture", text: "Return value.", expected: { value: "fixture-value" }, evidence: { value: [0] } };
  const answer = { facts: { value: "fixture-value" }, evidence: [id] };
  const receipt: Receipt = { sourceId: id, payloadHash: source.payloadHash, returnedHash: source.payloadHash, bytes: source.payload.length, complete: true, exact: true };
  expect(grade(question, answer, [source], []).factsPass).toBe(true);
  expect(grade(question, answer, [source], []).evidencePass).toBe(false);
  expect(grade(question, answer, [source], [{ ...receipt, complete: false }]).pass).toBe(false);
  expect(grade(question, answer, [source], [{ ...receipt, returnedHash: hash("wrong") }]).pass).toBe(false);
  expect(grade(question, answer, [source], [receipt]).pass).toBe(true);
  expect(grade(question, { ...answer, facts: { value: "fixture-value", injected: null } }, [source], [receipt]).jsonValid).toBe(false);
});

test("unsupported fields require null and no unsupported citations", () => {
  const source = fixtureSource("Fixture evidence."), id = sourceKey(source);
  const question = { id: "q-fixture", category: "fixture", text: "Return value.", expected: { value: null }, evidence: { value: [] } };
  expect(grade(question, { facts: { value: null }, evidence: [] }, [source], []).pass).toBe(true);
  expect(grade(question, { facts: { value: "unknown" }, evidence: [] }, [source], []).pass).toBe(false);
  expect(grade(question, { facts: { value: null }, evidence: [id] }, [source], []).evidencePass).toBe(false);
  const negative = { ...question, evidence: { value: [0] } }, receipt: Receipt = { sourceId: id, payloadHash: source.payloadHash, returnedHash: source.payloadHash, bytes: source.payload.length, complete: true, exact: true };
  expect(grade(negative, { facts: { value: null }, evidence: [id] }, [source], [receipt]).pass).toBe(true);
});

test("the recent arm uses a contiguous suffix within the evidence budget", () => {
  const sources = Array.from({ length: 8 }, (_, index) => fixtureSource(`Entry ${index} ` + "content ".repeat(25), index));
  const selected = recentRecords(sources, 600);
  expect(selected.length).toBeGreaterThan(0); expect(selected.length).toBeLessThan(8);
  expect(selected.at(-1)!.seq).toBe(7);
  expect(selected.map(r => r.seq)).toEqual(Array.from({ length: selected.length }, (_, index) => 8 - selected.length + index));
  expect(Buffer.byteLength(JSON.stringify(selected.map(r => ({ sourceId: sourceKey(r), text: r.payload }))))).toBeLessThanOrEqual(600);
});

test("preparation retains originals, merges shared ranges, and stays question blind", async () => {
  const store = new Store(), backend = compactorFixture();
  try {
    const prepared = await prepare(backend, store);
    expect(prepared.sources.map(r => r.payload)).toEqual([...archiveTexts]);
    expect(prepared.metrics.originalHashesValid).toBe(true); expect(prepared.metrics.publications).toBe(8);
    expect(prepared.metrics.projectionBytes).toBeLessThanOrEqual(protocol.memoryBytes);
    expect(prepared.metrics.selectedRangeMaxCount).toBeGreaterThan(1);
    expect(prepared.metrics.projectionMaxDepth).toBeGreaterThan(2);
    expect(backend.calls).toBeGreaterThan(0); expect(backend.stages.every(stage => stage === "summary")).toBe(true);
    expect(backend.batchPrompts).toBeGreaterThan(0); expect(prepared.metrics.summaryMode).toBe("batch");
    expect(prepared.metrics.fallbackNodes).toBe(0);
    expect(prepared.metrics.maxSummaryBytes).toBeLessThanOrEqual(protocol.summaryAcceptBytes);
  } finally { store.close(); }
});

test("serial preparation uses real single-item summarization without peer batch prompts", async () => {
  const store = new Store(), backend = compactorFixture();
  try {
    const prepared = await prepare(backend, store, archiveTexts, undefined, { mode: "serial", retries: 5 });
    expect(backend.calls).toBeGreaterThan(0); expect(backend.batchPrompts).toBe(0);
    expect(prepared.metrics.summaryMode).toBe("serial"); expect(prepared.metrics.summaryRetries).toBe(5); expect(prepared.metrics.summaryBatchSize).toBe(1);
    expect(prepared.engine.options.parentBatchSize).toBe(1); expect(prepared.engine.options.leafBatchSize).toBe(1);
    expect(prepared.sources.map(r => r.payload)).toEqual([...archiveTexts]); expect(prepared.metrics.publications).toBe(8);
  } finally { store.close(); }
});

test("summary options preserve registered defaults and reject invalid CLI modes or retry counts", async () => {
  expect(resolveSummaryOptions()).toEqual({ mode: "batch", retries: 3, batchSize: 8 });
  const base = ["--dry-run", "--url", "http://127.0.0.1:18089/v1/chat/completions", "--model", "fixture"];
  for (const option of [["--summary-mode", "other"], ["--summary-retries", "0"], ["--summary-retries", "6"], ["--summary-retries", "1.5"], ["--summary-retries", "invalid"]]) await expect(runCLI([...base, ...option])).rejects.toThrow("INVALID_SUMMARY_OPTIONS");
});

test("OptChat executes paginated search, zoom, and codepoint source reads before scoring", async () => {
  const store = new Store(), prepareBackend = compactorFixture();
  try {
    const text = "αβγδ value is fixture-value.", prepared = await prepare(prepareBackend, store, [text, "Other synthetic record.", "Another synthetic record.", "Last synthetic record."]);
    const source = prepared.sources[0]!, id = sourceKey(source), question = { id: "q-fixture", category: "fixture", text: "Return value.", expected: { value: "fixture-value" }, evidence: { value: [0] } };
    const replies = [
      response("", [call("optchat_search", { query: "value", offset: 0, limit: 1 })]),
      response("", [call("optchat_zoom", { nodeId: prepared.snapshot.view.nodes[0]!, offset: 0, limit: 1 })]),
      response("", [call("optchat_source", { sourceId: id, offset: 0, maxBytes: 4 })]),
      response("", [call("optchat_source", { sourceId: id, offset: 2, maxBytes: 32768 })]),
      response(JSON.stringify({ facts: { value: "fixture-value" }, evidence: [id] })),
    ];
    let calls = 0;
    const backend: Backend = { async complete() { return replies[calls++]!; } };
    const result = await answerQuestion(backend, prepared.engine, prepared.snapshot, prepared.sources, question, "optchat");
    expect(result.public.pass).toBe(true); expect(result.public.steps).toBe(5);
    expect(result.public.toolCounts).toEqual({ search: 1, source: 2, zoom: 1, errors: 0 });
    expect(result.private.receipts.at(-1)!.returnedHash).toBe(source.payloadHash);
    const sourceMessages = result.private.messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content!)).filter(m => m.sourceId);
    expect(sourceMessages[0]!.text).toBe("αβ"); expect(sourceMessages[0]!.next).toBe(2);
  } finally { store.close(); }
});

test("a claim from search snippets alone fails original receipt scoring", async () => {
  const store = new Store(), prepareBackend = compactorFixture();
  try {
    const prepared = await prepare(prepareBackend, store, ["Value is fixture-value."]);
    const id = sourceKey(prepared.sources[0]!), question = { id: "q-fixture", category: "fixture", text: "Return value.", expected: { value: "fixture-value" }, evidence: { value: [0] } };
    let calls = 0;
    const backend: Backend = { async complete() { return calls++ === 0 ? response("", [call("optchat_search", { query: "Value" })]) : response(JSON.stringify({ facts: { value: "fixture-value" }, evidence: [id] })); } };
    const result = await answerQuestion(backend, prepared.engine, prepared.snapshot, prepared.sources, question, "optchat");
    expect(result.public.factsPass).toBe(true); expect(result.public.evidencePass).toBe(false);
  } finally { store.close(); }
});

test("an endless tool loop stops at the primary step limit with sanitized failures", async () => {
  const store = new Store(), prepareBackend = compactorFixture();
  try {
    const prepared = await prepare(prepareBackend, store, ["Fixture evidence."]);
    const backend: Backend = { async complete() { return response("", [call("optchat_source", { sourceId: "unavailable-private-marker" })]); } };
    const question = { id: "q-fixture", category: "fixture", text: "Return value.", expected: { value: "fixture-value" }, evidence: { value: [0] } };
    const result = await answerQuestion(backend, prepared.engine, prepared.snapshot, prepared.sources, question, "optchat");
    expect(result.public.steps).toBe(protocol.maxAnswerSteps); expect(result.public.failure).toBe("ANSWER_STEP_LIMIT");
    expect(result.public.finalize).toBe(false); expect(result.public.finalizationCalls).toBe(0);
    expect(result.public.toolCounts.errors).toBe(protocol.maxAnswerSteps);
    expect(JSON.stringify(result.public)).not.toContain("unavailable-private-marker");
    expect(JSON.parse(result.private.messages.find(m => m.role === "tool")!.content!)).toEqual({ error: "NOT_FOUND" });
  } finally { store.close(); }
});

test("optional finalization consumes the final tool result without exposing more tools", async () => {
  const store = new Store(), prepareBackend = compactorFixture();
  try {
    const prepared = await prepare(prepareBackend, store, ["Recorded value is fixture-value."]);
    const source = prepared.sources[0]!, id = sourceKey(source), question = { id: "q-fixture", category: "fixture", text: "Return value.", expected: { value: "fixture-value" }, evidence: { value: [0] } };
    let calls = 0;
    const backend: Backend = { async complete(messages, tools) {
      calls++;
      if (calls < protocol.maxAnswerSteps) return response("", [call("optchat_search", { query: "No matching fixture phrase" }, `call-${calls}`)]);
      if (calls === protocol.maxAnswerSteps) return response("", [call("optchat_source", { sourceId: id }, `call-${calls}`)]);
      expect(tools).toEqual([]);
      const lastTool = messages.filter(m => m.role === "tool").at(-1)!;
      expect(JSON.parse(lastTool.content!).text).toBe(source.payload);
      return response(JSON.stringify({ facts: { value: "fixture-value" }, evidence: [id] }));
    } };
    const result = await answerQuestion(backend, prepared.engine, prepared.snapshot, prepared.sources, question, "optchat", { finalize: true });
    expect(result.public.pass).toBe(true); expect(result.public.steps).toBe(7); expect(calls).toBe(7);
    expect(result.public.finalizationCalls).toBe(1); expect(result.public.failure).toBeNull();
    expect(result.public.toolCounts).toEqual({ search: 5, source: 1, zoom: 0, errors: 0 });
  } finally { store.close(); }
});

test("the backend enforces its call cap before any socket or artifact operation", async () => {
  const backend = new LocalBackend("http://127.0.0.1:18089/v1/chat/completions", "fixture", "/does-not-exist", 0);
  await expect(backend.complete([], [], "fixture", 1)).rejects.toThrow("CALL_LIMIT");
});

test("saved responses retain visible protocol and discard hidden provider fields", () => {
  const raw = { private_provider_state: "private-marker", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "visible fixture", reasoning_content: "hidden-marker", private_state: "private-marker", tool_calls: [{ ...call("fixture", {}), provider_private: "private-marker" }] } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, hidden: "hidden-marker" } };
  const visible = visibleResponse(raw);
  expect(visible.choices[0]!.message.content).toBe("visible fixture");
  expect(JSON.stringify(visible)).not.toContain("private-marker"); expect(JSON.stringify(visible)).not.toContain("hidden-marker");
  expect(visible.usage.total_tokens).toBe(5);
});

test("dry runs write only private protocol metadata and make no model calls", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "optchat-dry-fixture-")), originalCwd = process.cwd(), originalFetch = globalThis.fetch, originalLog = console.log;
  const printed: unknown[] = [];
  try {
    process.chdir(directory); globalThis.fetch = (() => { throw new Error("Sockets are forbidden in this fixture."); }) as unknown as typeof fetch;
    console.log = (value: unknown) => { printed.push(value); };
    await runCLI(["--dry-run", "--url", "http://127.0.0.1:18089/v1/chat/completions", "--model", "fixture", "--run", "dry-fixture", "--summary-mode", "serial", "--summary-retries", "5", "--provider", "mlx", "--max-calls", "160", "--finalize"]);
    const runDirectory = resolve(directory, ".optchat/local-eval/dry-fixture"), path = resolve(runDirectory, "protocol.json");
    expect(readdirSync(runDirectory)).toEqual(["protocol.json"]);
    const metadata = JSON.parse(readFileSync(path, "utf8"));
    expect(metadata.dryRun).toBe(true); expect(metadata.provider).toBe("mlx"); expect(metadata.maxCalls).toBe(160); expect(metadata.finalize).toBe(true); expect(metadata.summaryMode).toBe("serial"); expect(metadata.summaryRetries).toBe(5); expect(metadata.summaryBatchSize).toBe(1);
    expect(statSync(runDirectory).mode & 0o777).toBe(0o700); expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(printed[0] as string).calls).toBe(0);
  } finally { console.log = originalLog; globalThis.fetch = originalFetch; process.chdir(originalCwd); rmSync(directory, { recursive: true, force: true }); }
});

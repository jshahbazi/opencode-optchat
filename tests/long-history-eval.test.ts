import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Store, bytes, hash, sourceKey } from "../src/index.ts";
import { prepareLongCase, answerLongQuestion, longCaseHashes, longHistoryProtocol, ResumableLocalBackend, runLongCLI, type NormalizedLongCase } from "../scripts/long-history-eval.ts";
import { type Backend, type ModelResult } from "../scripts/local-memory-eval.ts";

const directories: string[] = [], stores: Store[] = [];
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(resolve(tmpdir(), "optchat-long-fixture-")); directories.push(path); return path; }
function store(path?: string) { const value = new Store(path); stores.push(value); return value; }
function data(texts = ["Fixture preference is jasmine tea.", "The user prefers jasmine tea.", "The fixture schedule is Tuesday.", "Tuesday remains selected."]): NormalizedLongCase {
  return { version: 1, source: { repoRevision: "fixture-revision", scaleLabel: "fixture", conversationId: "fixture", rawChatHash: hash("chat"), rawProbeHash: hash("probe"), license: "fixture-license" },
    messages: texts.map((text, seq) => ({ seq, role: seq % 2 ? "assistant" : "user", text, originalId: seq + 1, timeAnchor: seq % 2 ? null : "2026-10-12T00:00:00Z" })),
    questions: [{ id: "q-1", category: "fixture", question: "QUESTION_ONLY_SENTINEL What tea is preferred?", referenceAnswer: "GOLD_ONLY_SENTINEL", rubric: "RUBRIC_ONLY_SENTINEL", sourceReferences: [1], resolvedMessageSeqs: [0], unresolvedReferences: [] }] };
}
const response = (content: string, calls?: ModelResult["message"]["tool_calls"]): ModelResult => ({ message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) }, inputTokens: 1, outputTokens: 1 });
const call = (name: string, input: unknown, id = "call-1") => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(input) } });
function compactor(): Backend & { prompts: string[]; calls: number } {
  return { prompts: [], calls: 0, async complete(messages, _tools, stage) {
    expect(stage).toBe("summary:optchat"); this.calls++; const prompt = messages[0]!.content!; this.prompts.push(prompt);
    const summary = "The fixture retains preferences and schedules. Originals provide complete evidence.";
    if (prompt.includes("BATCH_CONTRACT")) {
      const rows = JSON.parse(prompt.split("UNTRUSTED_JSON_DATA:\n").at(-1)!);
      return response(JSON.stringify(rows.map((row: { id: number }) => ({ id: row.id, text: summary }))));
    }
    return response(summary);
  } };
}

test("long preparation preserves full originals, author roles, metadata, and question blindness", async () => {
  const fixture = data(["Original long evidence αβ ".repeat(700), "Second long evidence ".repeat(100), "Short original.", "Final original."]), backend = compactor(), memory = store();
  const prepared = await prepareLongCase(backend, memory, fixture);
  expect(prepared.sources.map(source => source.payload)).toEqual(fixture.messages.map(message => message.text));
  expect(prepared.sources.map(source => source.kind)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(prepared.metrics.originalHashesValid).toBe(true); expect(prepared.metrics.publications).toBe(2);
  expect(prepared.metrics.chunkNodes).toBeGreaterThan(0); expect(prepared.metrics.summaryModelCalls).toBe(backend.calls);
  expect(prepared.metrics.maxSummaryBytes).toBeLessThanOrEqual(640); expect(prepared.metrics.projectionBytes).toBeLessThanOrEqual(16000);
  for (const marker of ["QUESTION_ONLY_SENTINEL", "GOLD_ONLY_SENTINEL", "RUBRIC_ONLY_SENTINEL"]) expect(backend.prompts.some(prompt => prompt.includes(marker))).toBe(false);
  expect(memory.get<Record<string, unknown>>("longOriginalMetadata", sourceKey(prepared.sources[0]!))).toEqual({ originalId: 1, seq: 0, role: "user", timeAnchor: "2026-10-12T00:00:00Z" });
});

test("completed preparation resumes without model calls or duplicate sources and publications", async () => {
  const path = resolve(directory(), "memory.sqlite"), fixture = data(), first = store(path), backend = compactor();
  const initial = await prepareLongCase(backend, first, fixture), calls = backend.calls;
  stores.splice(stores.indexOf(first), 1); first.close();
  const next = store(path), resumed = await prepareLongCase(backend, next, fixture);
  expect(backend.calls).toBe(calls); expect(resumed.snapshot).toEqual(initial.snapshot); expect(resumed.sources).toEqual(initial.sources);
  expect(resumed.metrics).toEqual(initial.metrics);
  const changed = structuredClone(fixture); changed.questions[0]!.referenceAnswer = "changed";
  await expect(prepareLongCase(backend, next, changed)).rejects.toThrow("PREPARATION_RESUME_MISMATCH");
});

test("failed preparation requires explicit retry and preserves cumulative summary counters", async () => {
  const fixture = data(["Long fixture original ".repeat(200), "Long reply original ".repeat(200)]), memory = store(), fixed = compactor();
  let fail = true;
  const backend: Backend = { complete: (...args) => fail ? Promise.reject(new Error("fixture outage")) : fixed.complete(...args) };
  await expect(prepareLongCase(backend, memory, fixture)).rejects.toThrow("fixture outage");
  await expect(prepareLongCase(backend, memory, fixture)).rejects.toThrow("FAILED_JOBS_REQUIRE_RETRY");
  fail = false;
  const resumed = await prepareLongCase(backend, memory, fixture, { retryFailed: true });
  expect(resumed.sources).toHaveLength(2); expect(resumed.metrics.publications).toBe(1);
  expect(resumed.metrics.jobRetries).toBeGreaterThan(0); expect(resumed.metrics.summaryModelCalls).toBeGreaterThan(fixed.calls);
});

test("natural answers use paginated exact original receipts without sending reference answers", async () => {
  const fixture = data(["αβγδ The fixture preference is jasmine tea.", "A second original."]), prepared = await prepareLongCase(compactor(), store(), fixture), id = sourceKey(prepared.sources[0]!);
  const replies = [response("", [call("optchat_zoom", { id: prepared.snapshot.view.nodes[0]!, limit: 1 })]), response("", [call("optchat_search", { query: "jasmine", limit: 1 })]),
    response("", [call("optchat_source", { id, offset: 0, maxBytes: 4 })]), response("", [call("optchat_source", { id, offset: 2, maxBytes: 32768 })]), response(`The preferred tea is jasmine tea. Source: ${id}`)];
  let index = 0;
  const backend: Backend = { async complete(messages) {
    expect(JSON.stringify(messages)).not.toContain("GOLD_ONLY_SENTINEL"); expect(JSON.stringify(messages)).not.toContain("RUBRIC_ONLY_SENTINEL");
    return replies[index++]!;
  } };
  const answer = await answerLongQuestion(backend, prepared, fixture.questions[0]!);
  expect(answer.private.finalText).toStartWith("The preferred tea"); expect(answer.public.failure).toBeNull();
  expect(answer.public.exactSourceReceipts).toBe(1); expect(answer.private.citations).toEqual([id]); expect(answer.public.toolCounts).toEqual({ search: 1, source: 2, zoom: 1, errors: 0 });
  expect(answer.private.receipts.at(-1)!.returnedHash).toBe(prepared.sources[0]!.payloadHash);
  expect(answer.public.maxRequestTokenBound).toBeLessThanOrEqual(32768 - 2048 - 1024);
});

test("navigation has a fixed round bound and a forced final request with no tools", async () => {
  const fixture = data(), prepared = await prepareLongCase(compactor(), store(), fixture); let count = 0;
  const backend: Backend = { async complete(_messages, tools) {
    count++; if (count <= 2) return response("", [call("optchat_search", { query: "no matching fixture phrase" }, `call-${count}`)]);
    expect(tools).toEqual([]); return response("The supplied evidence does not establish the requested detail.");
  } };
  const answer = await answerLongQuestion(backend, prepared, fixture.questions[0]!, { maxSteps: 2 });
  expect(answer.public.steps).toBe(3); expect(answer.public.finalizationCalls).toBe(1); expect(answer.public.failure).toBeNull();
});

test("recent comparison keeps a contiguous suffix and excludes hidden gold fields", async () => {
  const fixture = data(Array.from({ length: 12 }, (_, index) => `Original ${index} ` + "evidence ".repeat(20))), prepared = await prepareLongCase(compactor(), store(), fixture);
  const backend: Backend = { async complete(messages, tools) {
    expect(tools).toEqual([]); const prompt = messages[0]!.content!;
    expect(prompt).not.toContain("GOLD_ONLY_SENTINEL"); expect(prompt).toContain("Original 11"); expect(prompt).not.toContain("Original 0 ");
    return response("A natural fixture answer.");
  } };
  const answer = await answerLongQuestion(backend, prepared, fixture.questions[0]!, { arm: "recent", recentBytes: 1000 });
  expect(answer.public.failure).toBeNull(); expect(answer.public.steps).toBe(1); expect(answer.public.contextBytes).toBeLessThanOrEqual(1200);
});

test("resumable loopback backend serializes requests, filters captures, and keeps cumulative limits", async () => {
  const root = directory(); let active = 0, peak = 0, sockets = 0;
  globalThis.fetch = (async (_input: unknown, options: RequestInit) => {
    sockets++; active++; peak = Math.max(peak, active);
    const body = JSON.parse(options.body as string); expect(body.enable_thinking).toBe(false); expect(body.temperature).toBe(0);
    await Bun.sleep(5); active--;
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Visible fixture output.", reasoning_content: "HIDDEN_REASONING_SENTINEL", private_state: "HIDDEN_PROVIDER_SENTINEL" } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
  }) as typeof fetch;
  const options = { url: "http://127.0.0.1:18089/v1/chat/completions", model: "fixture", directory: root, maxCalls: 2, maxMinutes: 180 };
  const first = new ResumableLocalBackend(options);
  await Promise.all([first.complete([{ role: "user", content: "Visible fixture input one." }], [], "fixture", 16), first.complete([{ role: "user", content: "Visible fixture input two." }], [], "fixture", 16)]);
  expect(peak).toBe(1); expect(first.calls).toBe(2); expect(first.metrics).toHaveLength(2);
  const restarted = new ResumableLocalBackend(options);
  await expect(restarted.complete([], [], "fixture", 16)).rejects.toThrow("CALL_LIMIT"); expect(sockets).toBe(2);
  const captures = resolve(root, "calls", first.invocation);
  for (const child of readdirSync(captures).filter(name => name !== "invocation.json")) {
    const path = resolve(captures, child, "call-000-output.json"), output = readFileSync(path, "utf8");
    expect(output).toContain("Visible fixture output"); expect(output).not.toContain("HIDDEN_"); expect(statSync(path).mode & 0o777).toBe(0o600);
  }
  expect(statSync(root).mode & 0o777).toBe(0o700);
});

test("resumable backend charges failed calls and retains the deadline across invocations", async () => {
  const root = directory(); let sockets = 0;
  globalThis.fetch = (async () => { sockets++; return new Response("", { status: 503 }); }) as unknown as typeof fetch;
  const options = { url: "http://127.0.0.1:18089/v1/chat/completions", model: "fixture", directory: root, maxCalls: 1, maxMinutes: 180 };
  const first = new ResumableLocalBackend(options);
  await expect(first.complete([], [], "fixture", 16)).rejects.toThrow("HTTP_503"); expect(first.calls).toBe(1);
  const restarted = new ResumableLocalBackend(options); expect(restarted.startedAt).toBe(first.startedAt);
  await expect(restarted.complete([], [], "fixture", 16)).rejects.toThrow("CALL_LIMIT"); expect(sockets).toBe(1);
  expect(() => new ResumableLocalBackend({ ...options, model: "different" })).toThrow("BACKEND_RESUME_MISMATCH");
});

test("long CLI dry run writes private provenance without sockets or source output", async () => {
  const root = directory(), fixture = data(), casePath = resolve(root, "case.json"), run = resolve(root, "run");
  writeFileSync(casePath, JSON.stringify(fixture), { mode: 0o600 });
  globalThis.fetch = (() => { throw new Error("Sockets are forbidden."); }) as unknown as typeof fetch;
  const log = console.log, printed: string[] = []; console.log = value => printed.push(value);
  try { await runLongCLI(["--dry-run", "--case", casePath, "--run", run, "--url", "http://127.0.0.1:18089/v1/chat/completions", "--model", "fixture"]); }
  finally { console.log = log; }
  expect(readdirSync(run)).toEqual(["protocol.json"]); expect(statSync(resolve(run, "protocol.json")).mode & 0o777).toBe(0o600);
  expect(printed.join("\n")).not.toContain("SENTINEL"); expect(JSON.parse(printed[0]!).calls).toBe(0);
  const metadata = JSON.parse(readFileSync(resolve(run, "protocol.json"), "utf8"));
  expect(metadata.hashes).toEqual(longCaseHashes(fixture)); expect(metadata.protocol).toEqual(longHistoryProtocol);
});

test("source delivery budgets account for JSON escaping and never create undelivered complete receipts", async () => {
  const fixture = data([('"\\' + "α").repeat(3000), "A second original."]), prepared = await prepareLongCase(compactor(), store(), fixture), id = sourceKey(prepared.sources[0]!);
  let calls = 0;
  const backend: Backend = { async complete(messages) {
    calls++; if (calls === 1) return response("", [call("optchat_source", { id, maxBytes: 32768 })]);
    const delivered = JSON.parse(messages.find(message => message.role === "tool")!.content!);
    expect(bytes(JSON.stringify(messages))).toBeLessThan(32768 - 2048 - 1024);
    expect(delivered.next).not.toBeNull(); return response("The retrieved source page is incomplete.");
  } };
  const answer = await answerLongQuestion(backend, prepared, fixture.questions[0]!);
  expect(answer.public.failure).toBeNull(); expect(answer.public.exactSourceReceipts).toBe(0);
});

import { afterEach, expect, test } from "bun:test";
import { Store, bytes, hash, sourceKey } from "../src/index.ts";
import { EvalFailure, type Backend } from "../scripts/local-memory-eval.ts";
import { type NormalizedLongCase } from "../scripts/long-history-eval.ts";
import { prepareOptionalParentCase } from "../scripts/optional-parent-preparation.ts";
import { expandedInitialMessages, reconstructExpandedPreparation, type RequestTokenCounter } from "../scripts/expanded-memory-comparison.ts";
import { answerManagedQuestion, assertManagedToolProtocol, managedFinalInstruction } from "../scripts/managed-optchat-controller.ts";

type Message = Parameters<Backend["complete"]>[0][number];
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
async function fixture(texts = ["Fixture original zero establishes a jasmine preference.", "Fixture original one records the verified correction.", "Fixture original two supplies a date.", "Fixture original three supplies an outcome."]) {
  const data: NormalizedLongCase = { version: 1, source: { repoRevision: "fixture", scaleLabel: "fixture", conversationId: "fixture", rawChatHash: hash("fixture-chat"), rawProbeHash: hash("fixture-probe"), license: "fixture" },
    messages: texts.map((text, seq) => ({ seq, role: seq % 2 ? "assistant" : "user", text, originalId: seq + 1, timeAnchor: null })),
    questions: [{ id: "fixture-question", category: "fixture", question: "What does the historical fixture establish?", referenceAnswer: "PRIVATE_REFERENCE_SENTINEL", rubric: "PRIVATE_RUBRIC_SENTINEL", sourceReferences: [1], resolvedMessageSeqs: [0], unresolvedReferences: [] }] };
  const store = new Store(); stores.push(store);
  const compactor: Backend = { async complete() { return { message: { role: "assistant", content: "A synthetic historical fixture contains retained evidence." }, inputTokens: 1, outputTokens: 1 }; } };
  await prepareOptionalParentCase(compactor, store, data);
  const { prepared } = reconstructExpandedPreparation(store, data), question = data.questions[0]!;
  return { data, store, prepared, question, ids: prepared.sources.map(sourceKey), initial: expandedInitialMessages(prepared, question).messages };
}
function tool(name: string, input: unknown, id = "call"): Message {
  return { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }] };
}
const answerMessage: Message = { role: "assistant", content: "The synthetic evidence supports a bounded answer." };
function backend(sequence: Message[], counter: RequestTokenCounter = async () => 1000) {
  return { calls: [] as { messages: Parameters<Backend["complete"]>[0]; tools: unknown[]; stage: string; output: number }[],
    async complete(messages: Parameters<Backend["complete"]>[0], tools: unknown[], stage: string, output: number) {
      this.calls.push({ messages: structuredClone(messages), tools: structuredClone(tools), stage, output });
      const message = sequence[this.calls.length - 1]; if (!message) throw new EvalFailure("UNEXPECTED_FIXTURE_CALL");
      for (const sentinel of ["PRIVATE_REFERENCE_SENTINEL", "PRIVATE_RUBRIC_SENTINEL"]) expect(JSON.stringify(messages)).not.toContain(sentinel);
      return { message: structuredClone(message), inputTokens: await counter(messages, tools, output), outputTokens: 1 };
    } };
}

test("initial messages, tools, and direct answers remain unchanged", async () => {
  const f = await fixture(), b = backend([answerMessage]), initialHash = hash(JSON.stringify(f.initial));
  const result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: async () => 1000 });
  expect(result.public.failure).toBeNull(); expect(result.public.steps).toBe(1); expect(result.public.finalizationCalls).toBe(0);
  expect(b.calls[0]!.messages).toEqual(f.initial); expect(b.calls[0]!.tools).toHaveLength(3); expect(b.calls[0]!.output).toBe(2048);
  expect(hash(JSON.stringify(f.initial))).toBe(initialHash); expect(result.private.deliveredEvidence).toEqual([]);
  expect(result.private.requestReceipts[0]!.inputTokens).toBe(1000); expect(result.private.requestReceipts[0]!.providerInputTokens).toBe(1000);
});

test("near-capacity retrieval finalizes with complete paired results and reserved output", async () => {
  const f = await fixture();
  const counter: RequestTokenCounter = async (messages, tools) => tools.length ? messages.some(message => message.role === "tool") ? 29800 : 25000 : 11000;
  const b = backend([tool("optchat_source", { id: f.ids[0] }), answerMessage], counter);
  const result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: counter });
  expect(result.public.failure).toBeNull(); expect(result.public.finalizationCalls).toBe(1); expect(result.public.controller.budgetFinalizations).toBe(1);
  expect(b.calls).toHaveLength(2); expect(b.calls[1]!.tools).toEqual([]); expect(b.calls[1]!.messages.at(-1)!.content).toBe(managedFinalInstruction);
  expect(result.private.deliveredEvidence).toEqual([{ sourceId: f.ids[0]!, text: f.prepared.sources[0]!.payload, complete: true }]);
  for (const call of b.calls) { expect(call.messages.slice(0, 2)).toEqual(f.initial); expect(call.output).toBe(2048); assertManagedToolProtocol(call.messages); }
  expect(result.private.requestTokenBounds).toEqual([25000, 11000]);
});

test("whole navigation groups retire before original source groups", async () => {
  const f = await fixture(), counter: RequestTokenCounter = async messages => 1000 + messages.filter(message => message.role === "tool").length * 10000;
  const b = backend([tool("optchat_source", { id: f.ids[0] }, "source-zero"), tool("optchat_search", { query: "Fixture" }, "search"), tool("optchat_source", { id: f.ids[1] }, "source-one"), answerMessage], counter);
  const result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: counter });
  expect(result.public.failure).toBeNull(); expect(result.public.controller.navigationGroupEvictions).toBe(1); expect(result.public.controller.sourceGroupEvictions).toBe(0);
  expect(result.private.evictions[0]!.groupIndex).toBe(1); expect(result.private.bufferLedger.at(-1)!.groupIndices).toEqual([0, 2]);
  expect(result.private.submittedMessages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual(["source-zero", "source-one"]);
  expect(result.public.finalCompleteOriginalCount).toBe(2); expect(result.public.everFetchedOriginalCount).toBe(4);
  for (const receipt of result.private.requestReceipts) assertManagedToolProtocol(receipt.messages);
});

test("source retirement preserves the new full page and permits another retrieval round", async () => {
  const f = await fixture(), counter: RequestTokenCounter = async messages => 1000 + messages.filter(message => message.role === "tool").length * 15000;
  const b = backend([tool("optchat_source", { id: f.ids[0] }, "old"), tool("optchat_source", { id: f.ids[1] }, "new"), answerMessage], counter);
  const result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: counter });
  expect(result.public.failure).toBeNull(); expect(result.public.controller.sourceGroupEvictions).toBe(1); expect(result.public.controller.pageReductions).toBe(0); expect(result.public.finalizationCalls).toBe(0);
  expect(result.private.deliveredEvidence).toEqual([{ sourceId: f.ids[1]!, text: f.prepared.sources[1]!.payload, complete: true }]);
  expect(result.public.exactSourceReceipts).toBe(2); expect(result.public.finalCompleteOriginalCount).toBe(1); expect(result.public.everFetchedOriginalCount).toBe(2);
  expect(result.private.bufferLedger.at(-1)!.groupIndices).toEqual([1]); expect(b.calls).toHaveLength(3);
});

test("canonical duplicate requests replace whole groups without context growth", async () => {
  const f = await fixture(), counter: RequestTokenCounter = async messages => 1000 + messages.filter(message => message.role === "tool").length * 15000;
  const b = backend([tool("optchat_source", { id: f.ids[0] }, "first"), tool("optchat_source", { maxBytes: 8192, offset: 0, id: f.ids[0] }, "second"), tool("optchat_source", { id: f.ids[0], offset: 0 }, "third"), answerMessage], counter);
  const result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: counter });
  expect(result.public.failure).toBeNull(); expect(result.public.controller.cacheHits).toBe(2); expect(result.public.controller.duplicateGroupEvictions).toBe(2); expect(result.public.controller.sourceGroupEvictions).toBe(0);
  expect(result.public.controller.maxBufferedGroups).toBe(1); expect(result.private.requestTokenBounds).toEqual([1000, 16000, 16000, 16000]);
  expect(result.private.fullTranscript.filter(message => message.role === "tool")).toHaveLength(3); expect(result.private.submittedMessages.filter(message => message.role === "tool")).toHaveLength(1);
  expect(new Set(result.private.toolExecutions.map(item => item.requestKey)).size).toBe(1); expect(result.public.finalCompleteOriginalCount).toBe(1);
});

test("duplicate requests restore exact cached evidence after its earlier group retires", async () => {
  const f = await fixture(), counter: RequestTokenCounter = async messages => 1000 + messages.filter(message => message.role === "tool").length * 15000;
  const b = backend([tool("optchat_source", { id: f.ids[0] }, "first"), tool("optchat_source", { id: f.ids[1] }, "other"), tool("optchat_source", { id: f.ids[0] }, "restored"), answerMessage], counter);
  const result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: counter });
  expect(result.public.failure).toBeNull(); expect(result.public.controller.cacheHits).toBe(1); expect(result.public.controller.sourceGroupEvictions).toBe(2);
  expect(result.private.deliveredEvidence).toEqual([{ sourceId: f.ids[0]!, text: f.prepared.sources[0]!.payload, complete: true }]);
  expect(result.private.submittedMessages.filter(message => message.role === "tool")[0]!.tool_call_id).toBe("restored");
});

test("a repeat restores the full requested page after context-dependent reduction and retirement", async () => {
  const f = await fixture(["a".repeat(16000), "Fixture other original."]);
  const counter: RequestTokenCounter = async messages => 1000 + (messages.some(message => message.role === "assistant" && message.tool_calls?.some(call => call.id === "first")) ? 15000 : 0) + (messages.some(message => message.role === "assistant" && message.tool_calls?.some(call => call.id === "other")) ? 8000 : 0) + messages.filter(message => message.role === "tool").reduce((sum, message) => sum + bytes(JSON.parse(message.content!).text ?? ""), 0);
  const b = backend([tool("optchat_source", { id: f.ids[0], maxBytes: 32768 }, "first"), tool("optchat_source", { id: f.ids[1] }, "other"), tool("optchat_source", { maxBytes: 32768, id: f.ids[0] }, "restored"), answerMessage], counter);
  const result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: counter });
  expect(result.public.failure).toBeNull(); expect(result.public.controller.sourceGroupEvictions).toBe(1); expect(result.public.controller.cacheHits).toBe(1);
  expect(bytes(result.private.toolExecutions[0]!.result.text)).toBe(8192); expect(result.private.toolExecutions[0]!.result.next).toBe(8192);
  expect(bytes(result.private.toolExecutions[2]!.result.text)).toBe(16000); expect(result.private.toolExecutions[2]!.result.next).toBeNull();
  expect(result.private.deliveredEvidence.find(item => item.sourceId === f.ids[0])!.complete).toBe(true);
});

test("different failed search queries retain their distinct navigation groups", async () => {
  const f = await fixture(), b = backend([tool("optchat_search", { query: "absent-one" }, "one"), tool("optchat_search", { query: "absent-two" }, "two"), answerMessage]);
  const result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: async () => 1000 });
  expect(result.public.failure).toBeNull(); expect(result.public.controller.duplicateGroupEvictions).toBe(0); expect(result.public.controller.cacheHits).toBe(0);
  expect(result.private.bufferLedger.at(-1)!.groupIndices).toEqual([0, 1]); expect(result.private.submittedMessages.filter(message => message.role === "tool")).toHaveLength(2);
  expect(result.private.groups[0]!.resultHashes).toEqual(result.private.groups[1]!.resultHashes); expect(result.private.groups[0]!.requestResultHashes).not.toEqual(result.private.groups[1]!.requestResultHashes);
});

test("mixed batches remain indivisible and every pending call has a result", async () => {
  const f = await fixture(), first = tool("optchat_source", { id: f.ids[0] }, "one");
  first.tool_calls!.push(tool("optchat_search", { query: "Fixture" }, "two").tool_calls![0]!);
  const b = backend([first, answerMessage]), result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: async () => 1000 });
  expect(result.public.failure).toBeNull(); expect(result.private.groups).toHaveLength(1); expect(result.private.groups[0]!.sourceBearing).toBe(true);
  expect(result.private.groups[0]!.messages).toHaveLength(3); expect(result.private.groups[0]!.messages[0]!.tool_calls).toHaveLength(2);
  assertManagedToolProtocol(result.private.submittedMessages); assertManagedToolProtocol(result.private.fullTranscript);
  expect(result.private.submittedMessages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual(["one", "two"]);
});

test("source page resizing uses the API and preserves Unicode offsets and exact counts", async () => {
  const f = await fixture(["😀é".repeat(12000), "Fixture other original."]);
  const counter: RequestTokenCounter = async messages => 1000 + messages.filter(message => message.role === "tool").reduce((sum, message) => sum + bytes(JSON.parse(message.content!).text ?? ""), 0);
  const b = backend([tool("optchat_source", { id: f.ids[0], maxBytes: 32768 }), answerMessage], counter);
  const result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: counter });
  expect(result.public.failure).toBeNull(); expect(result.public.controller.pageReductions).toBe(1); expect(result.private.deliveredEvidence[0]!.complete).toBe(false);
  const execution = result.private.toolExecutions[0]!, text = execution.result.text;
  expect(execution.input!.maxBytes).toBe(16384); expect(bytes(text)).toBeLessThanOrEqual(16384); expect(execution.result.next).toBe(Array.from(text).length);
  expect(f.prepared.sources[0]!.payload.startsWith(text)).toBe(true); expect(text).not.toContain("�");
  for (const receipt of result.private.requestReceipts) { expect(receipt.inputTokens).toBe(await counter(receipt.messages, receipt.tools, receipt.outputTokens)); expect(receipt.providerInputTokens).toBe(receipt.inputTokens); expect(receipt.requestHash).toBe(hash(JSON.stringify({ messages: receipt.messages, tools: receipt.tools, outputTokens: receipt.outputTokens, inputTokens: receipt.inputTokens }))); }
});

test("a later short overlapping page cannot erase complete evidence still in the final request", async () => {
  const f = await fixture(), b = backend([tool("optchat_source", { id: f.ids[0] }, "full"), tool("optchat_source", { id: f.ids[0], maxBytes: 4 }, "partial"), answerMessage]);
  const result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: async () => 1000 });
  expect(result.public.failure).toBeNull(); expect(result.private.submittedMessages.filter(message => message.role === "tool")).toHaveLength(2);
  expect(result.private.deliveredEvidence).toEqual([{ sourceId: f.ids[0]!, text: f.prepared.sources[0]!.payload, complete: true }]);
  expect(result.private.everFetchedEvidence).toEqual(result.private.deliveredEvidence); expect(result.public.finalCompleteOriginalCount).toBe(1);
});

test("overlapping source intervals require complete admitted coverage and preserve holes", async () => {
  const f = await fixture(["abcdefghij", "Fixture other original."]);
  const b = backend([tool("optchat_source", { id: f.ids[0], maxBytes: 8 }, "prefix"), tool("optchat_source", { id: f.ids[0], offset: 4, maxBytes: 8 }, "overlap"), answerMessage]);
  const complete = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: async () => 1000 });
  expect(complete.private.deliveredEvidence).toEqual([{ sourceId: f.ids[0]!, text: "abcdefghij", complete: true }]);
  const gap = backend([tool("optchat_source", { id: f.ids[0], maxBytes: 4 }, "prefix"), tool("optchat_source", { id: f.ids[0], offset: 6, maxBytes: 4 }, "suffix"), answerMessage]);
  const partial = await answerManagedQuestion(gap, f.prepared, f.question, { countRequestTokens: async () => 1000 });
  expect(partial.private.deliveredEvidence.every(item => !item.complete)).toBe(true); expect(partial.private.deliveredEvidence.map(item => item.text)).toEqual(["abcd", "ghij"]);
});

test("unadmittable pending results receive safe acknowledgements before finalization", async () => {
  const f = await fixture(), counter: RequestTokenCounter = async (messages, tools) => messages.some(message => message.role === "tool" && !JSON.parse(message.content!).error) ? 50000 : tools.length ? 1000 : 900;
  const batch = tool("optchat_source", { id: f.ids[0] }, "source"); batch.tool_calls!.push(tool("optchat_search", { query: "Fixture" }, "search").tool_calls![0]!);
  const b = backend([batch, answerMessage], counter), result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: counter });
  expect(result.public.failure).toBeNull(); expect(result.public.finalizationCalls).toBe(1); expect(result.public.controller.budgetFinalizations).toBe(1);
  const results = result.private.submittedMessages.filter(message => message.role === "tool"); expect(results).toHaveLength(2);
  expect(results.every(message => JSON.parse(message.content!).error === "TOOL_CONTEXT_BUDGET")).toBe(true); expect(result.private.deliveredEvidence).toEqual([]);
  assertManagedToolProtocol(result.private.submittedMessages); expect(result.private.fullTranscript.filter(message => message.role === "tool")).toHaveLength(2);
});

test("malformed tool input preserves the rest of its complete batch", async () => {
  const f = await fixture(), message = tool("optchat_source", { id: f.ids[0] }, "valid"); message.tool_calls!.push({ id: "malformed", type: "function", function: { name: "optchat_search", arguments: "{" } });
  const b = backend([message, answerMessage]), result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: async () => 1000 });
  expect(result.public.failure).toBeNull(); expect(result.public.toolCounts.errors).toBe(1); expect(result.public.finalCompleteOriginalCount).toBe(1);
  expect(JSON.parse(result.private.groups[0]!.messages[2]!.content!)).toEqual({ error: "INVALID_TOOL_INPUT" }); assertManagedToolProtocol(result.private.submittedMessages);
});

test("the maximum pending batch is paired before finalization and larger batches stop", async () => {
  const f = await fixture(), counter: RequestTokenCounter = async messages => 1000 + messages.filter(message => message.role === "tool").length * 1000;
  const batch: Message = { role: "assistant", content: "", tool_calls: Array.from({ length: 64 }, (_, index) => tool("optchat_source", { id: f.ids[index % 2] }, `call-${index}`).tool_calls![0]!) };
  const b = backend([batch, answerMessage], counter), result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: counter });
  expect(result.public.failure).toBeNull(); expect(result.public.controller.pendingGroupEvictions).toBe(1); expect(result.public.finalizationCalls).toBe(1);
  expect(result.private.fullTranscript.filter(message => message.role === "tool")).toHaveLength(64); assertManagedToolProtocol(result.private.fullTranscript);
  expect(result.private.submittedMessages.filter(message => message.role === "tool")).toHaveLength(0); expect(result.private.deliveredEvidence).toEqual([]); expect(b.calls[1]!.tools).toEqual([]);
  const excessive = structuredClone(batch); excessive.tool_calls!.push(tool("optchat_source", { id: f.ids[0] }, "extra").tool_calls![0]!);
  const rejected = backend([excessive]), failed = await answerManagedQuestion(rejected, f.prepared, f.question, { countRequestTokens: counter });
  expect(failed.public.failure).toBe("INVALID_TOOL_CALLS"); expect(rejected.calls).toHaveLength(1); expect(failed.private.toolExecutions).toHaveLength(0);
});

test("invalid protocol responses and tokenizer failures cannot dispatch unchecked continuations", async () => {
  const f = await fixture(), duplicate = tool("optchat_source", { id: f.ids[0] }); duplicate.tool_calls!.push(duplicate.tool_calls![0]!);
  const malformed = backend([duplicate]); const result = await answerManagedQuestion(malformed, f.prepared, f.question, { countRequestTokens: async () => 1000 });
  expect(result.public.failure).toBe("INVALID_TOOL_CALLS"); expect(malformed.calls).toHaveLength(1);
  for (const count of [NaN, -1, 1.5, 29697]) {
    const b = backend([answerMessage]), rejected = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: async () => count });
    expect(rejected.public.failure).toBe(count === 29697 ? "ANSWER_CONTEXT_BUDGET" : "INVALID_TOKEN_COUNT"); expect(b.calls).toHaveLength(0);
  }
  const mismatch: Backend = { async complete() { return { message: answerMessage, inputTokens: 999, outputTokens: 1 }; } };
  expect((await answerManagedQuestion(mismatch, f.prepared, f.question, { countRequestTokens: async () => 1000 })).public.failure).toBe("TOKENIZER_COUNT_MISMATCH");
  expect(() => assertManagedToolProtocol([duplicate])).toThrow("INVALID_TOOL_CALLS"); expect(() => assertManagedToolProtocol([tool("optchat_source", {})])).toThrow("UNPAIRED_TOOL_PROTOCOL");
});

test("global resource failures propagate and step exhaustion uses one bounded final call", async () => {
  const f = await fixture();
  for (const code of ["CALL_LIMIT", "RUN_DEADLINE", "CONCURRENT_EVALUATION", "SNAPSHOT_REVOKED"]) {
    const fatal: Backend = { async complete() { throw new EvalFailure(code); } };
    await expect(answerManagedQuestion(fatal, f.prepared, f.question, { countRequestTokens: async () => 1000 })).rejects.toThrow(code);
  }
  const b = backend([tool("optchat_source", { id: f.ids[0] }), answerMessage]), result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: async () => 1000, maxSteps: 1 });
  expect(result.public.failure).toBeNull(); expect(result.public.steps).toBe(2); expect(result.public.finalizationCalls).toBe(1); expect(b.calls[1]!.tools).toEqual([]);
  await expect(answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: async () => 1000, maxSteps: 13 })).rejects.toThrow("INVALID_ANSWER_STEPS");
});

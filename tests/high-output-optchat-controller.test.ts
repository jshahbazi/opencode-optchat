import { afterEach, expect, test } from "bun:test";
import { Store, hash, sourceKey } from "../src/index.ts";
import { EvalFailure, requestBody, type Backend } from "../scripts/local-memory-eval.ts";
import { type NormalizedLongCase } from "../scripts/long-history-eval.ts";
import { prepareOptionalParentCase } from "../scripts/optional-parent-preparation.ts";
import { expandedInitialMessages, reconstructExpandedPreparation, type RequestTokenCounter } from "../scripts/expanded-memory-comparison.ts";
import { answerManagedQuestion as answerOriginal, managedControllerProtocol as originalProtocol } from "../scripts/managed-optchat-controller.ts";
import { answerManagedQuestion, assertManagedToolProtocol, managedControllerProtocol, managedInputTokens, managedFinalInstruction } from "../scripts/high-output-optchat-controller.ts";

type Message = Parameters<Backend["complete"]>[0][number];
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

async function fixture() {
  const data: NormalizedLongCase = {
    version: 1,
    source: { repoRevision: "fixture", scaleLabel: "fixture", conversationId: "fixture", rawChatHash: hash("fixture-chat"), rawProbeHash: hash("fixture-probe"), license: "fixture" },
    messages: ["Synthetic original records jasmine tea.", "Synthetic correction records mint tea."].map((text, seq) => ({ seq, role: seq % 2 ? "assistant" : "user", text, originalId: seq + 1, timeAnchor: null })),
    questions: [{ id: "fixture-question", category: "fixture", question: "What does the synthetic evidence establish?", referenceAnswer: "PRIVATE_REFERENCE_SENTINEL", rubric: "PRIVATE_RUBRIC_SENTINEL", sourceReferences: [1], resolvedMessageSeqs: [0], unresolvedReferences: [] }],
  };
  const store = new Store(); stores.push(store);
  const compactor: Backend = { async complete() { return { message: { role: "assistant", content: "Synthetic historical evidence contains a preference and a correction." }, inputTokens: 1, outputTokens: 1 }; } };
  await prepareOptionalParentCase(compactor, store, data);
  const { prepared } = reconstructExpandedPreparation(store, data), question = data.questions[0]!;
  return { prepared, question, ids: prepared.sources.map(sourceKey), initial: expandedInitialMessages(prepared, question).messages };
}

function tool(id: string, callId: string): Message {
  return { role: "assistant", content: "", tool_calls: [{ id: callId, type: "function", function: { name: "optchat_source", arguments: JSON.stringify({ id }) } }] };
}
const finalAnswer: Message = { role: "assistant", content: "The synthetic evidence establishes the corrected preference." };

function backend(sequence: Message[], counter: RequestTokenCounter, generatedTokens = 1) {
  return {
    calls: [] as { messages: Parameters<Backend["complete"]>[0]; tools: unknown[]; output: number; body: Record<string, unknown> }[],
    async complete(messages: Parameters<Backend["complete"]>[0], tools: unknown[], stage: string, output: number) {
      this.calls.push({ messages: structuredClone(messages), tools: structuredClone(tools), output, body: requestBody("synthetic-model", messages, tools, output, "mlx") });
      const message = sequence[this.calls.length - 1];
      if (!message) throw new EvalFailure("UNEXPECTED_FIXTURE_CALL");
      for (const sentinel of ["PRIVATE_REFERENCE_SENTINEL", "PRIVATE_RUBRIC_SENTINEL"]) expect(JSON.stringify(messages)).not.toContain(sentinel);
      return { message: structuredClone(message), inputTokens: await counter(messages, tools, output), outputTokens: generatedTokens };
    },
  };
}

test("the new profile reserves 8K output within 32K and retains the frozen 2K profile", () => {
  expect(managedControllerProtocol.outputTokens).toBe(8192);
  expect(managedControllerProtocol.contextTokens).toBe(32768);
  expect(managedControllerProtocol.safetyTokens).toBe(1024);
  expect(managedInputTokens).toBe(23552);
  expect(managedInputTokens + managedControllerProtocol.outputTokens + managedControllerProtocol.safetyTokens).toBe(32768);
  expect(originalProtocol.outputTokens).toBe(2048);
  expect(managedControllerProtocol.version).not.toBe(originalProtocol.version as string);
});

test("a synthetic answer beyond the former cap uses 8K in counting, transport, and receipts", async () => {
  const f = await fixture(), countedOutputs: number[] = [], longAnswer = { role: "assistant" as const, content: "Synthetic answer. ".repeat(3000) };
  const counter: RequestTokenCounter = async (_messages, _tools, output) => { countedOutputs.push(output); return 1000; };
  const b = backend([longAnswer], counter, 5000), result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: counter });
  expect(result.public.failure).toBeNull(); expect(result.private.finalText).toBe(longAnswer.content);
  expect(b.calls).toHaveLength(1); expect(b.calls[0]!.body.max_tokens).toBe(8192);
  expect(b.calls[0]!.messages).toEqual(f.initial); expect(b.calls[0]!.tools).toHaveLength(3);
  expect(new Set(countedOutputs)).toEqual(new Set([8192]));
  const receipt = result.private.requestReceipts[0]!;
  expect(receipt.outputTokens).toBe(8192); expect(receipt.providerInputTokens).toBe(1000);
  expect(receipt.requestHash).toBe(hash(JSON.stringify({ messages: receipt.messages, tools: receipt.tools, outputTokens: 8192, inputTokens: 1000 })));
});

test("the input admission boundary reserves all output and safety tokens", async () => {
  const f = await fixture();
  for (const input of [23552, 23553, 29696]) {
    const counter: RequestTokenCounter = async () => input, b = backend([finalAnswer], counter);
    const result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: counter });
    expect(result.public.failure).toBe(input === 23552 ? null : "ANSWER_CONTEXT_BUDGET");
    expect(b.calls).toHaveLength(input === 23552 ? 1 : 0);
    for (const receipt of result.private.requestReceipts) expect(receipt.inputTokens + receipt.outputTokens + 1024).toBeLessThanOrEqual(32768);
  }
});

test("near-capacity retrieval reserves 8K in the final request with paired source evidence", async () => {
  const f = await fixture();
  const counter: RequestTokenCounter = async (messages, tools) => tools.length ? messages.some(message => message.role === "tool") ? 24000 : 22000 : 23000;
  const b = backend([tool(f.ids[0]!, "source"), finalAnswer], counter);
  const result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: counter });
  expect(result.public.failure).toBeNull(); expect(result.public.finalizationCalls).toBe(1); expect(b.calls).toHaveLength(2);
  expect(b.calls[1]!.tools).toEqual([]); expect(b.calls[1]!.messages.at(-1)!.content).toBe(managedFinalInstruction);
  expect(result.private.deliveredEvidence).toEqual([{ sourceId: f.ids[0]!, text: f.prepared.sources[0]!.payload, complete: true }]);
  for (const call of b.calls) { expect(call.output).toBe(8192); expect(call.body.max_tokens).toBe(8192); assertManagedToolProtocol(call.messages); }
  expect(result.private.requestTokenBounds).toEqual([22000, 23000]);
});

test("the smaller input allowance retires whole source groups before unsafe dispatch", async () => {
  const f = await fixture(), counter: RequestTokenCounter = async messages => 1000 + messages.filter(message => message.role === "tool").length * 12000;
  const sequence = [tool(f.ids[0]!, "first"), tool(f.ids[1]!, "second"), finalAnswer];
  const high = backend(sequence, counter), old = backend(sequence, counter);
  const result = await answerManagedQuestion(high, f.prepared, f.question, { countRequestTokens: counter });
  const historical = await answerOriginal(old, f.prepared, f.question, { countRequestTokens: counter });
  expect(result.public.failure).toBeNull(); expect(result.public.controller.sourceGroupEvictions).toBe(1);
  expect(historical.public.controller.sourceGroupEvictions).toBe(0);
  expect(result.private.submittedMessages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual(["second"]);
  expect(historical.private.submittedMessages.filter(message => message.role === "tool")).toHaveLength(2);
  expect(result.private.deliveredEvidence).toEqual([{ sourceId: f.ids[1]!, text: f.prepared.sources[1]!.payload, complete: true }]);
  for (const receipt of result.private.requestReceipts) { expect(receipt.inputTokens).toBeLessThanOrEqual(23552); assertManagedToolProtocol(receipt.messages); }
});

test("step exhaustion also sends the larger output allowance to final answering", async () => {
  const f = await fixture(), counter: RequestTokenCounter = async () => 1000;
  const b = backend([tool(f.ids[0]!, "source"), finalAnswer], counter);
  const result = await answerManagedQuestion(b, f.prepared, f.question, { countRequestTokens: counter, maxSteps: 1 });
  expect(result.public.failure).toBeNull(); expect(result.public.finalizationCalls).toBe(1);
  expect(b.calls.map(call => call.output)).toEqual([8192, 8192]);
  expect(b.calls[1]!.tools).toEqual([]);
});

test("incomplete output remains a failure instead of an accepted partial answer", async () => {
  const f = await fixture(), failing: Backend = { async complete(_messages, _tools, _stage, output) { expect(output).toBe(8192); throw new EvalFailure("MODEL_OUTPUT_INCOMPLETE"); } };
  const result = await answerManagedQuestion(failing, f.prepared, f.question, { countRequestTokens: async () => 1000 });
  expect(result.public.failure).toBe("MODEL_OUTPUT_INCOMPLETE"); expect(result.private.finalText).toBe("");
  expect(result.private.requestReceipts).toHaveLength(1);
});

test("a user stop during request counting or dispatch propagates without another attempt", async () => {
  const f = await fixture();
  let calls = 0;
  const stopped: Backend = { async complete() { calls++; throw new EvalFailure("MANAGED_USER_STOPPED"); } };
  await expect(answerManagedQuestion(stopped, f.prepared, f.question, { countRequestTokens: async () => 1000 })).rejects.toThrow("MANAGED_USER_STOPPED");
  expect(calls).toBe(1);
  const uncalled = backend([finalAnswer], async () => 1000);
  await expect(answerManagedQuestion(uncalled, f.prepared, f.question, { countRequestTokens: async () => { throw new EvalFailure("MANAGED_USER_STOPPED"); } })).rejects.toThrow("MANAGED_USER_STOPPED");
  expect(uncalled.calls).toHaveLength(0);
});

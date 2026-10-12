import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { hash } from "../src/index.ts";
import { requestBody } from "../scripts/local-memory-eval.ts";
import { longTools } from "../scripts/long-history-eval.ts";
import type { ComparisonAnswer } from "../scripts/compare-long-history.ts";
import { QWEN_MODEL } from "../scripts/boros-context-driver.ts";
import { managedControllerProtocol, managedFinalInstruction, managedInputTokens } from "../scripts/high-output-optchat-controller.ts";
import { assertManagedRunActive, incompleteReceiptView, managedComparisonProtocol, managedResources, runManagedComparison, verifyManagedCachedAnswer } from "../scripts/high-output-controller-comparison.ts";

function answerFixture(finalizing = false) {
  const question = { id: "synthetic-question", question: "Synthetic current question?", category: "synthetic" };
  const initial = [{ role: "system", content: "Synthetic system instructions." }, { role: "user", content: question.question }];
  const messages = [...initial, ...(finalizing ? [{ role: "user", content: managedFinalInstruction }] : [])];
  const request = { messages, tools: finalizing ? [] : longTools, outputTokens: managedControllerProtocol.outputTokens as number, inputTokens: 22000 };
  const receipt = { ...request, requestHash: hash(JSON.stringify(request)), providerInputTokens: finalizing ? undefined : request.inputTokens };
  const finalText = finalizing ? "" : "Synthetic accepted output.";
  const identityHash = hash("synthetic-new-experiment");
  const answer: ComparisonAnswer = {
    public: { questionId: question.id, questionHash: hash(question.question), category: question.category, arm: "optchat", failure: finalizing ? "MODEL_OUTPUT_INCOMPLETE" : undefined, protocolHash: hash(JSON.stringify(managedControllerProtocol)), steps: 1, answerCalls: 1, finalizationCalls: Number(finalizing), maxRequestTokenBound: request.inputTokens },
    private: { managedIdentityHash: identityHash, finalText, submittedMessages: messages, requestReceipts: [receipt], groups: [], evictions: [], bufferLedger: [{ requestIndex: 0, groupIndices: [], groupHashes: [], finalizing, messagesHash: hash(JSON.stringify(messages)) }], fullTranscript: [...messages, ...(finalizing ? [] : [{ role: "assistant", content: finalText }])], deliveredEvidence: [] },
  };
  return { question, initial, identityHash, answer };
}

function incompleteFixture(finalizing = true) {
  const base = answerFixture(finalizing), receipt = (base.answer.private.requestReceipts as any[])[0];
  base.answer.public.failure = "MODEL_OUTPUT_INCOMPLETE";
  base.answer.private.finalText = "";
  base.answer.private.fullTranscript = receipt.messages;
  receipt.providerInputTokens = undefined;
  const outputTokens = managedControllerProtocol.outputTokens;
  const captureInput = requestBody(QWEN_MODEL, receipt.messages, receipt.tools, outputTokens, "mlx");
  const captureOutput = { choices: [{ finish_reason: "length", message: { role: "assistant", content: "UNACCEPTED_SYNTHETIC_PARTIAL_OUTPUT", tool_calls: [] } }], usage: { prompt_tokens: receipt.inputTokens, completion_tokens: outputTokens, total_tokens: receipt.inputTokens + outputTokens } };
  const metric = { call: 1, invocation: "2ce2b484-1279-4523-9cf4-3a87ed88e19a", stage: `answer:optchat:${base.question.id}${finalizing ? ":final" : ""}`, inputTokens: receipt.inputTokens, outputTokens: outputTokens as number, success: false, code: "MODEL_OUTPUT_INCOMPLETE" };
  return { ...base, captureInput, captureOutput, metric };
}

function persistFailure(root: string, fixture: ReturnType<typeof incompleteFixture>) {
  const candidatePath = resolve(root, "answer.json"), candidateBytes = JSON.stringify(fixture.answer);
  writeFileSync(candidatePath, candidateBytes);
  writeFileSync(resolve(root, "backend-state.json"), JSON.stringify({ calls: 1, metrics: [fixture.metric] }));
  const callsRoot = resolve(root, "calls", fixture.metric.invocation, "000001");
  mkdirSync(callsRoot, { recursive: true });
  writeFileSync(resolve(callsRoot, "call-000-input.json"), JSON.stringify(fixture.captureInput));
  writeFileSync(resolve(callsRoot, "call-000-output.json"), JSON.stringify(fixture.captureOutput));
  return { candidatePath, candidateBytes, proofPath: resolve(root, "managed-failed-receipt-proofs", `${hash(fixture.question.id).slice(0, 16)}.json`) };
}

test("the high-output comparison derives all answering limits from its controller", () => {
  expect(managedComparisonProtocol.version).toBe("beam-managed-controller-comparison-2-8k");
  expect(managedControllerProtocol.version).toBe("bounded-optchat-controller-2-8k");
  expect(managedComparisonProtocol.contextTokens).toBe(32768);
  expect(managedComparisonProtocol.outputTokens).toBe(8192);
  expect(managedComparisonProtocol.safetyTokens).toBe(1024);
  expect(managedComparisonProtocol.requestTimeoutMs).toBe(600000);
  expect(managedInputTokens).toBe(23552);
  expect(managedInputTokens + managedComparisonProtocol.outputTokens + managedComparisonProtocol.safetyTokens).toBe(managedComparisonProtocol.contextTokens);
});

test("high-output resources preserve their own deadline and reject older profiles", () => {
  const root = mkdtempSync(resolve(tmpdir(), "high-output-resource-fixture-"));
  try {
    const first = managedResources(root, 2628, 95), statePath = resolve(root, "backend-state.json");
    expect(first.version).toBe(managedComparisonProtocol.version);
    expect(first.profile).toEqual({ contextTokens: 32768, outputTokens: 8192, safetyTokens: 1024 });
    expect(first.priorManagedCalls).toBe(196);
    expect(first.deadlineAt - first.startedAt).toBe(3600000);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.calls).toBe(0);
    state.calls = 7; writeFileSync(statePath, JSON.stringify(state));
    expect(managedResources(root, 2628, 95)).toEqual(first);
    expect(JSON.parse(readFileSync(statePath, "utf8")).calls).toBe(7);
    expect(() => managedResources(root, 2629, 95)).toThrow("MANAGED_RESOURCE_MISMATCH");
    expect(() => managedResources(root, 2628, 95, 195)).toThrow("MANAGED_RESOURCE_MISMATCH");
    const resourcePath = resolve(root, "managed-resources.json");
    for (const mutation of [
      (value: any) => { value.version = "beam-managed-controller-comparison-1"; },
      (value: any) => { value.profile.outputTokens = 2048; },
      (value: any) => { value.profile.contextTokens = 65536; },
      (value: any) => { value.profile.safetyTokens = 0; },
      (value: any) => { value.deadlineAt++; },
    ]) {
      const changed = structuredClone(first); mutation(changed); writeFileSync(resourcePath, JSON.stringify(changed));
      expect(() => managedResources(root, 2628, 95)).toThrow("MANAGED_RESOURCE_MISMATCH");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stop marker rejects resource and runner work before any writes or source reads", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "high-output-stop-fixture-"));
  try {
    const markerPath = resolve(root, "user-requested-stop.json"), marker = JSON.stringify({ resumeRequiresExplicitAuthorization: true });
    writeFileSync(markerPath, marker, { mode: 0o600 });
    expect(() => assertManagedRunActive(root)).toThrow("MANAGED_USER_STOPPED");
    expect(() => managedResources(root, 2628, 95)).toThrow("MANAGED_USER_STOPPED");
    await expect(runManagedComparison(["--source-run", resolve(root, "missing-source"), "--run", root, "--case", resolve(root, "missing-case"), "--supplement", resolve(root, "missing-supplement"), "--mode", "freeze"])).rejects.toThrow("MANAGED_USER_STOPPED");
    expect(readdirSync(root)).toEqual(["user-requested-stop.json"]);
    expect(readFileSync(markerPath, "utf8")).toBe(marker);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cached answers must use the new output cap and reduced input allowance", () => {
  const fixture = answerFixture();
  expect(() => verifyManagedCachedAnswer(fixture.answer, fixture.initial, fixture.identityHash, fixture.question as any)).not.toThrow();
  const mutations = [
    (receipt: any) => { receipt.outputTokens = 2048; },
    (receipt: any) => { receipt.outputTokens = 4096; },
    (receipt: any) => { receipt.inputTokens = managedInputTokens + 1; receipt.providerInputTokens = receipt.inputTokens; },
    (receipt: any) => { receipt.inputTokens = 29696; receipt.providerInputTokens = receipt.inputTokens; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(fixture.answer), receipt = (changed.private.requestReceipts as any[])[0];
    mutate(receipt);
    receipt.requestHash = hash(JSON.stringify({ messages: receipt.messages, tools: receipt.tools, outputTokens: receipt.outputTokens, inputTokens: receipt.inputTokens }));
    expect(() => verifyManagedCachedAnswer(changed, fixture.initial, fixture.identityHash, fixture.question as any)).toThrow("MANAGED_ANSWER_MISMATCH");
  }
});

test("incomplete output authentication supplements only a cloned provider count at the new cap", () => {
  const fixture = incompleteFixture(), before = hash(JSON.stringify(fixture.answer));
  const view = incompleteReceiptView(fixture.answer, fixture.captureInput, fixture.captureOutput, fixture.metric, fixture.question.id);
  expect(hash(JSON.stringify(fixture.answer))).toBe(before);
  expect((fixture.answer.private.requestReceipts as any[])[0].providerInputTokens).toBeUndefined();
  expect((view.private.requestReceipts as any[])[0].providerInputTokens).toBe(22000);
  expect(view.private.finalText).toBe("");
  expect(view.public.failure).toBe("MODEL_OUTPUT_INCOMPLETE");
  expect(JSON.stringify(view)).not.toContain("UNACCEPTED_SYNTHETIC_PARTIAL_OUTPUT");
  expect(() => verifyManagedCachedAnswer(view, fixture.initial, fixture.identityHash, fixture.question as any)).not.toThrow();
  expect(() => verifyManagedCachedAnswer(fixture.answer, fixture.initial, fixture.identityHash, fixture.question as any)).toThrow("MANAGED_FAILED_RECEIPT_PROOF_REQUIRED");
});

test("direct-answer length failures authenticate with the unchanged navigation tools", () => {
  const fixture = incompleteFixture(false), before = hash(JSON.stringify(fixture.answer));
  const view = incompleteReceiptView(fixture.answer, fixture.captureInput, fixture.captureOutput, fixture.metric, fixture.question.id);
  expect(hash(JSON.stringify(fixture.answer))).toBe(before);
  expect(view.public.finalizationCalls).toBe(0);
  expect((view.private.requestReceipts as any[])[0].tools).toEqual(longTools);
  expect((view.private.requestReceipts as any[])[0].providerInputTokens).toBe(22000);
  expect(view.private.finalText).toBe("");
  expect(() => verifyManagedCachedAnswer(view, fixture.initial, fixture.identityHash, fixture.question as any)).not.toThrow();
  for (const mutation of [
    (f: ReturnType<typeof incompleteFixture>) => { f.metric.stage = `answer:optchat:${f.question.id}:final`; },
    (f: ReturnType<typeof incompleteFixture>) => { f.answer.public.finalizationCalls = 1; },
    (f: ReturnType<typeof incompleteFixture>) => { (f.captureOutput.choices[0]!.message.tool_calls as any[]).push({ id: "synthetic-unfinished-call", type: "function", function: { name: "optchat_search", arguments: "{}" } }); },
    (f: ReturnType<typeof incompleteFixture>) => { (f.answer.private.requestReceipts as any[])[0].tools = longTools.slice(0, 1); },
    (f: ReturnType<typeof incompleteFixture>) => { f.captureInput.tools = longTools.slice(0, 1); },
  ]) {
    const changed = incompleteFixture(false); mutation(changed);
    expect(() => incompleteReceiptView(changed.answer, changed.captureInput, changed.captureOutput, changed.metric, changed.question.id)).toThrow("MANAGED_FAILED_RECEIPT_PROOF_MISMATCH");
  }
});

test("incomplete receipt proofs reject old caps, forged tools, changed captures, and partial candidates", () => {
  const mutations: ((fixture: ReturnType<typeof incompleteFixture>) => void)[] = [
    f => { f.captureInput.max_tokens = 2048; }, f => { f.captureInput.temperature = 1; }, f => { f.captureInput.model = "different-model"; },
    f => { f.captureInput.messages[0]!.content = "Changed synthetic input."; }, f => { (f.captureInput as any).enable_thinking = true; },
    f => { f.captureOutput.choices[0]!.finish_reason = "stop"; }, f => { f.captureOutput.usage.prompt_tokens--; }, f => { f.captureOutput.usage.completion_tokens--; }, f => { f.captureOutput.usage.total_tokens--; },
    f => { f.metric.success = true; }, f => { f.metric.code = "HTTP_500"; }, f => { f.metric.inputTokens--; }, f => { f.metric.outputTokens--; }, f => { f.metric.stage = `answer:optchat:${f.question.id}`; }, f => { f.metric.call = 0; }, f => { f.metric.invocation = "../outside"; },
    f => { f.answer.private.finalText = "Synthetic partial candidate."; }, f => { f.answer.public.failure = "EMPTY_ANSWER"; }, f => { f.answer.public.finalizationCalls = 0; },
    f => { (f.answer.private.requestReceipts as any[])[0].tools = longTools.slice(0, 1); }, f => { (f.answer.private.requestReceipts as any[])[0].outputTokens = 2048; },
    f => { (f.answer.private.requestReceipts as any[])[0].providerInputTokens = 22000; }, f => { (f.answer.private.requestReceipts as any[])[0].inputTokens = managedInputTokens + 1; }, f => { (f.answer.private.requestReceipts as any[])[0].requestHash = hash("altered"); },
    f => { (f.answer.private.requestReceipts as any[]).unshift({ inputTokens: 100, providerInputTokens: undefined }); },
  ];
  for (const mutate of mutations) {
    const fixture = incompleteFixture(); mutate(fixture);
    expect(() => incompleteReceiptView(fixture.answer, fixture.captureInput, fixture.captureOutput, fixture.metric, fixture.question.id)).toThrow("MANAGED_FAILED_RECEIPT_PROOF_MISMATCH");
  }
});

test("a persisted final-only failure validates without rewriting its candidate or admitting partial output", () => {
  const root = mkdtempSync(resolve(tmpdir(), "high-output-proof-fixture-"));
  try {
    const fixture = incompleteFixture(), { candidatePath, candidateBytes, proofPath } = persistFailure(root, fixture);
    expect(() => verifyManagedCachedAnswer(fixture.answer, fixture.initial, fixture.identityHash, fixture.question as any, root)).not.toThrow();
    expect(readFileSync(candidatePath, "utf8")).toBe(candidateBytes);
    expect((fixture.answer.private.requestReceipts as any[])[0].providerInputTokens).toBeUndefined();
    expect(existsSync(proofPath)).toBe(true);
    expect(readFileSync(proofPath, "utf8")).not.toContain("UNACCEPTED_SYNTHETIC_PARTIAL_OUTPUT");
    expect(JSON.parse(readFileSync(proofPath, "utf8")).proof.outputTokens).toBe(8192);
    writeFileSync(resolve(root, "user-requested-stop.json"), "{}");
    expect(() => verifyManagedCachedAnswer(fixture.answer, fixture.initial, fixture.identityHash, fixture.question as any, root)).toThrow("MANAGED_USER_STOPPED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a persisted direct-answer failure authenticates the navigation stage and rejects a forged final stage", () => {
  const root = mkdtempSync(resolve(tmpdir(), "high-output-direct-proof-fixture-"));
  try {
    const fixture = incompleteFixture(false), { candidatePath, candidateBytes, proofPath } = persistFailure(root, fixture);
    expect(() => verifyManagedCachedAnswer(fixture.answer, fixture.initial, fixture.identityHash, fixture.question as any, root)).not.toThrow();
    expect(readFileSync(candidatePath, "utf8")).toBe(candidateBytes);
    expect(fixture.answer.private.finalText).toBe("");
    expect(JSON.parse(readFileSync(proofPath, "utf8")).proof.stage).toBe(`answer:optchat:${fixture.question.id}`);
    fixture.metric.stage = `answer:optchat:${fixture.question.id}:final`;
    writeFileSync(resolve(root, "backend-state.json"), JSON.stringify({ calls: 1, metrics: [fixture.metric] }));
    expect(() => verifyManagedCachedAnswer(fixture.answer, fixture.initial, fixture.identityHash, fixture.question as any, root)).toThrow("MANAGED_FAILED_RECEIPT_PROOF_MISMATCH");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

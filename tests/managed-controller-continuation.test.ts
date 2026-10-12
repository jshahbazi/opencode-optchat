import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { hash } from "../src/index.ts";
import { requestBody } from "../scripts/local-memory-eval.ts";
import type { ComparisonAnswer } from "../scripts/compare-long-history.ts";
import { QWEN_MODEL } from "../scripts/boros-context-driver.ts";
import { checkContinuationBindings, incompleteReceiptView, verifyContinuationState } from "../scripts/managed-controller-continuation.ts";

function fixture() {
  const questionId = "synthetic-question", messages = [{ role: "system", content: "Synthetic system instructions." }, { role: "user", content: "Synthetic current question." }, { role: "user", content: "Synthetic finalization." }];
  const request = { messages, tools: [], outputTokens: 2048, inputTokens: 26019 }, receipt = { ...request, requestHash: hash(JSON.stringify(request)) };
  const answer: ComparisonAnswer = { public: { failure: "MODEL_OUTPUT_INCOMPLETE", finalizationCalls: 1, steps: 1, answerCalls: 1 }, private: { finalText: "", deliveredEvidence: [], requestReceipts: [receipt] } };
  const captureInput = requestBody(QWEN_MODEL, messages, [], 2048, "mlx"), captureOutput = { choices: [{ finish_reason: "length", message: { role: "assistant", content: "UNACCEPTED_SYNTHETIC_PARTIAL_OUTPUT", tool_calls: [] } }], usage: { prompt_tokens: 26019, completion_tokens: 2048, total_tokens: 28067 } };
  const metric = { call: 128, invocation: "2ce2b484-1279-4523-9cf4-3a87ed88e19a", stage: `answer:optchat:${questionId}:final`, inputTokens: 26019, outputTokens: 2048, success: false, code: "MODEL_OUTPUT_INCOMPLETE" };
  return { questionId, answer, captureInput, captureOutput, metric };
}

test("authenticated incomplete output supplements only a cloned last provider count", () => {
  const f = fixture(), originalHash = hash(JSON.stringify(f.answer)), view = incompleteReceiptView(f.answer, f.captureInput, f.captureOutput, f.metric, f.questionId);
  expect(hash(JSON.stringify(f.answer))).toBe(originalHash); expect((f.answer.private.requestReceipts as any[])[0].providerInputTokens).toBeUndefined();
  expect((view.private.requestReceipts as any[])[0].providerInputTokens).toBe(26019); expect(view.private.finalText).toBe(""); expect(view.public.failure).toBe("MODEL_OUTPUT_INCOMPLETE");
  expect(JSON.stringify(view)).not.toContain("UNACCEPTED_SYNTHETIC_PARTIAL_OUTPUT"); expect((view.private.requestReceipts as any[])[0].requestHash).toBe((f.answer.private.requestReceipts as any[])[0].requestHash);
  const withoutCalls = structuredClone(f.captureOutput); delete (withoutCalls.choices[0]!.message as any).tool_calls;
  expect((incompleteReceiptView(f.answer, f.captureInput, withoutCalls, f.metric, f.questionId).private.requestReceipts as any[])[0].providerInputTokens).toBe(26019);
});

test("failed receipts reject altered requests, capture usage, metrics, and candidates", () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.captureInput.temperature = 1; }, f => { f.captureInput.model = "different-model"; }, f => { f.captureInput.max_tokens = 4096; },
    f => { f.captureInput.messages[0]!.content = "Different synthetic input."; }, f => { (f.captureInput as any).enable_thinking = true; },
    f => { f.captureOutput.choices[0]!.finish_reason = "stop"; }, f => { f.captureOutput.usage.prompt_tokens--; }, f => { f.captureOutput.usage.completion_tokens--; }, f => { f.captureOutput.usage.total_tokens--; },
    f => { f.metric.success = true; }, f => { f.metric.code = "HTTP_500"; }, f => { f.metric.inputTokens--; }, f => { f.metric.outputTokens--; }, f => { f.metric.stage = "different-stage"; }, f => { f.metric.call = 0; }, f => { f.metric.invocation = "../outside"; },
    f => { f.answer.private.finalText = "A synthetic partial candidate."; }, f => { f.answer.public.failure = "EMPTY_ANSWER"; }, f => { f.answer.public.finalizationCalls = 0; },
    f => { (f.answer.private.requestReceipts as any[])[0].providerInputTokens = 26018; }, f => { (f.answer.private.requestReceipts as any[])[0].requestHash = hash("altered"); },
    f => { (f.answer.private.requestReceipts as any[]).unshift({ inputTokens: 100, providerInputTokens: undefined }); },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); expect(() => incompleteReceiptView(f.answer, f.captureInput, f.captureOutput, f.metric, f.questionId)).toThrow("MANAGED_FAILED_RECEIPT_PROOF_MISMATCH"); }
});

test("continuation resources preserve the original metrics prefix and resource identity", () => {
  const metrics = Array.from({ length: 128 }, (_, index) => ({ call: index + 1, inputTokens: 100, outputTokens: 1, success: true }));
  const state = { version: 1, endpoint: "http://127.0.0.1:11234/v1/chat/completions", model: QWEN_MODEL, provider: "mlx", startedAt: 1000, calls: 128, metrics }, manifest = { ...state, prefixCalls: 128, maxCalls: 320, metricsPrefixHash: hash(JSON.stringify(metrics)) };
  expect(() => verifyContinuationState(state, manifest)).not.toThrow();
  const advanced = { ...state, calls: 129, metrics: [...metrics, { call: 129, inputTokens: 101, outputTokens: 2, success: true }] };
  expect(() => verifyContinuationState(advanced, manifest)).not.toThrow();
  const variants = [
    { ...state, startedAt: 1001 }, { ...state, model: "different-model" }, { ...state, endpoint: "http://127.0.0.1:1234/v1/chat/completions" }, { ...state, provider: "llama" },
    { ...state, calls: 127 }, { ...state, calls: 321 }, { ...state, metrics: metrics.slice(1) }, { ...state, metrics: metrics.map((metric, index) => index ? metric : { ...metric, inputTokens: 101 }) },
  ];
  for (const variant of variants) expect(() => verifyContinuationState(variant, manifest)).toThrow("MANAGED_CONTINUATION_PREFIX_MISMATCH");
});

test("continuation bindings reject changed frozen source or saved candidate bytes", () => {
  const root = mkdtempSync(resolve(tmpdir(), "managed-continuation-bindings-"));
  try {
    const source = resolve(root, "wrapper.ts"), candidate = resolve(root, "answer.json");
    writeFileSync(source, "synthetic frozen source"); writeFileSync(candidate, JSON.stringify({ synthetic: true }));
    const bindings = Object.fromEntries([source, candidate].map(path => [path, new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")]));
    expect(() => checkContinuationBindings(bindings)).not.toThrow();
    writeFileSync(source, "changed synthetic source"); expect(() => checkContinuationBindings(bindings)).toThrow("MANAGED_SOURCE_DRIFT");
    writeFileSync(source, "synthetic frozen source"); writeFileSync(candidate, JSON.stringify({ synthetic: false }));
    expect(() => checkContinuationBindings(bindings)).toThrow("MANAGED_SOURCE_DRIFT");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

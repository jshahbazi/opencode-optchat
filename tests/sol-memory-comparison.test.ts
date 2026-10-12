import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { hash } from "../src/index.ts";
import { beamGraderInstruction, type BeamGradeQuestion } from "../scripts/beam-grader.ts";
import { gradeSolCandidate, solGradeMessages, verifySolGrade, verifySolDispatch, verifySolOptAnswer } from "../scripts/sol-memory-comparison.ts";
import { SolBackend } from "../scripts/sol-responses-backend.ts";
import { longTools } from "../scripts/long-history-eval.ts";
import { managedControllerProtocol } from "../scripts/high-output-optchat-controller.ts";
import type { ComparisonAnswer } from "../scripts/compare-long-history.ts";

const question: BeamGradeQuestion = {
  id: "sol-fixture-question", category: "information_extraction", question: "What color?",
  referenceAnswer: "Blue.", rubric: ["Names blue."], nativeAuthorReference: { opaque: true },
};
const verdict = (correct = true, grounded: null = null) => JSON.stringify({ correct, grounded, confidence: "high" });

function fixtureBackend(output: string, inputTokens = 100) {
  const metrics: any[] = [];
  return {
    calls: 0, metrics,
    async countRequestTokens() { return inputTokens; },
    async complete(_messages: any, _tools: any, stage: string, maxOutputTokens: number) {
      this.calls++;
      metrics.push({ inputTokens, outputTokens: 3, stage, maxOutputTokens });
      return { message: { role: "assistant", content: output }, inputTokens, outputTokens: 3 };
    },
  } as any;
}

test("Sol grading uses the exact blind correctness prompt and no arm metadata", async () => {
  const backend = fixtureBackend(verdict());
  const result = await gradeSolCandidate(backend, { ...question, arm: "BOROS_SENTINEL" } as any, "Blue.", "cell-1", "identity");
  expect(result.binding.inputHash).toBe(hash(JSON.stringify(solGradeMessages(question, "Blue."))));
  expect(result.private.messages[0]!.content).toBe(beamGraderInstruction);
  expect(JSON.stringify(result.private.messages)).not.toContain("BOROS_SENTINEL");
  expect(result.inputTokens).toBe(100);
  expect(result.outputTokens).toBe(8192);
});

test("Sol grading rejects over-budget and grounded or malformed verdicts", async () => {
  const oversized = fixtureBackend(verdict(), 23553);
  const rejected = await gradeSolCandidate(oversized, question, "Blue.", "cell-2", "identity");
  expect(rejected.public.valid).toBe(0);
  expect(rejected.public.failure).toBe("GRADER_CONTEXT_BUDGET");
  for (const output of [verdict(true, true as any), "not-json"]) {
    const result = await gradeSolCandidate(fixtureBackend(output), question, "Blue.", "cell-3", "identity");
    expect(result.public.valid).toBe(0);
    expect(result.public.failure).toBe("GRADER_FORMAT");
  }
});

test("Sol grade verification binds integer counts, hashes, candidate, and cell", async () => {
  const backend = fixtureBackend(verdict());
  const result = await gradeSolCandidate(backend, question, "Blue.", "cell-4", "identity");
  expect(() => verifySolGrade(result, question, "Blue.", "cell-4", "identity")).not.toThrow();
  for (const mutate of [
    (x: any) => { x.inputTokens = 1.5; },
    (x: any) => { x.binding.candidateHash = hash("changed"); },
    (x: any) => { x.private.outputHash = hash("changed"); },
    (x: any) => { x.binding.cellId = "other"; },
  ]) {
    const changed = structuredClone(result); mutate(changed);
    expect(() => verifySolGrade(changed, question, "Blue.", "cell-4", "identity")).toThrow("SOL_GRADE_MISMATCH");
  }
});

test("Sol prompt construction keeps tool protocol stateless and paired", () => {
  const messages = solGradeMessages(question, "Blue.");
  expect(messages).toHaveLength(2);
  expect(messages[0]!.role).toBe("system");
  expect(messages[1]!.role).toBe("user");
  expect(messages[1]!.content).toContain('"candidate":"Blue."');
  expect(messages[1]!.content).not.toContain("arm");
});

async function receiptFixture(incomplete = false) {
  const root = mkdtempSync(resolve(tmpdir(), "sol-receipt-fixture-")), directory = resolve(root, "run"), keyFile = resolve(root, "synthetic-key.txt");
  writeFileSync(keyFile, "SYNTHETIC_KEY", { mode: 0o600 });
  const initial = [{ role: "system", content: "Synthetic instruction." }, { role: "user", content: question.question }];
  const backend = new SolBackend({ directory, keyFile, fetchRequest: async url => url.pathname.endsWith("input_tokens") ? Response.json({ object: "response.input_tokens", input_tokens: 100 }) : Response.json({ id: "fixture", model: "gpt-6.1-sol", status: incomplete ? "incomplete" : "completed", incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
    output: [{ type: "message", role: "assistant", status: incomplete ? "incomplete" : "completed", content: [{ type: "output_text", text: incomplete ? "UNACCEPTED_PARTIAL" : "Blue." }] }], usage: { input_tokens: 100, output_tokens: incomplete ? 8192 : 3, total_tokens: incomplete ? 8292 : 103 } }) });
  try { await backend.complete(initial, longTools, `answer:optchat:${question.id}`, 8192); } catch (error) { if (!incomplete) throw error; }
  const request = { messages: initial, tools: longTools, outputTokens: 8192, inputTokens: 100 };
  const finalText = incomplete ? "" : "Blue.", normalizedQuestion = { ...question, sourceReferences: [], resolvedMessageSeqs: [], unresolvedReferences: [] };
  const answer: ComparisonAnswer = {
    public: { questionId: question.id, questionHash: hash(question.question), category: question.category, arm: "optchat", failure: incomplete ? "MODEL_OUTPUT_INCOMPLETE" : null, protocolHash: hash(JSON.stringify(managedControllerProtocol)), steps: 1, answerCalls: 1, finalizationCalls: 0, maxRequestTokenBound: 100 },
    private: { solIdentityHash: "identity", finalText, submittedMessages: initial, requestReceipts: [{ ...request, requestHash: hash(JSON.stringify(request)), ...(incomplete ? {} : { providerInputTokens: 100 }) }], groups: [], evictions: [], bufferLedger: [{ requestIndex: 0, groupIndices: [], groupHashes: [], finalizing: false, messagesHash: hash(JSON.stringify(initial)) }], fullTranscript: [...initial, ...(incomplete ? [] : [{ role: "assistant", content: finalText }])], deliveredEvidence: [] },
  };
  return { root, directory, backend, initial, answer, normalizedQuestion };
}

test("Sol dispatch receipts reject changed bodies, metrics, and observed usage", async () => {
  const f = await receiptFixture();
  try {
    const metric = f.backend.metrics[0]!;
    expect(() => verifySolDispatch(f.directory, metric, f.initial, longTools, 8192, `answer:optchat:${question.id}`)).not.toThrow();
    const path = resolve(f.directory, "calls", "000001", "input.json"), old = readFileSync(path, "utf8"), body = JSON.parse(old);
    body.max_output_tokens = 2048; writeFileSync(path, JSON.stringify(body));
    expect(() => verifySolDispatch(f.directory, metric, f.initial, longTools, 8192, `answer:optchat:${question.id}`)).toThrow("SOL_DISPATCH_RECEIPT_MISMATCH");
    writeFileSync(path, old);
    expect(() => verifySolDispatch(f.directory, { ...metric, inputTokens: 101 }, f.initial, longTools, 8192, `answer:optchat:${question.id}`)).toThrow("SOL_DISPATCH_RECEIPT_MISMATCH");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Sol OptChat candidates bind their final text to visible provider output", async () => {
  const f = await receiptFixture();
  try {
    expect(() => verifySolOptAnswer(f.directory, f.backend, f.answer, f.initial, f.normalizedQuestion, "identity")).not.toThrow();
    const changed = structuredClone(f.answer); changed.private.finalText = "Invented.";
    (changed.private.fullTranscript as any[]).at(-1).content = "Invented.";
    expect(() => verifySolOptAnswer(f.directory, f.backend, changed, f.initial, f.normalizedQuestion, "identity")).toThrow("SOL_ASSISTANT_RECEIPT_MISMATCH");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("failed Sol receipts supplement only the verifier clone and retain empty candidates", async () => {
  const f = await receiptFixture(true);
  try {
    const old = JSON.stringify(f.answer);
    expect(() => verifySolOptAnswer(f.directory, f.backend, f.answer, f.initial, f.normalizedQuestion, "identity")).not.toThrow();
    expect(JSON.stringify(f.answer)).toBe(old);
    const changed = structuredClone(f.answer); changed.private.finalText = "UNACCEPTED_PARTIAL";
    expect(() => verifySolOptAnswer(f.directory, f.backend, changed, f.initial, f.normalizedQuestion, "identity")).toThrow("SOL_FAILED_ANSWER_RECEIPT_MISMATCH");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

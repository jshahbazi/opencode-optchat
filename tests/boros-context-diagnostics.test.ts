import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { hash } from "../src/index.ts";
import { EvalFailure, type Backend } from "../scripts/local-memory-eval.ts";
import { longAnswerInstruction, type NormalizedLongCase } from "../scripts/long-history-eval.ts";
import { answerDiagnosticRequest, borosDiagnosticProtocol, diagnosticConditions, diagnosticRequest, diagnosticResourceState, diagnosticTokenizerFixture, evidenceReviewSentence, gradeDiagnosticCandidate, selectDiagnosticQuestions, summarizeDiagnosticRows, validateDiagnosticTokenizer, verifyDiagnosticAnswer, verifyDiagnosticGrade } from "../scripts/boros-context-diagnostics.ts";
import { type BeamCalibrationPublic, type BeamGradeQuestion } from "../scripts/beam-grader.ts";

type Messages = Parameters<Backend["complete"]>[0];
function fixture(): NormalizedLongCase {
  return { version: 1, source: { repoRevision: "synthetic", scaleLabel: "synthetic", conversationId: "synthetic", rawChatHash: "synthetic", rawProbeHash: "synthetic", license: "synthetic" },
    messages: Array.from({ length: 12 }, (_, seq) => ({ seq, role: seq % 2 ? "assistant" as const : "user" as const, text: `Synthetic source ${seq}.`, originalId: seq, timeAnchor: null })),
    questions: Array.from({ length: 7 }, (_, index) => ({ id: `synthetic-question-${index}`, category: index < 4 ? `category-${index}` : "category-0", question: `Synthetic question ${index}?`, referenceAnswer: `SYNTHETIC_REFERENCE_${index}`, rubric: { criterion: `SYNTHETIC_RUBRIC_${index}` }, sourceReferences: [0, 1], resolvedMessageSeqs: [1, 0], unresolvedReferences: [] })) };
}
function native(question: string) { return { messages: [{ role: "system", content: longAnswerInstruction + " Synthetic host extension uses [E1]." }, ...Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `Synthetic recent ${index}.` })), { role: "user", content: "Synthetic historical block." }, { role: "user", content: question }] as Messages, recentCount: 8, historicalPresent: true }; }
function backend(options: { output?: string; providerTokens?: number | null; code?: string } = {}) {
  return { calls: 0, startedAt: Date.now(), metrics: [] as { stage: string; latencyMs: number; inputTokens: number | null; outputTokens: number | null; success: boolean }[], async complete(messages: Messages, tools: unknown[], stage: string, maxTokens: number) {
    this.calls++; this.metrics.push({ stage, latencyMs: 1, inputTokens: options.providerTokens === undefined ? 100 : options.providerTokens, outputTokens: 5, success: !options.code });
    if (options.code) throw new EvalFailure(options.code);
    return { message: { role: "assistant", content: options.output ?? "Synthetic answer." }, inputTokens: options.providerTokens === undefined ? 100 : options.providerTokens, outputTokens: 5 };
  } };
}
const calibration: BeamCalibrationPublic = { accepted: 1, questionCount: 1, positiveCount: 1, negativeCount: 1, skippedPositiveCount: 0, positivesAccepted: 1, negativesRejected: 1, invalidCount: 0, lowConfidenceCount: 0 };

describe("Boros development diagnostic transformations", () => {
  test("duplicate native requests preserve every frozen byte and role", () => {
    const data = fixture(), question = data.questions[0]!, context = native(question.question), original = JSON.stringify(context);
    for (const condition of ["native_repeat_1", "native_repeat_2"] as const) expect(diagnosticRequest(data, question, context, condition)).toEqual(context.messages);
    expect(JSON.stringify(context)).toBe(original);
  });
  test("citation alignment changes one sentence and retains original reading instruction", () => {
    const data = fixture(), question = data.questions[0]!, context = native(question.question), result = diagnosticRequest(data, question, context, "citation_aligned");
    expect(result[0]!.content).toBe(context.messages[0]!.content!.replace("Cite exact original sourceId values supporting the answer.", "Cite the assigned host citation labels supporting the answer."));
    expect(result[0]!.content).toContain("Read original records before citing them.");
    expect(result.slice(1)).toEqual(context.messages.slice(1));
    context.messages[0]!.content += " Cite exact original sourceId values supporting the answer.";
    expect(() => diagnosticRequest(data, question, context, "citation_aligned")).toThrow("DIAGNOSTIC_CITATION_RULE_MISMATCH");
  });
  test("evidence review changes only the first system content with the exact general suffix", () => {
    const data = fixture(), question = data.questions[0]!, context = native(question.question), result = diagnosticRequest(data, question, context, "evidence_review");
    expect(result[0]!.role).toBe(context.messages[0]!.role);
    expect(result[0]!.content).toBe(context.messages[0]!.content + " " + evidenceReviewSentence);
    expect(evidenceReviewSentence).toBe("Before answering, inspect the supplied historical excerpts and compare any conflicting or updated statements relevant to the current question.");
    expect(result.slice(1)).toEqual(context.messages.slice(1));
    expect(result.map(message => message.role)).toEqual(context.messages.map(message => message.role));
    expect(result).toHaveLength(context.messages.length);
  });
  test("recent removal retains exact system, historical block, and current question", () => {
    const data = fixture(), question = data.questions[0]!, context = native(question.question);
    expect(diagnosticRequest(data, question, context, "without_recent")).toEqual([context.messages[0]!, context.messages[9]!, context.messages[10]!]);
    expect(() => diagnosticRequest(data, question, { ...context, recentCount: 7 }, "without_recent")).toThrow("DIAGNOSTIC_NATIVE_SHAPE_MISMATCH");
  });
  test("oracle control uses complete canonical originals in sequence order and omits grading data", () => {
    const data = fixture(), question = data.questions[0]!, result = diagnosticRequest(data, question, native(question.question), "oracle_minimal");
    const records = JSON.parse(result[1]!.content!.slice("HISTORICAL_DATA:\n".length));
    expect(records.map((row: any) => row.text)).toEqual([data.messages[0]!.text, data.messages[1]!.text]);
    expect(records.map((row: any) => row.role)).toEqual(["user", "assistant"]);
    expect(records.map((row: any) => row.label)).toEqual(["[E1]", "[E2]"]);
    expect(JSON.stringify(result)).not.toContain(question.referenceAnswer as string);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_RUBRIC");
    expect(JSON.stringify(result)).not.toContain("Synthetic recent");
    expect(() => diagnosticRequest(data, { ...question, resolvedMessageSeqs: [] }, native(question.question), "oracle_minimal")).toThrow("DIAGNOSTIC_ORACLE_SOURCE_MISMATCH");
  });
  test("control selection precedes execution and uses native order with complete nonempty coverage", () => {
    const data = fixture(), rows = data.questions.flatMap((question, index) => ["boros", "optchat"].map(arm => ({ questionId: question.id, arm, correct: index < 4 ? Number(arm === "optchat") : Number(index === 5 || index === 4), valid: 1, acceptedScore: 1, failure: null, fullyDeliveredGoldSources: question.resolvedMessageSeqs.length, answerHash: "synthetic" })));
    data.questions[4]!.resolvedMessageSeqs = [];
    const result = selectDiagnosticQuestions(data, rows);
    expect(result.map(row => row.question.id)).toEqual([0, 1, 2, 3, 5, 6].map(index => `synthetic-question-${index}`));
    expect(result.map(row => row.selection)).toEqual(["optchat_only", "optchat_only", "optchat_only", "optchat_only", "shared_correct", "shared_wrong"]);
    rows[0]!.valid = 0;
    expect(() => selectDiagnosticQuestions(data, rows)).toThrow("DIAGNOSTIC_PUBLISHED_RESULT_MISMATCH");
  });
  test("shared-correct fallback rejects partial references and uses the first fully covered question across categories", () => {
    const data = fixture();
    data.questions[4]!.resolvedMessageSeqs = [];
    data.questions.push({ ...data.questions[0]!, id: "synthetic-fallback-first", category: "outside-discordance" });
    data.questions.push({ ...data.questions[0]!, id: "synthetic-fallback-later", category: "outside-discordance" });
    const rows = data.questions.flatMap((question, index) => ["boros", "optchat"].map(arm => ({ questionId: question.id, arm, correct: index < 4 ? Number(arm === "optchat") : Number(index !== 6), valid: 1, acceptedScore: 1, failure: null, fullyDeliveredGoldSources: index === 5 && arm === "boros" ? 1 : question.resolvedMessageSeqs.length, answerHash: "synthetic" })));
    const selected = selectDiagnosticQuestions(data, rows);
    expect(selected.find(item => item.selection === "shared_correct")?.question.id).toBe("synthetic-fallback-first");
    expect(selected.some(item => item.question.id === "synthetic-question-5")).toBe(false);
    expect(selected.find(item => item.selection === "shared_wrong")?.question.id).toBe("synthetic-question-6");
    rows.find(row => row.questionId === "synthetic-fallback-first" && row.arm === "boros")!.fullyDeliveredGoldSources = 1;
    expect(selectDiagnosticQuestions(data, rows).find(item => item.selection === "shared_correct")?.question.id).toBe("synthetic-fallback-later");
    rows.find(row => row.questionId === "synthetic-fallback-later" && row.arm === "boros")!.fullyDeliveredGoldSources = 1;
    expect(() => selectDiagnosticQuestions(data, rows)).toThrow("DIAGNOSTIC_CONTROL_MISSING");
  });
});

describe("Boros diagnostic accounting and integrity", () => {
  test("answer guard uses actual tokens and does not call a model after oversize admission", async () => {
    const model = backend(), messages = native("Synthetic question?").messages;
    const answer = await answerDiagnosticRequest(model, messages, "synthetic-cell", "synthetic-identity", async () => 29697);
    expect(answer.public.failure).toBe("ANSWER_CONTEXT_BUDGET"); expect(model.calls).toBe(0);
    expect(answer.private.tokenReceipt?.inputTokens).toBe(29697); verifyDiagnosticAnswer(answer, messages, "synthetic-cell", "synthetic-identity");
  });
  test("accepted answers bind request, candidate, count, and provider count", async () => {
    const model = backend(), messages = native("Synthetic question?").messages;
    const answer = await answerDiagnosticRequest(model, messages, "synthetic-cell", "synthetic-identity", async () => 100);
    expect(answer.public.failure).toBeNull(); expect(answer.public.calls).toBe(1); verifyDiagnosticAnswer(answer, messages, "synthetic-cell", "synthetic-identity");
    expect(answer.public.usage.inputTokens).toBe(100);
    const changed = structuredClone(answer); changed.private.finalText += " changed";
    expect(() => verifyDiagnosticAnswer(changed, messages, "synthetic-cell", "synthetic-identity")).toThrow("DIAGNOSTIC_ANSWER_MISMATCH");
    const changedReceipt = structuredClone(answer); changedReceipt.private.tokenReceipt!.providerInputTokens = 99;
    expect(() => verifyDiagnosticAnswer(changedReceipt, messages, "synthetic-cell", "synthetic-identity")).toThrow("DIAGNOSTIC_TOKEN_RECEIPT_MISMATCH");
    const zeroCalls = structuredClone(answer); zeroCalls.public.calls = 0;
    expect(() => verifyDiagnosticAnswer(zeroCalls, messages, "synthetic-cell", "synthetic-identity")).toThrow("DIAGNOSTIC_ANSWER_MISMATCH");
  });
  test("provider mismatches remain visible and global resource failures propagate", async () => {
    const messages = native("Synthetic question?").messages;
    const mismatch = await answerDiagnosticRequest(backend({ providerTokens: 99 }), messages, "synthetic-cell", "synthetic-identity", async () => 100);
    expect(mismatch.public.failure).toBe("TOKENIZER_COUNT_MISMATCH"); expect(mismatch.public.calls).toBe(1);
    for (const code of ["CALL_LIMIT", "RUN_DEADLINE", "CONCURRENT_EVALUATION"]) await expect(answerDiagnosticRequest(backend({ code }), messages, "synthetic-cell", "synthetic-identity", async () => 100)).rejects.toThrow(code);
  });
  test("grading remains blind, correctness-only, and limited to the actual 32K request", async () => {
    const model = backend({ output: JSON.stringify({ correct: true, grounded: null, confidence: "high" }) }), question: BeamGradeQuestion = { ...fixture().questions[0]!, nativeAuthorReference: { criterion: "SYNTHETIC_NATIVE" } };
    const saved = await gradeDiagnosticCandidate(model, question, "Synthetic candidate.", "private-native-repeat_1", "synthetic-identity", calibration, async () => 100);
    verifyDiagnosticGrade(saved, question, "Synthetic candidate.", "private-native-repeat_1", "synthetic-identity");
    expect(saved.grade.public.valid).toBe(1); expect(saved.grade.public.groundingRequested).toBe(0);
    expect(JSON.stringify(saved.grade.private.messages)).not.toContain("private-native-repeat_1");
    expect(JSON.stringify(saved.grade.private.messages)).not.toContain("deliveredEvidence");
    const oversizeModel = backend(), oversize = await gradeDiagnosticCandidate(oversizeModel, question, "Synthetic candidate.", "synthetic-cell", "synthetic-identity", calibration, async () => 31361);
    expect(oversize.grade.private.failure).toBe("GRADER_CONTEXT_BUDGET"); expect(oversizeModel.calls).toBe(0);
    const altered = structuredClone(saved); altered.tokenReceipt!.inputTokens = 101;
    expect(() => verifyDiagnosticGrade(altered, question, "Synthetic candidate.", "private-native-repeat_1", "synthetic-identity")).toThrow("DIAGNOSTIC_TOKEN_RECEIPT_MISMATCH");
    const zeroCalls = structuredClone(saved); zeroCalls.calls = 0;
    expect(() => verifyDiagnosticGrade(zeroCalls, question, "Synthetic candidate.", "private-native-repeat_1", "synthetic-identity")).toThrow("DIAGNOSTIC_GRADE_MISMATCH");
  });
  test("invalid and low-confidence verdicts remain distinct without retry", async () => {
    const question = fixture().questions[0]!, invalidModel = backend({ output: "Synthetic malformed verdict." });
    const invalid = await gradeDiagnosticCandidate(invalidModel, question, "Synthetic candidate.", "synthetic-cell", "synthetic-identity", calibration, async () => 100);
    expect(invalid.grade.public.valid).toBe(0); expect(invalid.grade.private.failure).toBe("GRADER_FORMAT"); expect(invalidModel.calls).toBe(1);
    const low = await gradeDiagnosticCandidate(backend({ output: JSON.stringify({ correct: false, grounded: null, confidence: "low" }) }), question, "Synthetic candidate.", "synthetic-cell", "synthetic-identity", calibration, async () => 100);
    expect(low.grade.public.valid).toBe(1); expect(low.grade.public.confidenceHigh).toBe(0); verifyDiagnosticGrade(low, question, "Synthetic candidate.", "synthetic-cell", "synthetic-identity");
    const semanticInvalid = await gradeDiagnosticCandidate(backend({ output: JSON.stringify({ correct: true, grounded: true, confidence: "high" }) }), question, "Synthetic candidate.", "synthetic-cell", "synthetic-identity", calibration, async () => 100);
    expect(semanticInvalid.grade.public.valid).toBe(0); expect(semanticInvalid.grade.private.failure).toBe("UNEXPECTED_GROUNDING_SCORE");
    verifyDiagnosticGrade(semanticInvalid, question, "Synthetic candidate.", "synthetic-cell", "synthetic-identity");
  });
  test("structural tokenizer check requires exact counts and retains its immutable counter receipt", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "boros-tokenizer-fixture-"));
    try {
      const model = backend(), renderedHash = hash("Synthetic rendered request."), receipt = await validateDiagnosticTokenizer(model, root, "synthetic-identity", renderedHash, async () => 100);
      expect(diagnosticTokenizerFixture().map(message => message.role)).toEqual(["system", "user", "user", "user"]);
      expect(model.calls).toBe(1); expect(receipt.inputTokens).toBe(100);
      expect(await validateDiagnosticTokenizer(model, root, "synthetic-identity", renderedHash, async () => 100)).toEqual(receipt);
      expect(model.calls).toBe(1);
      await expect(validateDiagnosticTokenizer(model, root, "changed-identity", renderedHash, async () => 100)).rejects.toThrow("DIAGNOSTIC_TOKENIZER_PREFLIGHT_FAILED");
      const failedRoot = resolve(root, "failed");
      await expect(validateDiagnosticTokenizer(backend({ providerTokens: 99 }), failedRoot, "synthetic-identity", renderedHash, async () => 100)).rejects.toThrow("DIAGNOSTIC_TOKENIZER_PREFLIGHT_FAILED");
      const failed = JSON.parse(readFileSync(resolve(failedRoot, "diagnostic-tokenizer-validation.json"), "utf8"));
      expect(failed.accepted).toBe(false); expect(failed.callEnd - failed.callStart).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("whole-wave scores require every grade and retain all frozen failure cells", () => {
    const rows = [...diagnosticConditions, "saved_original"].flatMap(condition => Array.from({ length: 6 }, (_, index) => ({ condition, questionLabel: `synthetic-label-${index}`, valid: 1, acceptedScore: 1, correctnessVerdict: 1, confidenceHigh: 1, answerFailure: null as string | null, gradingFailure: null as string | null })));
    expect(summarizeDiagnosticRows(rows).qualityAccepted).toBe(true);
    expect(summarizeDiagnosticRows(rows).conditions.native_repeat_1!.correct).toBe(6);
    const invalid = structuredClone(rows); invalid[0]!.valid = 0; invalid[0]!.acceptedScore = 0;
    const held = summarizeDiagnosticRows(invalid); expect(held.qualityAccepted).toBe(false); expect(Object.values(held.conditions).every(condition => condition.correct === null)).toBe(true); expect(held.rows.every(row => row.correct === null)).toBe(true);
    const tokenFailure = structuredClone(rows); tokenFailure[0]!.answerFailure = "TOKENIZER_COUNT_MISMATCH";
    expect(summarizeDiagnosticRows(tokenFailure).qualityAccepted).toBe(false);
    const ordinaryFailure = structuredClone(rows); ordinaryFailure[0]!.answerFailure = "EMPTY_ANSWER";
    const scored = summarizeDiagnosticRows(ordinaryFailure); expect(scored.qualityAccepted).toBe(true); expect(scored.conditions.native_repeat_1!.cases).toBe(6); expect(scored.conditions.native_repeat_1!.correct).toBe(5); expect(scored.rows[0]!.correct).toBe(0);
    expect(summarizeDiagnosticRows(rows.slice(1)).qualityAccepted).toBe(false);
    const duplicate = structuredClone(rows); duplicate[0]!.questionLabel = duplicate[1]!.questionLabel;
    expect(summarizeDiagnosticRows(duplicate).qualityAccepted).toBe(false);
  });
  test("resource resume preserves start, deadline, and phase counter with original lineage", () => {
    const root = mkdtempSync(resolve(tmpdir(), "boros-diagnostic-fixture-"));
    try {
      const first = diagnosticResourceState(root, 2628, 123), path = resolve(root, "backend-state.json"), state = JSON.parse(readFileSync(path, "utf8"));
      state.calls = 17; writeFileSync(path, JSON.stringify(state));
      const resumed = diagnosticResourceState(root, 2628, 123);
      expect(resumed).toEqual(first); expect(resumed.deadlineAt - resumed.startedAt).toBe(30 * 60000); expect(resumed.maxCalls).toBe(120);
      expect(JSON.parse(readFileSync(path, "utf8")).calls).toBe(17);
      expect(() => diagnosticResourceState(root, 2629, 123)).toThrow("DIAGNOSTIC_RESOURCE_MISMATCH");
      expect(borosDiagnosticProtocol.plannedCalls).toBe(79); expect(hash(JSON.stringify(borosDiagnosticProtocol))).toHaveLength(64);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

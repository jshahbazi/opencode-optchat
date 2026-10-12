import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Store, bytes, hash } from "../src/index.ts";
import { nativeBorosInput } from "../scripts/compare-long-history.ts";
import { answerLongQuestion, prepareLongCase, type NormalizedLongCase } from "../scripts/long-history-eval.ts";
import { EvalFailure, type Backend } from "../scripts/local-memory-eval.ts";
import { answerRecentFromCase, fullNormalizedSources, optPreparationFailure, runBaselineOnly, validateNativeSupplement } from "../scripts/beam-baseline-only.ts";
import { type BorosEnvelope } from "../scripts/boros-context-driver.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const value = mkdtempSync(resolve(tmpdir(), "beam-baseline-fixture-")); directories.push(value); return value; }
function fixture(messageCount = 4): NormalizedLongCase {
  return { version: 1, source: { repoRevision: "fixture", scaleLabel: "fixture", conversationId: "fixture", rawChatHash: hash("fixture-chat"), rawProbeHash: hash("fixture-probe"), license: "fixture" },
    messages: Array.from({ length: messageCount }, (_, seq) => ({ seq, role: seq % 2 ? "assistant" : "user", text: `Original fixture ${seq} ` + "jasmine tea preference and retained context ".repeat(messageCount > 4 ? 25 : 1), originalId: seq + 1, timeAnchor: null })),
    questions: Array.from({ length: 2 }, (_, index) => ({ id: `question-${index}`, category: "fixture-category", question: `What preference is established in fixture ${index}?`, referenceAnswer: "GOLD_SENTINEL jasmine tea", rubric: "RUBRIC_SENTINEL", sourceReferences: [index + 1], resolvedMessageSeqs: [index], unresolvedReferences: [] })) };
}
function acceptedContext(data: NormalizedLongCase, question: NormalizedLongCase["questions"][number]) {
  const input = nativeBorosInput(data, question), source = input.events[0]!;
  const messages = [{ role: "system", content: input.configuration.system }, { role: "user", content: question.question + "\nEvidence: " + source.text }];
  const body = JSON.stringify({ messages, model: input.configuration.model }), selection = JSON.stringify({ citation_labels: [] });
  const envelope: BorosEnvelope = { version: "boros-public-context-v1", corpus_sha256: hash(JSON.stringify(input.events)), cache_reused: true, process_milliseconds: 1,
    attempts: [{ arm: "ordinary_send", preparation_completed: true, runner_started: false, semantic_index_received: false, messages,
      sources: [{ event_id: source.id, project_id: source.project_id, conversation_key: source.conversation_key, role: source.role, kind: "historical", offset: 0,
        bytes: bytes(source.text), source_bytes: bytes(source.text), source_sha256: hash(source.text), excerpt_sha256: hash(source.text), text: source.text }],
      prompt_tokens: 100, body_sha256: hash(body), selection_sha256: hash(selection), request_body_base64: Buffer.from(body).toString("base64"), selection_receipt_base64: Buffer.from(selection).toString("base64"), selection_receipt: JSON.parse(selection), context_audit: {} }] };
  return { input, envelope };
}
function setup(data = fixture()) {
  const root = directory(), run = resolve(root, "run"), casePath = resolve(root, "case.json"), supplementPath = resolve(root, "supplement.json");
  const caseText = JSON.stringify(data); writeFileSync(casePath, caseText, { mode: 0o600 });
  const supplement = { sourceProbeSHA256: data.source.rawProbeHash, normalizedCaseSHA256: hash(caseText), questionCount: data.questions.length,
    questions: Object.fromEntries(data.questions.map(question => [question.id, { answer: question.referenceAnswer, rubric: question.rubric, privateNote: "NATIVE_SENTINEL" }])) };
  writeFileSync(supplementPath, JSON.stringify(supplement), { mode: 0o600 });
  for (const question of data.questions) {
    const path = resolve(run, "boros-contexts", hash(question.id).slice(0, 16)); mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(path, "accepted.json"), JSON.stringify(acceptedContext(data, question)), { mode: 0o600 });
  }
  const args = (mode: string) => ["--case", casePath, "--run", run, "--supplement", supplementPath, "--mode", mode];
  return { root, run, casePath, supplementPath, data, args };
}
function backend() {
  return { calls: 282, metrics: [] as { stage: string; latencyMs: number; inputTokens: number | null; outputTokens: number | null; success: boolean }[], startedAt: Date.now(),
    stages: [] as string[], failAt: 0, failCode: "CALL_LIMIT", rejectPositive: false,
    async complete(messages: Parameters<Backend["complete"]>[0], _tools: unknown[], stage: string) {
      if (this.failAt === this.calls + 1) throw new EvalFailure(this.failCode);
      this.calls++; this.stages.push(stage); this.metrics.push({ stage, latencyMs: 1, inputTokens: 10, outputTokens: 3, success: true });
      if (!stage.startsWith("grade:")) {
        expect(JSON.stringify(messages)).not.toContain("GOLD_SENTINEL"); expect(JSON.stringify(messages)).not.toContain("RUBRIC_SENTINEL"); expect(JSON.stringify(messages)).not.toContain("NATIVE_SENTINEL");
        return { message: { role: "assistant", content: "The established preference is jasmine tea." }, inputTokens: 10, outputTokens: 3 };
      }
      const input = JSON.parse(messages[1]!.content!); expect(JSON.stringify(input)).toContain("NATIVE_SENTINEL");
      return { message: { role: "assistant", content: JSON.stringify({ correct: !this.rejectPositive && !input.candidate.includes("BEAM_FALSE_"), grounded: input.deliveredEvidence ? true : null, confidence: "high" }) }, inputTokens: 10, outputTokens: 3 };
    } };
}
const quiet = () => {};

test("full-history recent baseline matches the existing recent arm without a partial-store dependency", async () => {
  const data = fixture(20), memory = new Store();
  const compactor: Backend = { async complete(messages) {
    const prompt = messages.at(-1)!.content!, text = "The fixture retains an original preference.";
    const content = prompt.includes("BATCH_CONTRACT") ? JSON.stringify(JSON.parse(prompt.split("UNTRUSTED_JSON_DATA:\n").at(-1)!).map((row: { id: number }) => ({ id: row.id, text }))) : text;
    return { message: { role: "assistant", content }, inputTokens: 1, outputTokens: 1 };
  } };
  try {
    const prepared = await prepareLongCase(compactor, memory, data), requests: unknown[] = [];
    const answerer: Backend = { async complete(messages) { requests.push(structuredClone(messages)); return { message: { role: "assistant", content: "A fixture answer." }, inputTokens: 1, outputTokens: 1 }; } };
    const actual = await answerRecentFromCase(answerer, data, data.questions[0]!);
    await answerLongQuestion(answerer, prepared, data.questions[0]!, { arm: "recent" });
    expect(requests[0]).toEqual(requests[1]); expect(fullNormalizedSources(data)).toEqual(prepared.sources);
    expect(actual.public.originalHistoryCount).toBe(20); expect(actual.public.selectedLastSeq).toBe(19); expect(actual.public.selectedFirstSeq).toBeGreaterThan(0);
    expect(JSON.stringify(actual.private.deliveredEvidence)).toContain("Original fixture 19");
  } finally { memory.close(); }
});

test("baseline answers alternate arms and all answers precede calibration and blind grading", async () => {
  const fixture = setup(), model = backend();
  const completed = await runBaselineOnly(fixture.args("answers"), { backend: model, onProgress: quiet });
  expect(completed.answerCells).toBe(4); expect(model.stages).toEqual(["answer:boros:question-0", "answer:recent:question-0", "answer:recent:question-1", "answer:boros:question-1"]);
  const report = await runBaselineOnly(fixture.args("grade"), { backend: model, onProgress: quiet });
  expect(report.qualityComparisonAccepted).toBe(true); expect(Object.keys(report.arms)).toEqual(["boros", "recent"]);
  expect(report.arms.boros.correct).toBe(2); expect(report.arms.recent.correct).toBe(2); expect(model.calls).toBe(294);
  expect(report.optPreparationFailure).toEqual(optPreparationFailure); expect(report.optPreparationFailure.status).toBe("strictPreparationAborted");
  expect(report.optPreparationFailure).not.toHaveProperty("wrongAnswers"); expect(report.arms).not.toHaveProperty("optchat");
  expect(report.arms.boros.answerCalls).toBe(2); expect(report.arms.boros.gradingCalls).toBe(2); expect(report.arms.boros.answerInputTokens).toBe(20);
  const publicText = readFileSync(resolve(fixture.run, "public-result-baseline.json"), "utf8");
  for (const marker of ["GOLD_SENTINEL", "RUBRIC_SENTINEL", "NATIVE_SENTINEL", "The established preference", "What preference", "Original fixture"]) expect(publicText).not.toContain(marker);
  const previous = model.calls;
  await runBaselineOnly(fixture.args("answers"), { backend: model, onProgress: quiet }); await runBaselineOnly(fixture.args("grade"), { backend: model, onProgress: quiet });
  expect(model.calls).toBe(previous);
});

test("fatal answer limits preserve completed cells and resume without caching uncalled answers", async () => {
  const fixture = setup(), model = backend(); model.failAt = 284;
  await expect(runBaselineOnly(fixture.args("answers"), { backend: model, onProgress: quiet })).rejects.toThrow("CALL_LIMIT");
  const files = readdirSync(resolve(fixture.run, "baseline-answers")); expect(files).toHaveLength(1);
  const acceptedPath = resolve(fixture.run, "baseline-answers", files[0]!), content = readFileSync(acceptedPath, "utf8");
  model.failAt = 0;
  await runBaselineOnly(fixture.args("answers"), { backend: model, onProgress: quiet });
  expect(readFileSync(acceptedPath, "utf8")).toBe(content); expect(model.calls).toBe(286); expect(model.stages.filter(stage => stage === "answer:boros:question-0")).toHaveLength(1);
});

test("failed calibration holds the comparison without invented correctness scores", async () => {
  const fixture = setup(), model = backend();
  await runBaselineOnly(fixture.args("answers"), { backend: model, onProgress: quiet }); model.rejectPositive = true;
  const report = await runBaselineOnly(fixture.args("grade"), { backend: model, onProgress: quiet });
  expect(report.qualityComparisonAccepted).toBe(false); expect(report.holdReason).toBe("GRADER_CALIBRATION_FAILED");
  expect(report.arms.boros.correct).toBeNull(); expect(report.arms.recent.grounded).toBeNull(); expect(report.arms.boros.questions).toBe(2);
  expect(existsDirectory(resolve(fixture.run, "baseline-grades"))).toBe(false); expect(model.calls).toBe(290);
});
function existsDirectory(path: string) { try { readdirSync(path); return true; } catch { return false; } }

test("partial calibration resumes completed controls and propagates fatal grading limits", async () => {
  const fixture = setup(), model = backend(); await runBaselineOnly(fixture.args("answers"), { backend: model, onProgress: quiet }); model.failAt = 288;
  await expect(runBaselineOnly(fixture.args("grade"), { backend: model, onProgress: quiet })).rejects.toThrow("CALL_LIMIT");
  expect(readdirSync(resolve(fixture.run, "baseline-calibration-controls"))).toHaveLength(1);
  model.failAt = 0;
  const report = await runBaselineOnly(fixture.args("grade"), { backend: model, onProgress: quiet });
  expect(report.qualityComparisonAccepted).toBe(true); expect(model.calls).toBe(294);
});

test("native supplement checks exact case and probe hashes before inference", () => {
  const data = fixture(), caseHash = hash(JSON.stringify(data));
  const correct = { sourceProbeSHA256: data.source.rawProbeHash, normalizedCaseSHA256: caseHash, questionCount: 2, questions: { "question-0": {}, "question-1": {} } };
  expect(() => validateNativeSupplement(correct, data, caseHash)).not.toThrow();
  expect(() => validateNativeSupplement({ ...correct, sourceProbeSHA256: "changed" }, data, caseHash)).toThrow("NATIVE_REFERENCE_MISMATCH");
  expect(() => validateNativeSupplement(correct, data, "changed")).toThrow("NATIVE_REFERENCE_MISMATCH");
});

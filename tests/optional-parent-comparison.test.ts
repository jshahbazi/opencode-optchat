import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Store, bytes, hash, sourceKey, sessionTree } from "../src/index.ts";
import { EvalFailure, type Backend } from "../scripts/local-memory-eval.ts";
import { nativeBorosInput } from "../scripts/compare-long-history.ts";
import { fullNormalizedSources, runBaselineOnly } from "../scripts/beam-baseline-only.ts";
import { prepareOptionalParentCase } from "../scripts/optional-parent-preparation.ts";
import { optionalDeliveredEvidence, requireCompleteOptionalPreparation, reconstructOptionalPreparation, runOptionalComparison } from "../scripts/optional-parent-comparison.ts";
import { answerLongQuestion, type NormalizedLongCase } from "../scripts/long-history-eval.ts";
import { type BorosEnvelope } from "../scripts/boros-context-driver.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const quiet = () => {};
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
function fixture(): NormalizedLongCase {
  return { version: 1, source: { repoRevision: "fixture", scaleLabel: "fixture", conversationId: "fixture", rawChatHash: hash("chat"), rawProbeHash: hash("probe"), license: "fixture" },
    messages: Array.from({ length: 4 }, (_, seq) => ({ seq, role: seq % 2 ? "assistant" : "user", text: `Original ${seq} has UNDELIVERED_ORIGINAL_SENTINEL and a jasmine tea preference.`, originalId: seq + 1, timeAnchor: null })),
    questions: Array.from({ length: 2 }, (_, index) => ({ id: `q-${index}`, category: "fixture", question: `What preference does fixture ${index} establish?`, referenceAnswer: "GOLD_SENTINEL jasmine tea", rubric: "RUBRIC_SENTINEL", sourceReferences: [1], resolvedMessageSeqs: [0], unresolvedReferences: [] })) };
}
function context(data: NormalizedLongCase, question: NormalizedLongCase["questions"][number]) {
  const input = nativeBorosInput(data, question), event = input.events[0]!, messages = [{ role: "system", content: input.configuration.system }, { role: "user", content: question.question }];
  const body = JSON.stringify({ messages }), selection = JSON.stringify({ citation_labels: [] });
  const envelope: BorosEnvelope = { version: "boros-public-context-v1", corpus_sha256: hash(JSON.stringify(input.events)), cache_reused: true, process_milliseconds: 1,
    attempts: [{ arm: "ordinary_send", preparation_completed: true, runner_started: false, semantic_index_received: false, messages, sources: [{ event_id: event.id,
      project_id: event.project_id, conversation_key: event.conversation_key, role: event.role, kind: "historical", offset: 0, bytes: bytes(event.text), source_bytes: bytes(event.text),
      source_sha256: hash(event.text), excerpt_sha256: hash(event.text), text: event.text }], prompt_tokens: 30, request_body_base64: Buffer.from(body).toString("base64"),
      selection_receipt_base64: Buffer.from(selection).toString("base64"), body_sha256: hash(body), selection_sha256: hash(selection), selection_receipt: JSON.parse(selection), context_audit: {} }] };
  return { input, envelope };
}
function model(data: NormalizedLongCase, answerText = "A natural fixture answer.") {
  const sourceId = sourceKey(fullNormalizedSources(data)[0]!);
  return { calls: 318, startedAt: Date.now(), metrics: [] as { stage: string; latencyMs: number; inputTokens: number | null; outputTokens: number | null; success: boolean }[],
    sourceRead: false, rejectPositive: false, failAt: 0, gradedEvidence: [] as unknown[], stages: [] as string[], answerText,
    async complete(messages: Parameters<Backend["complete"]>[0], _tools: unknown[], stage: string) {
      if (this.calls + 1 === this.failAt) throw new EvalFailure("RUN_DEADLINE");
      this.calls++; this.stages.push(stage); this.metrics.push({ stage, latencyMs: 1, inputTokens: 10, outputTokens: 3, success: true });
      if (stage.startsWith("grade:")) {
        const input = JSON.parse(messages[1]!.content!);
        if (input.deliveredEvidence) this.gradedEvidence.push(input.deliveredEvidence);
        return { message: { role: "assistant", content: JSON.stringify({ correct: !this.rejectPositive && !input.candidate.includes("BEAM_FALSE_"), grounded: input.deliveredEvidence ? true : null, confidence: "high" }) }, inputTokens: 10, outputTokens: 3 };
      }
      for (const marker of ["GOLD_SENTINEL", "RUBRIC_SENTINEL", "NATIVE_SENTINEL"]) expect(JSON.stringify(messages)).not.toContain(marker);
      if (stage === "answer:optchat:q-0" && !this.sourceRead) {
        this.sourceRead = true; return { message: { role: "assistant", content: "", tool_calls: [{ id: "read-1", type: "function" as const, function: { name: "optchat_source", arguments: JSON.stringify({ id: sourceId, offset: 0, maxBytes: 4 }) } }] }, inputTokens: 10, outputTokens: 3 };
      }
      return { message: { role: "assistant", content: this.answerText }, inputTokens: 10, outputTokens: 3 };
    } };
}
async function setup(data = fixture(), answerText = "A natural fixture answer.") {
  const root = mkdtempSync(resolve(tmpdir(), "optional-comparison-fixture-")); directories.push(root);
  const run = resolve(root, "run"), sourceRun = resolve(root, "source"), casePath = resolve(root, "case.json"), supplement = resolve(root, "supplement.json");
  const caseText = JSON.stringify(data); writeFileSync(casePath, caseText, { mode: 0o600 });
  write(supplement, { sourceProbeSHA256: data.source.rawProbeHash, normalizedCaseSHA256: hash(caseText), questionCount: 2, questions: Object.fromEntries(data.questions.map(question => [question.id, { answer: question.referenceAnswer, rubric: question.rubric, privateNote: "NATIVE_SENTINEL" }])) });
  for (const question of data.questions) { const path = resolve(run, "boros-contexts", hash(question.id).slice(0, 16)); mkdirSync(path, { recursive: true, mode: 0o700 }); write(resolve(path, "accepted.json"), context(data, question)); }
  const args = (mode: string) => ["--case", casePath, "--run", run, "--supplement", supplement, "--mode", mode], backend = model(data, answerText);
  await runBaselineOnly(args("answers"), { backend, onProgress: quiet }); expect(backend.calls).toBe(322);
  mkdirSync(sourceRun, { mode: 0o700 }); write(resolve(sourceRun, "backend-state.json"), { calls: 322, startedAt: backend.startedAt });
  write(resolve(run, "optional-parent-copy.json"), { sourceRunDirectory: sourceRun, sourceDatabaseHash: hash("source-database") });
  write(resolve(run, "optional-parent-freeze.json"), { sourceBackendStateHash: hash(readFileSync(resolve(sourceRun, "backend-state.json"), "utf8")) });
  const store = new Store(resolve(run, "memory.sqlite"));
  const summaries: Backend = { async complete() { return { message: { role: "assistant", content: "The fixture preserves an original preference." }, inputTokens: 1, outputTokens: 1 }; } };
  const prepared = await prepareOptionalParentCase(summaries, store, data); store.close();
  const metadata = { ...prepared.metrics, continuation: prepared.continuation }; write(resolve(run, "optional-parent-preparation.json"), metadata);
  return { root, run, sourceRun, data, args, backend, metadata };
}

test("comparison requires complete optional preparation and reconstructs without provider calls", async () => {
  const fixture = await setup();
  expect(() => requireCompleteOptionalPreparation(fixture.metadata, fixture.data)).not.toThrow();
  expect(() => requireCompleteOptionalPreparation({ ...fixture.metadata, originalCount: 2 }, fixture.data)).toThrow("OPTIONAL_PREPARATION_NOT_COMPLETE");
  expect(() => requireCompleteOptionalPreparation({ ...fixture.metadata, continuation: { ...fixture.metadata.continuation, status: "halted" } }, fixture.data)).toThrow("OPTIONAL_PREPARATION_NOT_COMPLETE");
  const restored = await reconstructOptionalPreparation(fixture.run, fixture.data);
  expect(restored.prepared.sources).toHaveLength(4); restored.store.close(); expect(fixture.backend.calls).toBe(322);
});

test("partial source pages retain exact delivered coverage without exposing undelivered originals to grading", async () => {
  const fixture = await setup();
  await runOptionalComparison(fixture.args("answers"), { backend: fixture.backend, onProgress: quiet });
  const path = resolve(fixture.run, "optional-answers", `optchat-${hash("q-0").slice(0, 16)}.json`), answer = JSON.parse(readFileSync(path, "utf8"));
  expect(answer.private.deliveredEvidence).toEqual([{ sourceId: sourceKey(fullNormalizedSources(fixture.data)[0]!), text: "Orig", complete: false }]);
  expect(answer.public.deliveredGoldSources).toBe(1); expect(answer.public.fullyDeliveredGoldSources).toBe(0);
  const report = await runOptionalComparison(fixture.args("grade"), { backend: fixture.backend, onProgress: quiet });
  expect(report.qualityComparisonAccepted).toBe(true); expect(report.arms.optchat.questions).toBe(2); expect(report.paired.bothCorrect).toBe(2);
  expect(report.lineage.inheritedInitialCalls).toBe(322); expect(report.lineage.cumulativeCalls).toBe(fixture.backend.calls); expect(report.lineage.newCallsSinceCopy + 322).toBe(fixture.backend.calls);
  const optEvidence = fixture.backend.gradedEvidence.at(-2)!;
  expect(JSON.stringify(optEvidence)).toContain("Orig"); expect(JSON.stringify(optEvidence)).not.toContain("UNDELIVERED_ORIGINAL_SENTINEL");
  const publicText = readFileSync(resolve(fixture.run, "public-result-comparison.json"), "utf8");
  for (const marker of ["GOLD_SENTINEL", "RUBRIC_SENTINEL", "NATIVE_SENTINEL", "A natural fixture answer", "What preference"]) expect(publicText).not.toContain(marker);
});

test("held calibration produces null quality scores for all three arms and no fake OptChat zeros", async () => {
  const fixture = await setup(); await runOptionalComparison(fixture.args("answers"), { backend: fixture.backend, onProgress: quiet }); fixture.backend.rejectPositive = true;
  const report = await runOptionalComparison(fixture.args("grade"), { backend: fixture.backend, onProgress: quiet });
  expect(report.qualityComparisonAccepted).toBe(false); expect(report.paired).toBeNull();
  for (const arm of ["optchat", "boros", "recent"]) { expect(report.arms[arm].correct).toBeNull(); expect(report.arms[arm].grounded).toBeNull(); }
  expect(report.arms.optchat.questions).toBe(2);
  expect(() => readdirSync(resolve(fixture.run, "optional-grades"))).toThrow();
});

test("all OptChat answers must precede grading and fatal calls never create cached answer cells", async () => {
  const fixture = await setup();
  await expect(runOptionalComparison(fixture.args("grade"), { backend: fixture.backend, onProgress: quiet })).rejects.toThrow("OPTCHAT_ANSWERS_NOT_COMPLETE");
  fixture.backend.failAt = 323;
  await expect(runOptionalComparison(fixture.args("answers"), { backend: fixture.backend, onProgress: quiet })).rejects.toThrow("RUN_DEADLINE");
  expect(() => readdirSync(resolve(fixture.run, "optional-answers"))).toThrow(); expect(fixture.backend.calls).toBe(322);
});

test("complete exact page receipts replace duplicate partial delivery with one verified original", async () => {
  const fixture = await setup(), restored = await reconstructOptionalPreparation(fixture.run, fixture.data), source = restored.prepared.sources[0]!, id = sourceKey(source);
  let count = 0;
  const answerer: Backend = { async complete() {
    const index = count++;
    if (index < 3) return { message: { role: "assistant", content: "", tool_calls: [{ id: `page-${index}`, type: "function" as const, function: { name: "optchat_source", arguments: JSON.stringify({ id, offset: index < 2 ? 0 : 4, maxBytes: index < 2 ? 4 : 32768 }) } }] }, inputTokens: 1, outputTokens: 1 };
    return { message: { role: "assistant", content: "A fixture answer." }, inputTokens: 1, outputTokens: 1 };
  } };
  try {
    const answer = await answerLongQuestion(answerer, restored.prepared, fixture.data.questions[0]!);
    expect(optionalDeliveredEvidence(answer, restored.prepared)).toEqual([{ sourceId: id, text: source.payload, complete: true }]);
    const forged = structuredClone(answer); const page = forged.private.messages.find(message => message.role === "tool")!;
    const data = JSON.parse(page.content!); data.text = "wrong"; page.content = JSON.stringify(data);
    expect(() => optionalDeliveredEvidence(forged, restored.prepared)).toThrow("SOURCE_PAGE_RECEIPT_MISMATCH");
  } finally { restored.store.close(); }
});

test("local budget failures are immutable failed cells and do not stop the next question", async () => {
  const fixture = await setup();
  const original = fixture.backend.complete.bind(fixture.backend); let first = true;
  fixture.backend.complete = async (...args) => { if (first) { first = false; throw new EvalFailure("ANSWER_CONTEXT_BUDGET"); } return original(...args); };
  await runOptionalComparison(fixture.args("answers"), { backend: fixture.backend, onProgress: quiet });
  const path = resolve(fixture.run, "optional-answers", `optchat-${hash("q-0").slice(0, 16)}.json`), failure = readFileSync(path, "utf8");
  expect(JSON.parse(failure).public.failure).toBe("ANSWER_CONTEXT_BUDGET");
  expect(readdirSync(resolve(fixture.run, "optional-answers"))).toHaveLength(2); expect(fixture.backend.stages).toContain("answer:optchat:q-1");
  const before = fixture.backend.calls; await runOptionalComparison(fixture.args("answers"), { backend: fixture.backend, onProgress: quiet });
  expect(fixture.backend.calls).toBe(before); expect(readFileSync(path, "utf8")).toBe(failure);
});

test("original pages outside submitted requests do not enter delivered evidence", async () => {
  const fixture = await setup(), restored = await reconstructOptionalPreparation(fixture.run, fixture.data);
  try {
    const answer = await answerLongQuestion(fixture.backend, restored.prepared, fixture.data.questions[0]!);
    expect(optionalDeliveredEvidence(answer, restored.prepared)).toHaveLength(1);
    const beforePage = answer.private.messages.slice(0, answer.private.messages.findIndex(message => message.role === "tool"));
    expect(optionalDeliveredEvidence(answer, restored.prepared, beforePage)).toEqual([]);
  } finally { restored.store.close(); }
});

test("copied baseline caches reject swapped questions, swapped arms, and stale request bindings", async () => {
  for (const variant of ["question", "arm", "boros-digest", "recent-input"]) {
    const fixture = await setup(), firstName = `${variant === "recent-input" ? "recent" : "boros"}-${hash("q-0").slice(0, 16)}.json`, firstPath = resolve(fixture.run, "baseline-answers", firstName);
    const candidate = JSON.parse(readFileSync(firstPath, "utf8"));
    if (variant === "question" || variant === "arm") {
      const other = resolve(fixture.run, "baseline-answers", `${variant === "arm" ? "recent" : "boros"}-${hash(variant === "question" ? "q-1" : "q-0").slice(0, 16)}.json`);
      writeFileSync(firstPath, readFileSync(other), { mode: 0o600 });
    } else {
      if (variant === "boros-digest") candidate.public.submittedMessagesHash = hash("wrong request");
      else candidate.private.messages[1].content = "A different question.";
      write(firstPath, candidate);
    }
    await expect(runOptionalComparison(fixture.args("answers"), { backend: fixture.backend, onProgress: quiet })).rejects.toThrow("BASELINE_ANSWER_MISMATCH");
    expect(fixture.backend.calls).toBe(322);
  }
});

test("OptChat caches bind expected question, arm, case, protocol, and answer content", async () => {
  for (const variant of ["question", "arm", "case", "protocol", "content"]) {
    const fixture = await setup(); await runOptionalComparison(fixture.args("answers"), { backend: fixture.backend, onProgress: quiet });
    const first = resolve(fixture.run, "optional-answers", `optchat-${hash("q-0").slice(0, 16)}.json`), answer = JSON.parse(readFileSync(first, "utf8"));
    if (variant === "question") writeFileSync(first, readFileSync(resolve(fixture.run, "optional-answers", `optchat-${hash("q-1").slice(0, 16)}.json`)), { mode: 0o600 });
    else {
      if (variant === "arm") answer.public.arm = "boros";
      if (variant === "case") answer.public.caseHash = hash("different case");
      if (variant === "protocol") answer.public.protocolHash = hash("different protocol");
      if (variant === "content") answer.private.finalText = "A different answer.";
      write(first, answer);
    }
    const before = fixture.backend.calls;
    await expect(runOptionalComparison(fixture.args("answers"), { backend: fixture.backend, onProgress: quiet })).rejects.toThrow("OPTIONAL_ANSWER_MISMATCH");
    expect(fixture.backend.calls).toBe(before);
  }
});

test("submitted search source snippets count as partial evidence while summary hits stay excluded", async () => {
  const data = fixture(); data.messages[0]!.text = "searchsentinel_ " + "α😀 evidence ".repeat(60) + "NEVER_DELIVERED_TAIL";
  const fixtureCase = await setup(data), restored = await reconstructOptionalPreparation(fixtureCase.run, fixtureCase.data); let count = 0;
  const answerer: Backend = { async complete() {
    if (count++ === 0) return { message: { role: "assistant", content: "", tool_calls: [{ id: "search", type: "function" as const, function: { name: "optchat_search", arguments: JSON.stringify({ query: "searchsentinel_", limit: 1 }) } }] }, inputTokens: 1, outputTokens: 1 };
    return { message: { role: "assistant", content: "A fixture answer." }, inputTokens: 1, outputTokens: 1 };
  } };
  try {
    const answer = await answerLongQuestion(answerer, restored.prepared, fixtureCase.data.questions[0]!);
    const pageMessage = answer.private.messages.find(message => message.role === "tool")!, page = JSON.parse(pageMessage.content!);
    page.hits.push({ id: "summary-only", type: "summary", text: "SUMMARY_NOT_ORIGINAL" }); pageMessage.content = JSON.stringify(page);
    const evidence = optionalDeliveredEvidence(answer, restored.prepared);
    expect(evidence).toEqual([{ sourceId: sourceKey(restored.prepared.sources[0]!), text: Array.from(data.messages[0]!.text).slice(0, 200).join(""), complete: false }]);
    expect(JSON.stringify(evidence)).not.toContain("NEVER_DELIVERED_TAIL"); expect(JSON.stringify(evidence)).not.toContain("SUMMARY_NOT_ORIGINAL");
    const beforeResponse = answer.private.messages.slice(0, answer.private.messages.findIndex(message => message.role === "tool"));
    expect(optionalDeliveredEvidence(answer, restored.prepared, beforeResponse)).toEqual([]);
    page.hits[0].text = "A forged snippet."; pageMessage.content = JSON.stringify(page);
    expect(() => optionalDeliveredEvidence(answer, restored.prepared)).toThrow("SOURCE_SEARCH_RECEIPT_MISMATCH");
  } finally { restored.store.close(); }
});

test("zoom delivery counts an exact complete original and excludes summarized leaf text", async () => {
  const data = fixture(); data.messages[0]!.text = "Exact original preference evidence. ".repeat(20).trim();
  const memory = new Store();
  const compactor: Backend = { async complete(messages) {
    const prompt = messages.at(-1)!.content!, decoded = JSON.parse(prompt.split("UNTRUSTED_JSON_DATA:\n").at(-1)!);
    let original: any; try { original = JSON.parse(decoded); } catch {}
    return { message: { role: "assistant", content: original?.kind && typeof original.payload === "string" ? original.payload : "The fixture retains a preference." }, inputTokens: 1, outputTokens: 1 };
  } };
  try {
    const prepared = await prepareOptionalParentCase(compactor, memory, data), source = prepared.sources[0]!, parent = prepared.engine.findNode(sessionTree(source.sessionId, 0), 0, 2)!; let count = 0;
    const answerer: Backend = { async complete() {
      if (count++ === 0) return { message: { role: "assistant", content: "", tool_calls: [{ id: "zoom", type: "function" as const, function: { name: "optchat_zoom", arguments: JSON.stringify({ id: parent.id }) } }] }, inputTokens: 1, outputTokens: 1 };
      return { message: { role: "assistant", content: "A fixture answer." }, inputTokens: 1, outputTokens: 1 };
    } };
    const answer = await answerLongQuestion(answerer, prepared, data.questions[0]!);
    expect(optionalDeliveredEvidence(answer, prepared)).toEqual([{ sourceId: sourceKey(source), text: source.payload, complete: true }]);
  } finally { memory.close(); }
});

test("search delivery counts a short Unicode original as complete", async () => {
  const data = fixture(); data.messages[0]!.text = "unicode_search_ αβ😀 The user prefers jasmine tea.";
  const fixtureCase = await setup(data), restored = await reconstructOptionalPreparation(fixtureCase.run, fixtureCase.data); let count = 0;
  const answerer: Backend = { async complete() {
    if (count++ === 0) return { message: { role: "assistant", content: "", tool_calls: [{ id: "search", type: "function" as const, function: { name: "optchat_search", arguments: JSON.stringify({ query: "unicode_search_", limit: 1 }) } }] }, inputTokens: 1, outputTokens: 1 };
    return { message: { role: "assistant", content: "A fixture answer." }, inputTokens: 1, outputTokens: 1 };
  } };
  try {
    const answer = await answerLongQuestion(answerer, restored.prepared, fixtureCase.data.questions[0]!);
    const source = restored.prepared.sources[0]!;
    expect(Array.from(source.payload).length).toBeLessThanOrEqual(200);
    expect(optionalDeliveredEvidence(answer, restored.prepared)).toEqual([{ sourceId: sourceKey(source), text: source.payload, complete: true }]);
  } finally { restored.store.close(); }
});

test("identical abstentions cannot exchange question-specific OptChat or frozen baseline grades", async () => {
  for (const cohort of ["optchat", "baseline"]) {
    const fixtureCase = await setup(fixture(), "The supplied history does not establish this detail.");
    await runOptionalComparison(fixtureCase.args("answers"), { backend: fixtureCase.backend, onProgress: quiet });
    await runOptionalComparison(fixtureCase.args("grade"), { backend: fixtureCase.backend, onProgress: quiet });
    const name = (id: string) => cohort === "optchat" ? `${hash(id).slice(0, 16)}.json` : `boros-${hash(id).slice(0, 16)}.json`;
    const folder = resolve(fixtureCase.run, cohort === "optchat" ? "optional-grades" : "baseline-grades"), firstPath = resolve(folder, name("q-0")), secondPath = resolve(folder, name("q-1"));
    const first = JSON.parse(readFileSync(firstPath, "utf8")), second = JSON.parse(readFileSync(secondPath, "utf8"));
    expect(first.answerHash).toBe(second.answerHash); expect(first.grade.private.inputHash).not.toBe(second.grade.private.inputHash);
    writeFileSync(firstPath, readFileSync(secondPath), { mode: 0o600 });
    const before = fixtureCase.backend.calls;
    await expect(runOptionalComparison(fixtureCase.args("grade"), { backend: fixtureCase.backend, onProgress: quiet })).rejects.toThrow(cohort === "optchat" ? "OPTIONAL_GRADE_MISMATCH" : "GRADING_INPUT_MISMATCH");
    expect(fixtureCase.backend.calls).toBe(before);
  }
});

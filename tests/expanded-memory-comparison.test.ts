import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Engine, Store, bytes, hash, sourceKey, type Publication } from "../src/index.ts";
import { EvalFailure, type Backend } from "../scripts/local-memory-eval.ts";
import { nativeBorosInput } from "../scripts/compare-long-history.ts";
import { fullNormalizedSources, runBaselineOnly } from "../scripts/beam-baseline-only.ts";
import { prepareOptionalParentCase } from "../scripts/optional-parent-preparation.ts";
import { longCaseHashes, longHistoryProtocol, type NormalizedLongCase } from "../scripts/long-history-eval.ts";
import { answerExpandedQuestion, correctnessInputHash, expandedInitialMessages, expandedMemoryProtocol, reconstructExpandedPreparation, runExpandedComparison, verifyExpandedCalibration } from "../scripts/expanded-memory-comparison.ts";
import { type BorosEnvelope } from "../scripts/boros-context-driver.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const quiet = () => {};
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const fileHash = (path: string) => hash(readFileSync(path, "utf8"));
function fixture(count = 4): NormalizedLongCase {
  return { version: 1, source: { repoRevision: "fixture", scaleLabel: "fixture", conversationId: "fixture", rawChatHash: hash("chat"), rawProbeHash: hash("probe"), license: "fixture" },
    messages: Array.from({ length: count }, (_, seq) => ({ seq, role: seq % 2 ? "assistant" : "user", text: `Original ${seq} establishes a jasmine tea preference. UNDELIVERED_TAIL`, originalId: seq + 1, timeAnchor: null })),
    questions: Array.from({ length: 2 }, (_, index) => ({ id: `q-${index}`, category: "fixture", question: `What preference does fixture ${index} establish?`, referenceAnswer: "GOLD_SENTINEL jasmine tea", rubric: "RUBRIC_SENTINEL", sourceReferences: [1], resolvedMessageSeqs: [0], unresolvedReferences: [] })) };
}
function context(data: NormalizedLongCase, question: NormalizedLongCase["questions"][number]) {
  const input = nativeBorosInput(data, question), event = input.events[0]!, messages = [{ role: "system", content: input.configuration.system }, { role: "user", content: question.question }], body = JSON.stringify({ messages }), selection = JSON.stringify({ citation_labels: [] });
  const envelope: BorosEnvelope = { version: "boros-public-context-v1", corpus_sha256: hash(JSON.stringify(input.events)), cache_reused: true, process_milliseconds: 1,
    attempts: [{ arm: "ordinary_send", preparation_completed: true, runner_started: false, semantic_index_received: false, messages, sources: [{ event_id: event.id, project_id: event.project_id, conversation_key: event.conversation_key, role: event.role, kind: "historical", offset: 0, bytes: bytes(event.text), source_bytes: bytes(event.text), source_sha256: hash(event.text), excerpt_sha256: hash(event.text), text: event.text }], prompt_tokens: 30, request_body_base64: Buffer.from(body).toString("base64"), selection_receipt_base64: Buffer.from(selection).toString("base64"), body_sha256: hash(body), selection_sha256: hash(selection), selection_receipt: JSON.parse(selection), context_audit: {} }] };
  return { input, envelope };
}
function model(data: NormalizedLongCase) {
  return { calls: 318, startedAt: Date.now(), metrics: [] as { stage: string; latencyMs: number; inputTokens: number | null; outputTokens: number | null; success: boolean }[], stages: [] as string[], failAt: 0, sourceRead: false, answerText: "A natural fixture answer.", gradeInputs: [] as any[],
    async complete(messages: Parameters<Backend["complete"]>[0], _tools: unknown[], stage: string) {
      if (this.calls + 1 === this.failAt) throw new EvalFailure("RUN_DEADLINE");
      this.calls++; this.stages.push(stage); this.metrics.push({ stage, latencyMs: 1, inputTokens: 100, outputTokens: 3, success: true });
      if (stage.startsWith("grade:")) { const input = JSON.parse(messages[1]!.content!); this.gradeInputs.push(input); return { message: { role: "assistant", content: JSON.stringify({ correct: !input.candidate.includes("BEAM_FALSE_"), grounded: input.deliveredEvidence === undefined ? null : true, confidence: "high" }) }, inputTokens: 100, outputTokens: 3 }; }
      for (const marker of ["GOLD_SENTINEL", "RUBRIC_SENTINEL", "NATIVE_SENTINEL"]) expect(JSON.stringify(messages)).not.toContain(marker);
      if (stage === "answer:optchat:q-0" && !this.sourceRead) { this.sourceRead = true; return { message: { role: "assistant", content: "", tool_calls: [{ id: "read", type: "function" as const, function: { name: "optchat_source", arguments: JSON.stringify({ id: sourceKey(fullNormalizedSources(data)[0]!), offset: 0, maxBytes: 4 }) } }] }, inputTokens: 100, outputTokens: 3 }; }
      return { message: { role: "assistant", content: this.answerText }, inputTokens: 100, outputTokens: 3 };
    } };
}
async function setup(data = fixture()) {
  const root = mkdtempSync(resolve(tmpdir(), "expanded-fixture-")); directories.push(root);
  const run = resolve(root, "run"), sourceRun = resolve(root, "source"), casePath = resolve(root, "case.json"), supplement = resolve(root, "supplement.json"), caseText = JSON.stringify(data);
  writeFileSync(casePath, caseText, { mode: 0o600 }); write(supplement, { sourceProbeSHA256: data.source.rawProbeHash, normalizedCaseSHA256: hash(caseText), questionCount: data.questions.length, questions: Object.fromEntries(data.questions.map(question => [question.id, { answer: question.referenceAnswer, rubric: question.rubric, privateNote: "NATIVE_SENTINEL" }])) });
  for (const question of data.questions) { const path = resolve(run, "boros-contexts", hash(question.id).slice(0, 16)); mkdirSync(path, { recursive: true, mode: 0o700 }); write(resolve(path, "accepted.json"), context(data, question)); }
  const args = (mode: string) => ["--case", casePath, "--run", run, "--supplement", supplement, "--mode", mode], backend = model(data);
  await runBaselineOnly(args("answers"), { backend, onProgress: quiet }); await runBaselineOnly(args("grade"), { backend, onProgress: quiet });
  mkdirSync(sourceRun, { mode: 0o700 }); write(resolve(sourceRun, "backend-state.json"), { calls: backend.calls, startedAt: backend.startedAt }); copyFileSync(resolve(sourceRun, "backend-state.json"), resolve(run, "backend-state.json"));
  const store = new Store(resolve(sourceRun, "memory.sqlite"));
  const summaries: Backend = { async complete() { return { message: { role: "assistant", content: "The synthetic fixture retains a preference." }, inputTokens: 1, outputTokens: 1 }; } };
  await prepareOptionalParentCase(summaries, store, data); store.close(); copyFileSync(resolve(sourceRun, "memory.sqlite"), resolve(run, "memory.sqlite"));
  const inheritedCalls = backend.calls, effectiveDeadlineMs = Date.now() + 120 * 60000;
  write(resolve(run, "expanded-memory-copy.json"), { sourceRunDirectory: sourceRun, sourceDatabaseHash: new Bun.CryptoHasher("sha256").update(readFileSync(resolve(sourceRun, "memory.sqlite"))).digest("hex"), sourceBackendStateHash: fileHash(resolve(sourceRun, "backend-state.json")), inheritedCalls, originalStartedAt: backend.startedAt, effectiveDeadlineMs, maxCalls: 6000, createdAt: Date.now() });
  const options = { backend, onProgress: quiet, tokenizerIdentity: { model: "synthetic-fixture", templateHash: hash("synthetic-template"), validationHash: hash("synthetic-validation") }, countRequestTokens: async () => 100 };
  return { root, run, sourceRun, data, backend, args, options, inheritedCalls, effectiveDeadlineMs };
}

test("complete graph reconstruction runs no worker and rejects incomplete originals or pending dependencies", async () => {
  const fixtureCase = await setup(), store = new Store(resolve(fixtureCase.run, "memory.sqlite"));
  try {
    const jobsBefore = JSON.stringify(store.db.query("SELECT * FROM jobs ORDER BY id").all()), restored = reconstructExpandedPreparation(store, fixtureCase.data);
    expect(restored.audit.originalCount).toBe(4); expect(restored.audit.publications).toBe(2); expect(restored.audit.compactionCalls).toBe(0); expect(JSON.stringify(store.db.query("SELECT * FROM jobs ORDER BY id").all())).toBe(jobsBefore);
    store.db.query("UPDATE jobs SET status='pending' WHERE id=(SELECT id FROM jobs LIMIT 1)").run();
    expect(() => reconstructExpandedPreparation(store, fixtureCase.data)).toThrow("EXPANDED_GRAPH_NOT_COMPLETE");
  } finally { store.close(); }
});

test("expanded initial view over 32KB uses actual token admission and retains optional parent failures", async () => {
  const data = fixture(96); for (const message of data.messages) message.text = `Original ${message.seq}. ` + "synthetic evidence ".repeat(80);
  const store = new Store(), hashes = longCaseHashes(data), sessionId = `archive-${hashes.caseHash.slice(0, 16)}`, scope = `scope-${hashes.caseHash.slice(0, 16)}`;
  const engine = new Engine(store, { async summarize() { return { text: "SYNTHETIC_SUMMARY_ONLY ".repeat(33), model: "synthetic", promptVersion: "synthetic", fallback: false }; } }, { high: 65536, low: 49152, summaryAcceptBytes: 1024 });
  store.set("longEvaluation", "identity", { ...hashes, source: data.source, protocol: longHistoryProtocol }); engine.register(sessionId, scope, "beam-public-evaluation");
  try {
    for (let start = 0; start < data.messages.length; start += 2) { const turnId = `turn-${String(start / 2).padStart(6, "0")}`; engine.admit(sessionId, turnId); for (const source of fullNormalizedSources(data).slice(start, start + 2)) { const { seq: _seq, payloadHash: _hash, ...input } = source; engine.append(input); } engine.finish(sessionId, turnId, "completed", "2026-10-12T00:00:00Z"); await engine.drain(); }
    store.db.query("DELETE FROM nodes WHERE json_extract(tree,'$[0]')='shared' AND count>1").run();
    store.db.query("DELETE FROM jobs WHERE json_extract(input,'$.type')='parent' AND json_extract(json_extract(input,'$.tree'),'$[0]')='shared' AND json_extract(input,'$.count')>2").run();
    store.db.query("UPDATE jobs SET status='failed',error='MemoryError: SUMMARY_SIZE: fixture' WHERE json_extract(input,'$.type')='parent' AND json_extract(json_extract(input,'$.tree'),'$[0]')='shared' AND json_extract(input,'$.count')=2").run();
    const restored = reconstructExpandedPreparation(store, data); expect(restored.audit.projectionBytes).toBeGreaterThan(32768); expect(restored.audit.optionalFailures).toBe(24);
    const failureHash = restored.audit.retainedFailureHash, initial = expandedInitialMessages(restored.prepared, data.questions[0]!); expect(bytes(initial.memory)).toBeGreaterThan(32768);
    let counted = 0, called = 0; const response: Backend = { async complete(messages) { called++; expect(messages).toEqual(initial.messages); return { message: { role: "assistant", content: "Synthetic answer." }, inputTokens: 10000, outputTokens: 3 }; } };
    const answer = await answerExpandedQuestion(response, restored.prepared, data.questions[0]!, { countRequestTokens: async (messages, tools, output) => { counted++; expect(messages).toEqual(initial.messages); expect(tools).toHaveLength(3); expect(output).toBe(2048); await Promise.resolve(); return 10000; } });
    expect(answer.public.failure).toBeNull(); expect(called).toBe(1); expect(counted).toBe(1); expect(answer.private.requestReceipts[0]!.inputTokens).toBe(10000); expect(reconstructExpandedPreparation(store, data).audit.retainedFailureHash).toBe(failureHash);
    const rejected = await answerExpandedQuestion(response, restored.prepared, data.questions[0]!, { countRequestTokens: async () => 29697 }); expect(rejected.public.failure).toBe("ANSWER_CONTEXT_BUDGET"); expect(called).toBe(1);
    expect(JSON.stringify(initial.messages)).not.toContain("GOLD_SENTINEL"); expect(JSON.stringify(initial.messages)).not.toContain(data.messages[0]!.text);
  } finally { store.close(); }
});

test("all answers precede new blind correctness-only grades and reused baselines remain immutable", async () => {
  const fixtureCase = await setup(), before = Object.fromEntries(readdirSync(resolve(fixtureCase.run, "baseline-answers")).map(name => [name, fileHash(resolve(fixtureCase.run, "baseline-answers", name))]));
  await expect(runExpandedComparison(fixtureCase.args("grade"), fixtureCase.options)).rejects.toThrow("EXPANDED_ANSWERS_NOT_COMPLETE");
  const answerReport = await runExpandedComparison(fixtureCase.args("answers"), fixtureCase.options); expect(answerReport.answerCells).toBe(6);
  const privateAnswer = JSON.parse(readFileSync(resolve(fixtureCase.run, "expanded-answers", `optchat-${hash("q-0").slice(0, 16)}.json`), "utf8"));
  expect(privateAnswer.public.deliveredGoldSources).toBe(1); expect(privateAnswer.public.fullyDeliveredGoldSources).toBe(0); expect(privateAnswer.private.deliveredEvidence[0].text).toBe("Orig");
  const priorGradeCalls = fixtureCase.backend.gradeInputs.length, result = await runExpandedComparison(fixtureCase.args("grade"), fixtureCase.options);
  expect(fixtureCase.backend.gradeInputs.length - priorGradeCalls).toBe(6); for (const input of fixtureCase.backend.gradeInputs.slice(priorGradeCalls)) { expect(input.deliveredEvidence).toBeUndefined(); expect(JSON.stringify(input)).not.toContain('"arm"'); expect(input.nativeAuthorReference.privateNote).toBe("NATIVE_SENTINEL"); }
  expect(result.qualityComparisonAccepted).toBe(true); expect(result.paired.bothCorrect).toBe(2); for (const arm of ["optchat", "boros", "recent"]) { expect(result.arms[arm].correct).toBe(2); expect(result.arms[arm].grounded).toBeNull(); }
  expect(result.lineage.inheritedInitialCalls).toBe(fixtureCase.inheritedCalls); expect(result.lineage.cumulativeCalls - result.lineage.newCallsSinceCopy).toBe(fixtureCase.inheritedCalls); expect(result.resources.deadlineAt).toBe(fixtureCase.effectiveDeadlineMs);
  expect(Object.fromEntries(readdirSync(resolve(fixtureCase.run, "baseline-answers")).map(name => [name, fileHash(resolve(fixtureCase.run, "baseline-answers", name))]))).toEqual(before);
  const text = readFileSync(resolve(fixtureCase.run, "public-result-expanded-comparison.json"), "utf8"); for (const marker of ["GOLD_SENTINEL", "RUBRIC_SENTINEL", "NATIVE_SENTINEL", "A natural fixture answer", "What preference", "UNDELIVERED_TAIL"]) expect(text).not.toContain(marker);
  const callCount = fixtureCase.backend.calls; await runExpandedComparison(fixtureCase.args("grade"), fixtureCase.options); expect(fixtureCase.backend.calls).toBe(callCount);
});

test("actual token counter controls tool page size and incomplete delivered pages stay partial", async () => {
  const fixtureCase = await setup(), store = new Store(resolve(fixtureCase.run, "memory.sqlite"));
  try {
    const { prepared } = reconstructExpandedPreparation(store, fixtureCase.data), original = prepared.sources[0]!, id = sourceKey(original); let generated = 0; const sizes: number[] = [];
    const backend: Backend = { async complete() { if (!generated++) return { message: { role: "assistant", content: "", tool_calls: [{ id: "read", type: "function", function: { name: "optchat_source", arguments: JSON.stringify({ id, maxBytes: 32768 }) } }] }, inputTokens: 1000, outputTokens: 1 }; return { message: { role: "assistant", content: "Synthetic partial answer." }, inputTokens: 1000, outputTokens: 1 }; } };
    const answer = await answerExpandedQuestion(backend, prepared, fixtureCase.data.questions[0]!, { countRequestTokens: async messages => { const page = messages.at(-1); if (page?.role === "tool") { const parsed = JSON.parse(page.content!); if (typeof parsed.text === "string") { sizes.push(bytes(parsed.text)); return bytes(parsed.text) > 8 ? 29600 : 1000; } } return 1000; } });
    expect(sizes.some(size => size > 8)).toBe(true); expect(answer.public.failure).toBeNull(); expect(answer.private.deliveredEvidence).toHaveLength(1); expect(bytes(answer.private.deliveredEvidence[0]!.text)).toBeLessThanOrEqual(8); expect(answer.private.deliveredEvidence[0]!.complete).toBe(false);
  } finally { store.close(); }
});

test("fixed amendment resumes without deadline extension and rejects tokenizer or graph identity drift", async () => {
  const fixtureCase = await setup(); await runExpandedComparison(fixtureCase.args("audit"), fixtureCase.options);
  const freezePath = resolve(fixtureCase.run, "expanded-comparison-freeze.json"), prior = fileHash(freezePath); await runExpandedComparison(fixtureCase.args("audit"), fixtureCase.options); expect(fileHash(freezePath)).toBe(prior);
  await expect(runExpandedComparison(fixtureCase.args("audit"), { ...fixtureCase.options, tokenizerIdentity: { altered: true } })).rejects.toThrow("EXPANDED_FREEZE_MISMATCH");
  const store = new Store(resolve(fixtureCase.run, "memory.sqlite")); try { const node = store.db.query("SELECT id,value FROM nodes LIMIT 1").get() as { id: string; value: string }; const value = JSON.parse(node.value); value.text += " Changed."; store.db.query("UPDATE nodes SET value=? WHERE id=?").run(JSON.stringify(value), node.id); } finally { store.close(); }
  await expect(runExpandedComparison(fixtureCase.args("audit"), fixtureCase.options)).rejects.toThrow("EXPANDED_FREEZE_MISMATCH");
});

test("global budget failures do not cache answers and local failures continue to the next question", async () => {
  const fixtureCase = await setup(); fixtureCase.backend.failAt = fixtureCase.backend.calls + 1;
  await expect(runExpandedComparison(fixtureCase.args("answers"), fixtureCase.options)).rejects.toThrow("RUN_DEADLINE"); expect(existsSync(resolve(fixtureCase.run, "expanded-answers"))).toBe(false);
  fixtureCase.backend.failAt = 0; const original = fixtureCase.backend.complete.bind(fixtureCase.backend); let first = true;
  fixtureCase.backend.complete = async (...args) => { if (first) { first = false; throw new EvalFailure("ANSWER_CONTEXT_BUDGET"); } return original(...args); };
  await runExpandedComparison(fixtureCase.args("answers"), fixtureCase.options); const name = `optchat-${hash("q-0").slice(0, 16)}.json`, path = resolve(fixtureCase.run, "expanded-answers", name), content = readFileSync(path, "utf8");
  expect(JSON.parse(content).public.failure).toBe("ANSWER_CONTEXT_BUDGET"); expect(fixtureCase.backend.stages).toContain("answer:optchat:q-1"); const calls = fixtureCase.backend.calls; await runExpandedComparison(fixtureCase.args("answers"), fixtureCase.options); expect(fixtureCase.backend.calls).toBe(calls); expect(readFileSync(path, "utf8")).toBe(content);
});

test("baseline reuse rejects swapped questions or arms and changed submitted request digests", async () => {
  for (const variant of ["question", "arm", "boros-digest", "recent-input"]) {
    const fixtureCase = await setup(), arm = variant === "recent-input" ? "recent" : "boros", path = resolve(fixtureCase.run, "baseline-answers", `${arm}-${hash("q-0").slice(0, 16)}.json`), answer = JSON.parse(readFileSync(path, "utf8"));
    if (variant === "question" || variant === "arm") copyFileSync(resolve(fixtureCase.run, "baseline-answers", `${variant === "arm" ? "recent" : arm}-${hash(variant === "question" ? "q-1" : "q-0").slice(0, 16)}.json`), path);
    else { if (variant === "boros-digest") answer.public.submittedMessagesHash = hash("wrong"); else answer.private.messages[1].content = "A different question."; write(path, answer); }
    const before = fixtureCase.backend.calls; await expect(runExpandedComparison(fixtureCase.args("answers"), fixtureCase.options)).rejects.toThrow("BASELINE_ANSWER_MISMATCH"); expect(fixtureCase.backend.calls).toBe(before);
  }
});

test("calibration verification binds native author and candidate input and rejects held controls", async () => {
  const fixtureCase = await setup(), freeze = JSON.parse(readFileSync(resolve(fixtureCase.run, "baseline-freeze.json"), "utf8")), supplement = JSON.parse(readFileSync(resolve(fixtureCase.root, "supplement.json"), "utf8")), questions = fixtureCase.data.questions.map(question => ({ ...question, nativeAuthorReference: supplement.questions[question.id] }));
  expect(verifyExpandedCalibration(fixtureCase.run, questions, hash(JSON.stringify(freeze))).public.accepted).toBe(1);
  const altered = structuredClone(questions); (altered[0]!.nativeAuthorReference as any).privateNote = "Changed native oracle.";
  expect(() => verifyExpandedCalibration(fixtureCase.run, altered, hash(JSON.stringify(freeze)))).toThrow("EXPANDED_GRADING_INPUT_MISMATCH");
  const path = resolve(fixtureCase.run, "baseline-calibration.json"), calibration = JSON.parse(readFileSync(path, "utf8")); calibration.public.accepted = 0; write(path, calibration);
  await expect(runExpandedComparison(fixtureCase.args("answers"), fixtureCase.options)).rejects.toThrow("EXPANDED_CALIBRATION_MISMATCH");
});

test("identical answer grades reject swapped questions and grades omit delivered evidence", async () => {
  const fixtureCase = await setup(); await runExpandedComparison(fixtureCase.args("answers"), fixtureCase.options); await runExpandedComparison(fixtureCase.args("grade"), fixtureCase.options);
  const first = resolve(fixtureCase.run, "expanded-grades", `optchat-${hash("q-0").slice(0, 16)}.json`), other = resolve(fixtureCase.run, "expanded-grades", `optchat-${hash("q-1").slice(0, 16)}.json`), copied = JSON.parse(readFileSync(other, "utf8"));
  expect(JSON.parse(copied.grade.private.messages[1].content).deliveredEvidence).toBeUndefined(); expect(copied.grade.private.inputHash).toBe(correctnessInputHash({ ...fixtureCase.data.questions[1]!, nativeAuthorReference: JSON.parse(readFileSync(resolve(fixtureCase.root, "supplement.json"), "utf8")).questions["q-1"] }, copied.grade.private.messages[1].content ? JSON.parse(copied.grade.private.messages[1].content).candidate : ""));
  copyFileSync(other, first); const before = fixtureCase.backend.calls; await expect(runExpandedComparison(fixtureCase.args("grade"), fixtureCase.options)).rejects.toThrow("EXPANDED_GRADE_MISMATCH"); expect(fixtureCase.backend.calls).toBe(before);
});

test("reported prompt tokens must match predictions for answers and grades", async () => {
  const fixtureCase = await setup(), original = fixtureCase.backend.complete.bind(fixtureCase.backend);
  fixtureCase.backend.complete = async (...args) => { const response = await original(...args); return { ...response, inputTokens: 101 }; };
  await runExpandedComparison(fixtureCase.args("answers"), fixtureCase.options);
  const answer = JSON.parse(readFileSync(resolve(fixtureCase.run, "expanded-answers", `optchat-${hash("q-0").slice(0, 16)}.json`), "utf8"));
  expect(answer.public.failure).toBe("TOKENIZER_COUNT_MISMATCH"); expect(answer.private.finalText).toBe(""); expect(answer.private.requestReceipts[0].inputTokens).toBe(100); expect(answer.private.requestReceipts[0].providerInputTokens).toBe(101);
  const report = await runExpandedComparison(fixtureCase.args("grade"), fixtureCase.options);
  expect(report.arms.optchat.failures).toBe(2); for (const arm of ["optchat", "boros", "recent"]) expect(report.arms[arm].invalidGrades).toBe(2);
  expect(report.qualityComparisonAccepted).toBe(false); expect(report.paired).toBeNull();
  for (const arm of ["optchat", "boros", "recent"]) { expect(report.arms[arm].correct).toBeNull(); expect(report.categories.fixture[arm].correct).toBeNull(); }
  expect(report.rows.every((row: any) => row.correct === null && row.acceptedScore === 0)).toBe(true); expect(report.individualGradeDiagnostics).toHaveLength(6);
  const grade = JSON.parse(readFileSync(resolve(fixtureCase.run, "expanded-grades", `boros-${hash("q-0").slice(0, 16)}.json`), "utf8"));
  expect(grade.grade.public.valid).toBe(0); expect(grade.grade.private.failure).toBe("TOKENIZER_COUNT_MISMATCH"); expect(grade.tokenReceipt.providerInputTokens).toBe(101);
});

test("all12 navigation rounds precede a single forced final answer-only request", async () => {
  const fixtureCase = await setup(), store = new Store(resolve(fixtureCase.run, "memory.sqlite"));
  try {
    const { prepared } = reconstructExpandedPreparation(store, fixtureCase.data), toolsSeen: number[] = []; let calls = 0;
    const backend: Backend = { async complete(_messages, tools) { toolsSeen.push(tools.length); const index = calls++; return { message: index < 12 ? { role: "assistant", content: "", tool_calls: [{ id: `lookup-${index}`, type: "function", function: { name: "optchat_search", arguments: JSON.stringify({ query: "jasmine", limit: 1 }) } }] } : { role: "assistant", content: "Final synthetic answer." }, inputTokens: 100, outputTokens: 1 }; } };
    const answer = await answerExpandedQuestion(backend, prepared, fixtureCase.data.questions[0]!, { countRequestTokens: async () => 100 });
    expect(answer.public.failure).toBeNull(); expect(answer.public.steps).toBe(13); expect(answer.public.finalizationCalls).toBe(1); expect(toolsSeen.slice(0, 12)).toEqual(Array(12).fill(3)); expect(toolsSeen.at(-1)).toBe(0); expect(answer.private.requestReceipts).toHaveLength(13);
  } finally { store.close(); }
});

test("a global grade budget stop propagates without caching an invalid uncalled cell", async () => {
  const fixtureCase = await setup(); await runExpandedComparison(fixtureCase.args("answers"), fixtureCase.options); fixtureCase.backend.failAt = fixtureCase.backend.calls + 1;
  await expect(runExpandedComparison(fixtureCase.args("grade"), fixtureCase.options)).rejects.toThrow("RUN_DEADLINE"); expect(existsSync(resolve(fixtureCase.run, "expanded-grades"))).toBe(false);
});

test("OptChat cache binding rejects swapped identities and altered immutable answer content", async () => {
  for (const variant of ["question", "arm", "case", "protocol", "content"]) {
    const fixtureCase = await setup(); await runExpandedComparison(fixtureCase.args("answers"), fixtureCase.options);
    const path = resolve(fixtureCase.run, "expanded-answers", `optchat-${hash("q-0").slice(0, 16)}.json`), answer = JSON.parse(readFileSync(path, "utf8"));
    if (variant === "question") copyFileSync(resolve(fixtureCase.run, "expanded-answers", `optchat-${hash("q-1").slice(0, 16)}.json`), path);
    else { if (variant === "arm") answer.public.arm = "boros"; if (variant === "case") answer.public.caseHash = hash("wrong case"); if (variant === "protocol") answer.public.protocolHash = hash("wrong protocol"); if (variant === "content") answer.private.finalText = "Changed candidate."; write(path, answer); }
    const before = fixtureCase.backend.calls; await expect(runExpandedComparison(fixtureCase.args("answers"), fixtureCase.options)).rejects.toThrow("EXPANDED_ANSWER_MISMATCH"); expect(fixtureCase.backend.calls).toBe(before);
  }
});

test("grading uses the actual32K limit and any invalid grade holds all aggregate quality scores", async () => {
  const fixtureCase = await setup(); await runExpandedComparison(fixtureCase.args("answers"), fixtureCase.options); const before = fixtureCase.backend.calls;
  const result = await runExpandedComparison(fixtureCase.args("grade"), { ...fixtureCase.options, countRequestTokens: async () => 31361 });
  expect(fixtureCase.backend.calls).toBe(before); expect(result.qualityComparisonAccepted).toBe(false); expect(result.paired).toBeNull(); for (const arm of ["optchat", "boros", "recent"]) { expect(result.arms[arm].correct).toBeNull(); expect(result.arms[arm].invalidGrades).toBe(2); }
  const saved = JSON.parse(readFileSync(resolve(fixtureCase.run, "expanded-grades", `optchat-${hash("q-0").slice(0, 16)}.json`), "utf8")); expect(saved.grade.private.failure).toBe("GRADER_CONTEXT_BUDGET"); expect(saved.tokenReceipt.inputTokens).toBe(31361); expect(saved.tokenReceipt.providerInputTokens).toBeUndefined();
  const another = await setup(); await runExpandedComparison(another.args("answers"), another.options); const original = another.backend.complete.bind(another.backend); let first = true;
  another.backend.complete = async (...args) => { const response = await original(...args); if (first) { first = false; return { ...response, message: { role: "assistant", content: "Malformed verdict." } }; } return response; };
  const oneInvalid = await runExpandedComparison(another.args("grade"), another.options); expect(oneInvalid.qualityComparisonAccepted).toBe(false); expect(oneInvalid.individualGradeDiagnostics.filter((row: any) => row.valid === 0)).toHaveLength(1); for (const arm of ["optchat", "boros", "recent"]) expect(oneInvalid.arms[arm].correct).toBeNull();
});

test("cached valid grades require safe nonnegative numeric prompt token receipts", async () => {
  for (const variant of ["missing", "null", "negative"]) {
    const fixtureCase = await setup(); await runExpandedComparison(fixtureCase.args("answers"), fixtureCase.options); await runExpandedComparison(fixtureCase.args("grade"), fixtureCase.options);
    const path = resolve(fixtureCase.run, "expanded-grades", `optchat-${hash("q-0").slice(0, 16)}.json`), saved = JSON.parse(readFileSync(path, "utf8"));
    if (variant === "missing") { delete saved.tokenReceipt.inputTokens; delete saved.tokenReceipt.providerInputTokens; }
    else { saved.tokenReceipt.inputTokens = variant === "null" ? null : -1; saved.tokenReceipt.providerInputTokens = saved.tokenReceipt.inputTokens; }
    write(path, saved); const before = fixtureCase.backend.calls;
    await expect(runExpandedComparison(fixtureCase.args("grade"), fixtureCase.options)).rejects.toThrow("EXPANDED_GRADE_TOKEN_MISMATCH"); expect(fixtureCase.backend.calls).toBe(before);
  }
});

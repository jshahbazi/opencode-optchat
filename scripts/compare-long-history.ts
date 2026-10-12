import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store, bytes, hash, sourceKey } from "../src/index.ts";
import { EvalFailure, type Backend } from "./local-memory-eval.ts";
import { answerLongQuestion, longAnswerInstruction, longCaseHashes, longHistoryProtocol, prepareLongCase, ResumableLocalBackend, type NormalizedLongCase, type PreparedLongCase } from "./long-history-eval.ts";
import { BOROS_REVISION, QWEN_MODEL, createBorosTokenizerFixture, ensureBorosDriver, localBorosTokenizer, runBorosContext, verifyBorosEnvelope, type BorosInput, type BorosEnvelope } from "./boros-context-driver.ts";
import { beamGradingProtocol, gradeBeamCandidate, runBeamCalibration, requireBeamCalibration, type BeamCalibrationPublic, type BeamGradeResult } from "./beam-grader.ts";

export const comparisonProtocol = {
  ...longHistoryProtocol,
  version: "beam-paired-1", questionOrder: "native", armOrder: "rotate-per-question",
  arms: ["optchat", "boros", "recent"], originalIds: "optchat-source-key",
  borosRevision: BOROS_REVISION, borosContext: 32768, borosSafety: 1024,
  borosRecentTokens: 8000, borosEvidenceTokens: 12000, borosEvidenceSpans: 16,
  grader: "blinded-native-author-reference", gradingAfterAllAnswers: true,
  calibration: "all-available-author-positive-and-one-fabricated-negative-per-question",
  gradingProtocol: beamGradingProtocol,
  fullHistoryControl: "omitted-when-history-exceeds-server-context",
};
export type Arm = "optchat" | "boros" | "recent";
export type DeliveredEvidence = { sourceId: string; text: string; complete: boolean };
export type ComparisonAnswer = { public: Record<string, any>; private: { finalText: string; deliveredEvidence: DeliveredEvidence[]; [field: string]: unknown } };
function directory(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
function save(path: string, value: unknown) { directory(resolve(path, "..")); writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
function load<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")); }
function code(error: unknown) { const value = (error as any)?.code; return typeof value === "string" && /^[A-Z_0-9]+$/.test(value) ? value : "COMPARISON_FAILURE"; }
export function nativeBorosInput(data: NormalizedLongCase, question: { question: string }, arms: BorosInput["arms"] = ["ordinary_send"]): BorosInput {
  const hashes = longCaseHashes(data), sessionId = `archive-${hashes.caseHash.slice(0, 16)}`, project = "beam-public-evaluation";
  return { version: 1, events: data.messages.map(message => ({ id: sourceKey({ sessionId, generation: 0, seq: message.seq }), project_id: project,
    conversation_key: sessionId, role: message.role, status: "complete", text: message.text })),
    question: { project_id: project, conversation_key: sessionId, prompt: question.question }, arms,
    configuration: { model: QWEN_MODEL, system: longAnswerInstruction, temperature: 0, seed: 0, thinking: false,
      maximum_output: longHistoryProtocol.answerTokens, context_limit: 32768, safety_tokens: 1024 } };
}
export function assertNativeParity(envelope: BorosEnvelope) {
  const a = envelope.attempts.find(item => item.arm === "ordinary_send"), b = envelope.attempts.find(item => item.arm === "lexical");
  if (!a?.preparation_completed || !b?.preparation_completed || JSON.stringify(a.messages) !== JSON.stringify(b.messages) || JSON.stringify(a.sources) !== JSON.stringify(b.sources) || a.semantic_index_received !== false) throw new EvalFailure("BOROS_NATIVE_PARITY");
}
export function evidenceFromOptChat(answer: Awaited<ReturnType<typeof answerLongQuestion>>, prepared: PreparedLongCase): DeliveredEvidence[] {
  if (answer.public.arm === "recent") return answer.private.receipts.map(receipt => ({ sourceId: receipt.sourceId, text: prepared.engine.source(receipt.sourceId).payload, complete: true }));
  const evidence: DeliveredEvidence[] = [];
  for (const message of answer.private.messages) {
    if (message.role !== "tool" || !message.content) continue;
    try {
      const page = JSON.parse(message.content);
      if (typeof page.sourceId === "string" && typeof page.text === "string" && typeof page.offset === "number") {
        const original = prepared.engine.source(page.sourceId);
        evidence.push({ sourceId: page.sourceId, text: page.text, complete: page.offset === 0 && page.next === null && page.text === original.payload });
      }
    } catch { /* Search and zoom results do not count as delivered original pages. */ }
  }
  const complete = new Set(answer.private.exactSources);
  return [...evidence.filter(item => !complete.has(item.sourceId)), ...[...complete].map(sourceId => ({ sourceId, text: prepared.engine.source(sourceId).payload, complete: true }))];
}
export async function answerBoros(backend: Backend, envelope: BorosEnvelope, input: BorosInput, question: { id: string; category: string }): Promise<ComparisonAnswer> {
  verifyBorosEnvelope(envelope, input);
  const attempt = envelope.attempts.find(item => item.arm === "ordinary_send");
  if (!attempt?.preparation_completed || !attempt.messages || !attempt.sources || attempt.semantic_index_received !== false) throw new EvalFailure("BOROS_PREPARATION_REJECTED");
  const started = Date.now();
  let finalText = "", failure: string | null = null;
  try {
    const result = await backend.complete(attempt.messages as Parameters<Backend["complete"]>[0], [], `answer:boros:${question.id}`, longHistoryProtocol.answerTokens);
    finalText = result.message.content ?? "";
    failure = result.message.tool_calls?.length ? "UNEXPECTED_TOOL_CALL" : !finalText.trim() ? "EMPTY_ANSWER" : null;
  } catch (error) { failure = code(error); }
  const completeSourceIds = [...new Set(attempt.sources.filter(source => source.offset === 0 && source.bytes === source.source_bytes).map(source => source.event_id))];
  return { public: { questionId: question.id, category: question.category, arm: "boros", failure, steps: 1, latencyMs: Date.now() - started,
    preparationMs: attempt.preparation_milliseconds, contextBytes: bytes(JSON.stringify(attempt.messages)), promptTokens: attempt.prompt_tokens,
    exactSourceReceipts: completeSourceIds.length, verifiedOriginalExcerpts: attempt.sources.length,
    nativePreparedBodyHash: attempt.body_sha256, submittedMessagesHash: hash(JSON.stringify(attempt.messages)), selectionHash: attempt.selection_sha256,
    requestProfile: "native-messages-with-common-evaluation-generation-settings" },
    private: { finalText, messages: attempt.messages, selectionReceipt: attempt.selection_receipt,
      deliveredEvidence: attempt.sources.map(source => ({ sourceId: source.event_id, text: source.text, complete: source.offset === 0 && source.bytes === source.source_bytes })) } };
}
export function sourceCoverage(question: NormalizedLongCase["questions"][number], answer: ComparisonAnswer, data: NormalizedLongCase) {
  const sessionId = `archive-${longCaseHashes(data).caseHash.slice(0, 16)}`, expected = [...new Set(question.resolvedMessageSeqs)].map(seq => sourceKey({ sessionId, generation: 0, seq }));
  const received = new Set(answer.private.deliveredEvidence.map(item => item.sourceId));
  const complete = new Set(answer.private.deliveredEvidence.filter(item => item.complete).map(item => item.sourceId));
  return { resolvableGoldSources: expected.length, deliveredGoldSources: expected.filter(id => received.has(id)).length, fullyDeliveredGoldSources: expected.filter(id => complete.has(id)).length };
}
export async function runComparison(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--case", "--run", "--mode", "--supplement"].includes(args[i]!) || !args[i + 1]) throw new EvalFailure("INVALID_CLI");
    values.set(args[i]!, args[i + 1]!);
  }
  const casePath = values.get("--case"), run = values.get("--run"), mode = values.get("--mode");
  if (!casePath || !run || !["contexts", "answers", "grade"].includes(mode ?? "")) throw new EvalFailure("EXPLICIT_COMPARISON_REQUIRED");
  const data = load<NormalizedLongCase>(resolve(casePath)), root = resolve(run), hashes = longCaseHashes(data);
  directory(root);
  const dependencyHashes = Object.fromEntries(["scripts/long-history-eval.ts", "scripts/local-memory-eval.ts", "scripts/boros-context-driver.ts", "scripts/boros-context-driver.swift",
    "src/core/engine.ts", "src/core/retrieval.ts", "src/core/context.ts", "src/storage/store.ts", "src/compactor/summarizer.ts"].map(path => [path, hash(readFileSync(resolve(path), "utf8"))]));
  const freeze = { protocol: comparisonProtocol, protocolHash: hash(JSON.stringify(comparisonProtocol)), hashes, dependencyHashes,
    sourceHash: hash(readFileSync(import.meta.path, "utf8")), graderSourceHash: hash(readFileSync(new URL("./beam-grader.ts", import.meta.url), "utf8")),
    supplementHash: values.has("--supplement") ? hash(readFileSync(resolve(values.get("--supplement")!), "utf8")) : null };
  const freezePath = resolve(root, "comparison-freeze.json");
  if (existsSync(freezePath)) { if (JSON.stringify(load(freezePath)) !== JSON.stringify(freeze)) throw new EvalFailure("COMPARISON_FREEZE_MISMATCH"); }
  else save(freezePath, freeze);
  if (mode === "contexts") {
    const cacheRoot = resolve(".optchat/boros-driver-test-cache"), driver = await ensureBorosDriver({ borosRepository: "/Users/johnshahbazian/development/boros", cacheRoot });
    const fixture = createBorosTokenizerFixture({ template: readFileSync(driver.template, "utf8"), contextLimit: 32768, tokenize: localBorosTokenizer("http://127.0.0.1:11234") });
    try {
      for (let index = 0; index < data.questions.length; index++) {
        const question = data.questions[index]!, output = resolve(root, "boros-contexts", hash(question.id).slice(0, 16));
        if (existsSync(resolve(output, "accepted.json"))) continue;
        const input = nativeBorosInput(data, question, index === 0 ? ["ordinary_send", "lexical"] : ["ordinary_send"]);
        const envelope = await runBorosContext(driver, input, { outputDirectory: resolve(output, `attempt-${crypto.randomUUID()}`), cacheRoot, endpoint: fixture.endpoint });
        if (index === 0) assertNativeParity(envelope);
        if (envelope.attempts.some(item => !item.preparation_completed)) throw new EvalFailure("BOROS_PREPARATION_REJECTED");
        save(resolve(output, "accepted.json"), { input, envelope, closureHash: driver.closureDigest });
        console.log(JSON.stringify({ phase: "boros-context", completed: index + 1, total: data.questions.length, promptTokens: envelope.attempts[0]!.prompt_tokens }));
      }
      const metricPath = resolve(root, "boros-context-metrics.json");
      if (!existsSync(metricPath)) save(metricPath, { closureHash: driver.closureDigest, manifest: driver.manifest, counters: fixture.counters });
    } finally { fixture.stop(); }
    return;
  }
  const backend = new ResumableLocalBackend({ url: "http://127.0.0.1:11234/v1/chat/completions", model: QWEN_MODEL, directory: root });
  const store = new Store(resolve(root, "memory.sqlite"));
  try {
    if (mode === "answers") {
      const checkpoint = store.get<any>("longEvaluation", "checkpoint");
      if (checkpoint?.phase !== "prepared") throw new EvalFailure("PREPARATION_NOT_COMPLETE");
      const prepared = await prepareLongCase(backend, store, data);
      for (let index = 0; index < data.questions.length; index++) {
        const question = data.questions[index]!, arms: Arm[] = ["optchat", "boros", "recent"];
        const ordered = [...arms.slice(index % 3), ...arms.slice(0, index % 3)];
        for (const arm of ordered) {
          const path = resolve(root, "answers", `${arm}-${hash(question.id).slice(0, 16)}.json`);
          if (existsSync(path)) continue;
          let answer: ComparisonAnswer;
          if (arm === "boros") {
            const context = load<{ input: BorosInput; envelope: BorosEnvelope }>(resolve(root, "boros-contexts", hash(question.id).slice(0, 16), "accepted.json"));
            answer = await answerBoros(backend, context.envelope, context.input, question);
          } else {
            const result = await answerLongQuestion(backend, prepared, { id: question.id, category: question.category, question: question.question }, { arm });
            answer = { public: result.public, private: { ...result.private, deliveredEvidence: evidenceFromOptChat(result, prepared) } };
          }
          Object.assign(answer.public, sourceCoverage(question, answer, data));
          save(path, answer);
          console.log(JSON.stringify({ phase: "answer", question: index + 1, arm, failure: answer.public.failure, steps: answer.public.steps, cumulativeCalls: backend.calls }));
          if (["CALL_LIMIT", "RUN_DEADLINE", "CONCURRENT_EVALUATION"].includes(answer.public.failure)) throw new EvalFailure(answer.public.failure);
        }
      }
      return;
    }
    const supplementPath = values.get("--supplement");
    if (!supplementPath) throw new EvalFailure("NATIVE_GRADER_REFERENCE_REQUIRED");
    const supplement = load<{ sourceProbeSHA256: string; normalizedCaseSHA256: string; questionCount: number; questions: Record<string, unknown> }>(resolve(supplementPath));
    if (supplement.sourceProbeSHA256 !== data.source.rawProbeHash || supplement.normalizedCaseSHA256 !== hash(readFileSync(resolve(casePath), "utf8")) || supplement.questionCount !== data.questions.length || data.questions.some(question => !supplement.questions[question.id])) throw new EvalFailure("NATIVE_REFERENCE_MISMATCH");
    const questions = data.questions.map(question => ({ ...question, nativeAuthorReference: supplement.questions[question.id] }));
    for (const question of questions) for (const arm of ["optchat", "boros", "recent"]) {
      if (!existsSync(resolve(root, "answers", `${arm}-${hash(question.id).slice(0, 16)}.json`))) throw new EvalFailure("ANSWERS_NOT_COMPLETE");
    }
    const calibrationPath = resolve(root, "calibration.json");
    const calibration = existsSync(calibrationPath) ? load<{ public: BeamCalibrationPublic }>(calibrationPath) : await runBeamCalibration(backend, questions);
    if (!existsSync(calibrationPath)) save(calibrationPath, calibration);
    console.log(JSON.stringify({ phase: "calibration", ...calibration.public }));
    requireBeamCalibration(calibration.public);
    const rows: Record<string, any>[] = [];
    for (const question of questions) for (const arm of ["optchat", "boros", "recent"] as Arm[]) {
      const name = `${arm}-${hash(question.id).slice(0, 16)}`, answer = load<ComparisonAnswer>(resolve(root, "answers", `${name}.json`));
      const gradePath = resolve(root, "grades", `${name}.json`);
      const grade = existsSync(gradePath) ? load<BeamGradeResult>(gradePath) : await gradeBeamCandidate(backend, question, answer.private.finalText, { calibration: calibration.public, deliveredEvidence: answer.private.deliveredEvidence });
      if (!existsSync(gradePath)) save(gradePath, grade);
      rows.push({ ...answer.public, ...grade.public, answerHash: hash(answer.private.finalText), gradeInputHash: grade.private.inputHash, gradeOutputHash: grade.private.outputHash });
      console.log(JSON.stringify({ phase: "grade", completed: rows.length, total: questions.length * 3, valid: grade.public.valid, cumulativeCalls: backend.calls }));
    }
    const summarize = (selected: typeof rows) => ({ questions: selected.length, correct: selected.filter(row => row.valid && row.correct && !row.failure).length,
      grounded: selected.filter(row => row.valid && row.grounded && !row.failure).length, invalidGrades: selected.filter(row => !row.valid).length,
      lowConfidence: selected.filter(row => row.confidenceHigh === 0).length, failures: selected.filter(row => row.failure).length,
      medianLatencyMs: selected.map(row => row.latencyMs).sort((a, b) => a - b)[Math.floor(selected.length / 2)],
      resolvableGoldSources: selected.reduce((n, row) => n + row.resolvableGoldSources, 0), deliveredGoldSources: selected.reduce((n, row) => n + row.deliveredGoldSources, 0),
      fullyDeliveredGoldSources: selected.reduce((n, row) => n + row.fullyDeliveredGoldSources, 0) });
    const arms = Object.fromEntries(["optchat", "boros", "recent"].map(arm => [arm, summarize(rows.filter(row => row.arm === arm))]));
    const categories = Object.fromEntries([...new Set(data.questions.map(question => question.category))].map(category => [category,
      Object.fromEntries(["optchat", "boros", "recent"].map(arm => [arm, summarize(rows.filter(row => row.arm === arm && row.category === category))]))]));
    const paired = { optchatOnlyCorrect: 0, borosOnlyCorrect: 0, bothCorrect: 0, bothIncorrect: 0 };
    for (const question of questions) {
      const a = rows.find(row => row.arm === "optchat" && row.questionId === question.id)!, b = rows.find(row => row.arm === "boros" && row.questionId === question.id)!;
      const ac = a.correct === 1 && a.valid === 1 && !a.failure, bc = b.correct === 1 && b.valid === 1 && !b.failure;
      paired[ac && bc ? "bothCorrect" : ac ? "optchatOnlyCorrect" : bc ? "borosOnlyCorrect" : "bothIncorrect"]++;
    }
    const report = { version: "beam-paired-result-1", acceptedQualityComparison: rows.every(row => row.valid && row.acceptedScore === 1),
      freeze, preparation: load(resolve(root, "preparation.json")), calibration: calibration.public, arms, categories, paired,
      cumulativeCalls: backend.calls, elapsedMs: Date.now() - backend.startedAt,
      modelUsage: backend.metrics.reduce((acc, metric) => ({ inputTokens: acc.inputTokens + (metric.inputTokens ?? 0), outputTokens: acc.outputTokens + (metric.outputTokens ?? 0) }), { inputTokens: 0, outputTokens: 0 }), rows };
    save(resolve(root, "public-result.json"), report);
    console.log(JSON.stringify({ phase: "complete", accepted: report.acceptedQualityComparison, arms, paired, cumulativeCalls: backend.calls }));
  } finally { store.close(); }
}
if (import.meta.main) runComparison(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ error: code(error) })); process.exitCode = 1; });

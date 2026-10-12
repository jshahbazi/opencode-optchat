import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store, hash, sourceKey } from "../src/index.ts";
import { EvalFailure, recentRecords, type Backend } from "./local-memory-eval.ts";
import { answerLongQuestion, longAnswerInstruction, longHistoryProtocol, ResumableLocalBackend, type NormalizedLongCase } from "./long-history-eval.ts";
import { optionalParentProtocol, prepareOptionalParentCase } from "./optional-parent-preparation.ts";
import { sourceCoverage, type ComparisonAnswer, type DeliveredEvidence } from "./compare-long-history.ts";
import { freezeBaseline, fullNormalizedSources, optPreparationFailure, runBaselineOnly } from "./beam-baseline-only.ts";
import { QWEN_MODEL, type BorosEnvelope } from "./boros-context-driver.ts";
import { beamGraderInstruction, gradeBeamCandidate, requireBeamCalibration, type BeamCalibrationPublic, type BeamGradeQuestion, type BeamGradeResult } from "./beam-grader.ts";

export const optionalComparisonProtocol = { version: "beam-optional-parent-comparison-1", arms: ["optchat", "boros", "recent"],
  baseProtocol: longHistoryProtocol, continuation: optionalParentProtocol, answersBeforeGrading: true,
  calibration: "reuse-accepted-baseline-controls", calls: "single-copied-cumulative-counter", strictPreparationAbort: optPreparationFailure } as const;
type CountedBackend = Backend & { readonly calls?: number; readonly startedAt?: number; readonly metrics?: { stage: string; latencyMs: number; inputTokens: number | null; outputTokens: number | null; success: boolean }[] };
type OptionalPreparation = Awaited<ReturnType<typeof prepareOptionalParentCase>>;
type PreparationMetadata = OptionalPreparation["metrics"] & { continuation: OptionalPreparation["continuation"] };
const code = (error: unknown) => { const value = (error as { code?: unknown })?.code; return typeof value === "string" && /^[A-Z_0-9]+$/.test(value) ? value : "INTERNAL_FAILURE"; };
const fatal = (failure: string | null | undefined) => !!failure && ["CALL_LIMIT", "RUN_DEADLINE", "CONCURRENT_EVALUATION"].includes(failure);
function save(path: string, value: unknown) { const directory = resolve(path, ".."); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
function load<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T; }
const calls = (backend: CountedBackend) => backend.calls ?? backend.metrics?.length ?? 0;
function usageSince(backend: CountedBackend, index: number) { return (backend.metrics ?? []).slice(index).reduce((sum, metric) => ({ inputTokens: sum.inputTokens + (metric.inputTokens ?? 0), outputTokens: sum.outputTokens + (metric.outputTokens ?? 0), knownCalls: sum.knownCalls + Number(metric.inputTokens !== null && metric.outputTokens !== null) }), { inputTokens: 0, outputTokens: 0, knownCalls: 0 }); }

export function optionalDeliveredEvidence(answer: Awaited<ReturnType<typeof answerLongQuestion>>, prepared: OptionalPreparation, submittedMessages = answer.private.messages): DeliveredEvidence[] {
  const originals = new Map(prepared.sources.map(source => [sourceKey(source), source]));
  const toolCalls = new Map<string, { name: string; input: any }>(), pages = new Map<string, Map<number, { text: string; next: number | null }>>();
  const directOriginals = new Map<string, string>();
  const partial: DeliveredEvidence[] = [], seen = new Set<string>();
  const addPartial = (id: string, offset: number, text: string) => { const identity = hash(JSON.stringify({ id, offset, text })); if (!seen.has(identity)) { seen.add(identity); partial.push({ sourceId: id, text, complete: false }); } };
  for (const message of submittedMessages) {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) {
      toolCalls.delete(call.id);
      let input: any; try { input = JSON.parse(call.function.arguments); } catch { continue; }
      toolCalls.set(call.id, { name: call.function.name, input });
    }
    if (message.role !== "tool" || !message.tool_call_id || !message.content) continue;
    const called = toolCalls.get(message.tool_call_id); if (!called) continue;
    let page: any; try { page = JSON.parse(message.content); } catch { continue; }
    if (page.error) continue;
    if (called.name === "optchat_search") {
      if (!Array.isArray(page.hits)) throw new EvalFailure("SOURCE_SEARCH_RECEIPT_MISMATCH");
      for (const hit of page.hits) {
        if (hit.type !== "source") continue;
        const original = originals.get(hit.id);
        if (!original || hit.kind !== original.kind || hit.sessionId !== original.sessionId || hit.text !== Array.from(original.payload).slice(0, 200).join("")) throw new EvalFailure("SOURCE_SEARCH_RECEIPT_MISMATCH");
        if (Array.from(original.payload).length <= 200 && hit.text === original.payload && hash(hit.text) === original.payloadHash) directOriginals.set(hit.id, hit.text);
        else addPartial(hit.id, 0, hit.text);
      }
      continue;
    }
    if (called.name === "optchat_zoom") {
      if (!Array.isArray(page.children)) throw new EvalFailure("SOURCE_ZOOM_RECEIPT_MISMATCH");
      for (const child of page.children) {
        if (typeof child.sourceId !== "string") continue;
        const original = originals.get(child.sourceId);
        if (!original) throw new EvalFailure("SOURCE_ZOOM_RECEIPT_MISMATCH");
        const node = prepared.engine.node(child.id);
        if (node.source !== child.sourceId || node.text !== child.text || node.start !== child.start || node.count !== child.count) throw new EvalFailure("SOURCE_ZOOM_RECEIPT_MISMATCH");
        if (child.text === original.payload && hash(child.text) === original.payloadHash) directOriginals.set(child.sourceId, child.text);
      }
      continue;
    }
    if (called.name !== "optchat_source") continue;
    const requested = { id: called.input?.id, offset: called.input?.offset ?? 0 };
    if (typeof requested.id !== "string" || !Number.isSafeInteger(requested.offset) || requested.offset < 0) throw new EvalFailure("SOURCE_PAGE_RECEIPT_MISMATCH");
    const original = originals.get(requested.id);
    if (!original || page.sourceId !== requested.id || typeof page.text !== "string" || page.metadata?.payloadHash !== original.payloadHash) throw new EvalFailure("SOURCE_PAGE_RECEIPT_MISMATCH");
    const originalPoints = Array.from(original.payload), returnedPoints = Array.from(page.text), end = requested.offset + returnedPoints.length;
    if (requested.offset > originalPoints.length || end > originalPoints.length || originalPoints.slice(requested.offset, end).join("") !== page.text || page.next !== (end === originalPoints.length ? null : end)) throw new EvalFailure("SOURCE_PAGE_RECEIPT_MISMATCH");
    const received = pages.get(requested.id) ?? new Map<number, { text: string; next: number | null }>();
    received.set(requested.offset, { text: page.text, next: page.next }); pages.set(requested.id, received);
    addPartial(requested.id, requested.offset, page.text);
  }
  const complete: DeliveredEvidence[] = [...directOriginals].map(([sourceId, text]) => ({ sourceId, text, complete: true })), completeIds = new Set(directOriginals.keys());
  for (const id of new Set(answer.private.exactSources)) {
    const original = originals.get(id), received = pages.get(id);
    const receipt = answer.private.receipts.find(item => item.sourceId === id && item.complete && item.exact && item.payloadHash === original?.payloadHash && item.returnedHash === original.payloadHash);
    if (!original || !received || !receipt) continue;
    let cursor: number | null = 0, combined = ""; const offsets = new Set<number>();
    while (cursor !== null && received.has(cursor) && !offsets.has(cursor)) { offsets.add(cursor); const page: { text: string; next: number | null } = received.get(cursor)!; combined += page.text; cursor = page.next; }
    if (cursor === null && combined === original.payload && hash(combined) === original.payloadHash && !completeIds.has(id)) { completeIds.add(id); complete.push({ sourceId: id, text: combined, complete: true }); }
  }
  return [...partial.filter(page => !completeIds.has(page.sourceId)), ...complete];
}

export function requireCompleteOptionalPreparation(metadata: PreparationMetadata, data: NormalizedLongCase) {
  const expected = data.messages.length, publications = Math.ceil(expected / longHistoryProtocol.recordsPerTurn);
  if (!metadata.originalHashesValid || metadata.originalCount !== expected || metadata.publications !== publications || metadata.continuation?.status !== "prepared" ||
      metadata.continuation.originalCount !== expected || metadata.continuation.publicationCount !== publications || metadata.continuation.mandatoryFailureCount !== 0) throw new EvalFailure("OPTIONAL_PREPARATION_NOT_COMPLETE");
}
export async function reconstructOptionalPreparation(root: string, data: NormalizedLongCase) {
  const path = resolve(root, "optional-parent-preparation.json");
  if (!existsSync(path)) throw new EvalFailure("OPTIONAL_PREPARATION_NOT_COMPLETE");
  const metadata = load<PreparationMetadata>(path); requireCompleteOptionalPreparation(metadata, data);
  const store = new Store(resolve(root, "memory.sqlite"));
  try {
    const forbidden: Backend = { async complete() { throw new EvalFailure("UNEXPECTED_PREPARATION_CALL"); } };
    const prepared = await prepareOptionalParentCase(forbidden, store, data);
    requireCompleteOptionalPreparation({ ...prepared.metrics, continuation: prepared.continuation }, data);
    if (JSON.stringify(prepared.metrics) !== JSON.stringify(Object.fromEntries(Object.entries(metadata).filter(([field]) => field !== "continuation")))) throw new EvalFailure("OPTIONAL_PREPARATION_MISMATCH");
    return { store, prepared, metadata };
  } catch (error) { store.close(); throw error; }
}
function copiedLineage(root: string) {
  const marker = load<{ sourceRunDirectory: string; sourceDatabaseHash: string }>(resolve(root, "optional-parent-copy.json"));
  const preparationFreeze = load<{ sourceBackendStateHash: string }>(resolve(root, "optional-parent-freeze.json"));
  const bytes = readFileSync(resolve(marker.sourceRunDirectory, "backend-state.json"), "utf8");
  if (hash(bytes) !== preparationFreeze.sourceBackendStateHash) throw new EvalFailure("SOURCE_COUNTER_LINEAGE_MISMATCH");
  const state = JSON.parse(bytes) as { calls: number; startedAt: number };
  if (!Number.isSafeInteger(state.calls) || state.calls < 0 || !Number.isFinite(state.startedAt)) throw new EvalFailure("SOURCE_COUNTER_LINEAGE_MISMATCH");
  return { inheritedCalls: state.calls, sourceBackendHash: hash(bytes), sourceDirectoryHash: hash(marker.sourceRunDirectory), sourceDatabaseHash: marker.sourceDatabaseHash };
}
function freezeComparison(casePath: string, root: string, supplementPath: string, preparation: PreparationMetadata) {
  const baseline = freezeBaseline(casePath, root, supplementPath), lineage = copiedLineage(root);
  baselineCells(root, baseline.data, baseline.identityHash);
  const baselineAnswerHashes = Object.fromEntries(baseline.data.questions.flatMap(question => ["boros", "recent"].map(arm => {
    const name = `${arm}-${hash(question.id).slice(0, 16)}`; return [name, hash(readFileSync(resolve(root, "baseline-answers", `${name}.json`), "utf8"))];
  })));
  const dependencies = ["scripts/optional-parent-preparation.ts", "scripts/beam-baseline-only.ts", "scripts/compare-long-history.ts", "scripts/long-history-eval.ts", "scripts/local-memory-eval.ts", "scripts/beam-grader.ts", "scripts/boros-context-driver.ts", "src/core/engine.ts", "src/storage/store.ts", "src/core/context.ts", "src/core/retrieval.ts", "src/compactor/summarizer.ts"];
  const repository = resolve(import.meta.dir, "..");
  const freeze = { protocol: optionalComparisonProtocol, protocolHash: hash(JSON.stringify(optionalComparisonProtocol)), sourceHash: hash(readFileSync(import.meta.path, "utf8")),
    dependencyHashes: Object.fromEntries(dependencies.map(path => [path, hash(readFileSync(resolve(repository, path), "utf8"))])),
    baselineIdentityHash: baseline.identityHash, caseFileHash: baseline.freeze.caseFileHash, supplementHash: baseline.freeze.supplementHash, contextHashes: baseline.freeze.contextHashes,
    preparationHash: hash(readFileSync(resolve(root, "optional-parent-preparation.json"), "utf8")), preparationCaseHash: preparation.caseHash,
    continuationFreezeHash: hash(readFileSync(resolve(root, "optional-parent-freeze.json"), "utf8")), baselineAnswerHashes, lineage };
  const path = resolve(root, "optional-comparison-freeze.json");
  if (existsSync(path)) { if (JSON.stringify(load(path)) !== JSON.stringify(freeze)) throw new EvalFailure("OPTIONAL_COMPARISON_FREEZE_MISMATCH"); }
  else save(path, freeze);
  return { ...baseline, freeze, identityHash: hash(JSON.stringify(freeze)), lineage };
}
function baselineCells(root: string, data: NormalizedLongCase, identity: string) {
  return data.questions.flatMap(question => ["boros", "recent"].map(arm => {
    const path = resolve(root, "baseline-answers", `${arm}-${hash(question.id).slice(0, 16)}.json`);
    if (!existsSync(path)) throw new EvalFailure("BASELINE_ANSWERS_NOT_COMPLETE");
    const answer = load<ComparisonAnswer>(path);
    if (answer.private.baselineIdentityHash !== identity || fatal(answer.public.failure) || answer.public.questionId !== question.id || answer.public.category !== question.category || answer.public.arm !== arm || typeof answer.private.finalText !== "string" || !Array.isArray(answer.private.messages)) throw new EvalFailure("BASELINE_ANSWER_MISMATCH");
    if (arm === "boros") {
      const context = load<{ envelope: BorosEnvelope }>(resolve(root, "boros-contexts", hash(question.id).slice(0, 16), "accepted.json")), native = context.envelope.attempts.find(attempt => attempt.arm === "ordinary_send")!;
      const messages = native.messages!, expectedEvidence = native.sources!.map(source => ({ sourceId: source.event_id, text: source.text, complete: source.offset === 0 && source.bytes === source.source_bytes }));
      if (answer.public.submittedMessagesHash !== hash(JSON.stringify(messages)) || answer.public.nativePreparedBodyHash !== native.body_sha256 || answer.public.selectionHash !== native.selection_sha256 || JSON.stringify(answer.private.messages) !== JSON.stringify(messages) || JSON.stringify(answer.private.deliveredEvidence) !== JSON.stringify(expectedEvidence)) throw new EvalFailure("BASELINE_ANSWER_MISMATCH");
    } else {
      const sources = recentRecords(fullNormalizedSources(data), 16000), memory = JSON.stringify(sources.map(source => ({ sourceId: sourceKey(source), role: source.kind, text: source.payload })));
      const expected = [{ role: "system", content: longAnswerInstruction + " Complete recent originals follow in author order.\nHISTORICAL_DATA:\n" + memory }, { role: "user", content: question.question }];
      const messages = answer.private.messages as Parameters<Backend["complete"]>[0], expectedEvidence = sources.map(source => ({ sourceId: sourceKey(source), text: source.payload, complete: true }));
      if (JSON.stringify(messages.slice(0, 2)) !== JSON.stringify(expected) || JSON.stringify(answer.private.deliveredEvidence) !== JSON.stringify(expectedEvidence) || messages.length < 2 || messages.length > 3 || messages.length === 3 && (messages[2]!.role !== "assistant" || messages[2]!.content !== answer.private.finalText)) throw new EvalFailure("BASELINE_ANSWER_MISMATCH");
    }
    const coverage = sourceCoverage(question, answer, data);
    if (Object.entries(coverage).some(([field, value]) => answer.public[field] !== value)) throw new EvalFailure("BASELINE_ANSWER_MISMATCH");
    return answer;
  }));
}
function answerContentHash(answer: ComparisonAnswer) {
  return hash(JSON.stringify({ finalText: answer.private.finalText, messages: answer.private.messages, submittedMessages: answer.private.submittedMessages, deliveredEvidence: answer.private.deliveredEvidence }));
}
export function expectedGradingInputHash(question: BeamGradeQuestion, answer: ComparisonAnswer): string {
  const input = { question: question.question, category: question.category, referenceAnswer: question.referenceAnswer, nativeRubric: question.rubric,
    ...(question.nativeAuthorReference !== undefined ? { nativeAuthorReference: question.nativeAuthorReference } : {}),
    ...(question.idealSummary !== undefined ? { authoredIdealSummary: question.idealSummary } : {}),
    candidate: answer.private.finalText, deliveredEvidence: answer.private.deliveredEvidence };
  return hash(JSON.stringify([{ role: "system", content: beamGraderInstruction }, { role: "user", content: JSON.stringify(input) }]));
}
function verifyGradingInput(grade: BeamGradeResult, expected: string) {
  if (grade.private.inputHash !== expected || hash(JSON.stringify(grade.private.messages)) !== expected) throw new EvalFailure("GRADING_INPUT_MISMATCH");
}
function baselineGradePreflight(root: string, data: NormalizedLongCase, supplement: { questions: Record<string, unknown> }, baselineIdentity: string) {
  for (const question of data.questions) for (const arm of ["boros", "recent"]) {
    const name = `${arm}-${hash(question.id).slice(0, 16)}`, path = resolve(root, "baseline-grades", `${name}.json`);
    if (!existsSync(path)) continue;
    const answer = load<ComparisonAnswer>(resolve(root, "baseline-answers", `${name}.json`)), saved = load<{ baselineIdentityHash: string; answerHash: string; grade: BeamGradeResult }>(path);
    const expected = expectedGradingInputHash({ ...question, nativeAuthorReference: supplement.questions[question.id] }, answer);
    if (saved.baselineIdentityHash !== baselineIdentity || saved.answerHash !== hash(answer.private.finalText)) throw new EvalFailure("BASELINE_GRADE_MISMATCH");
    verifyGradingInput(saved.grade, expected);
    const ledger = { baselineIdentityHash: baselineIdentity, questionId: question.id, arm, inputHash: expected, gradeFileHash: hash(readFileSync(path, "utf8")) }, ledgerPath = resolve(root, "baseline-grade-ledger", `${name}.json`);
    if (existsSync(ledgerPath)) { if (JSON.stringify(load(ledgerPath)) !== JSON.stringify(ledger)) throw new EvalFailure("BASELINE_GRADE_MISMATCH"); }
    else save(ledgerPath, ledger);
  }
}
function summarize(rows: Record<string, any>[], accepted: boolean) {
  const latencies = rows.map(row => row.latencyMs).sort((a, b) => a - b);
  return { questions: rows.length, correct: accepted ? rows.filter(row => row.valid && row.correct === 1 && !row.failure).length : null,
    grounded: accepted ? rows.filter(row => row.valid && row.grounded === 1 && !row.failure).length : null,
    failures: rows.filter(row => row.failure).length, invalidGrades: rows.filter(row => row.valid === 0).length, lowConfidence: rows.filter(row => row.confidenceHigh === 0).length,
    medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    answerCalls: rows.reduce((sum, row) => sum + (row.answerCalls ?? 0), 0), gradingCalls: rows.reduce((sum, row) => sum + (row.gradingCalls ?? 0), 0),
    answerInputTokens: rows.reduce((sum, row) => sum + (row.answerUsage?.inputTokens ?? 0), 0), answerOutputTokens: rows.reduce((sum, row) => sum + (row.answerUsage?.outputTokens ?? 0), 0), gradingInputTokens: rows.reduce((sum, row) => sum + (row.gradingUsage?.inputTokens ?? 0), 0), gradingOutputTokens: rows.reduce((sum, row) => sum + (row.gradingUsage?.outputTokens ?? 0), 0),
    resolvableGoldSources: rows.reduce((sum, row) => sum + row.resolvableGoldSources, 0), deliveredGoldSources: rows.reduce((sum, row) => sum + row.deliveredGoldSources, 0), fullyDeliveredGoldSources: rows.reduce((sum, row) => sum + row.fullyDeliveredGoldSources, 0) };
}
export async function runOptionalComparison(args: string[], options: { backend?: CountedBackend; onProgress?: (details: Record<string, unknown>) => void } = {}): Promise<Record<string, any>> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) { if (!["--case", "--run", "--mode", "--supplement"].includes(args[i]!) || !args[i + 1]) throw new EvalFailure("INVALID_CLI"); values.set(args[i]!, args[i + 1]!); }
  const casePath = values.get("--case"), run = values.get("--run"), mode = values.get("--mode"), supplementPath = values.get("--supplement");
  if (!casePath || !run || !supplementPath || (mode !== "answers" && mode !== "grade")) throw new EvalFailure("EXPLICIT_OPTIONAL_COMPARISON_REQUIRED");
  const root = resolve(run), data = load<NormalizedLongCase>(resolve(casePath)), restored = await reconstructOptionalPreparation(root, data);
  try {
    const frozen = freezeComparison(casePath, root, supplementPath, restored.metadata), { identityHash, supplement } = frozen;
    baselineCells(root, data, frozen.freeze.baselineIdentityHash);
    const backend = options.backend ?? new ResumableLocalBackend({ url: "http://127.0.0.1:11234/v1/chat/completions", model: QWEN_MODEL, directory: root });
    const progress = options.onProgress ?? (details => console.log(JSON.stringify(details)));
    const pathFor = (question: { id: string }) => resolve(root, "optional-answers", `optchat-${hash(question.id).slice(0, 16)}.json`);
    const ledgerFor = (question: { id: string }) => resolve(root, "optional-answer-ledger", `${hash(question.id).slice(0, 16)}.json`);
    const checkLedger = (path: string, question: { id: string }) => {
      const value = { identityHash, questionId: question.id, fileHash: hash(readFileSync(path, "utf8")) }, ledgerPath = ledgerFor(question);
      if (existsSync(ledgerPath)) { if (JSON.stringify(load(ledgerPath)) !== JSON.stringify(value)) throw new EvalFailure("OPTIONAL_ANSWER_MISMATCH"); }
      else save(ledgerPath, value);
    };
    const readAnswer = (path: string, question: NormalizedLongCase["questions"][number]) => {
      const answer = load<ComparisonAnswer>(path), messages = answer.private.messages as Parameters<Backend["complete"]>[0], submitted = answer.private.submittedMessages as Parameters<Backend["complete"]>[0];
      if (answer.private.optionalComparisonIdentityHash !== identityHash || fatal(answer.public.failure) || answer.public.questionId !== question.id || answer.public.category !== question.category || answer.public.arm !== "optchat" || answer.public.questionHash !== hash(question.question) || answer.public.caseHash !== restored.prepared.metrics.caseHash || answer.public.protocolHash !== restored.prepared.metrics.protocolHash || typeof answer.private.finalText !== "string" || !Array.isArray(messages) || !Array.isArray(submitted) || messages[1]?.role !== "user" || messages[1]?.content !== question.question || JSON.stringify(submitted) !== JSON.stringify(messages.slice(0, submitted.length)) || answer.private.answerContentHash !== answerContentHash(answer)) throw new EvalFailure("OPTIONAL_ANSWER_MISMATCH");
      if (answer.private.finalText && (messages.at(-1)?.role !== "assistant" || messages.at(-1)?.content !== answer.private.finalText)) throw new EvalFailure("OPTIONAL_ANSWER_MISMATCH");
      const actualEvidence = optionalDeliveredEvidence(answer as unknown as Awaited<ReturnType<typeof answerLongQuestion>>, restored.prepared, submitted);
      if (JSON.stringify(actualEvidence) !== JSON.stringify(answer.private.deliveredEvidence)) throw new EvalFailure("OPTIONAL_ANSWER_MISMATCH");
      const coverage = sourceCoverage(question, answer, data);
      if (Object.entries(coverage).some(([field, value]) => answer.public[field] !== value)) throw new EvalFailure("OPTIONAL_ANSWER_MISMATCH");
      checkLedger(path, question); return answer;
    };
    if (mode === "answers") {
      for (let index = 0; index < data.questions.length; index++) {
        const question = data.questions[index]!, path = pathFor(question);
        if (existsSync(path)) { readAnswer(path, question); continue; }
        const before = calls(backend), metricStart = backend.metrics?.length ?? 0;
        let submittedMessages: Parameters<Backend["complete"]>[0] = [];
        const recordingBackend: Backend = { complete(messages, tools, stage, maxTokens) { submittedMessages = structuredClone(messages); return backend.complete(messages, tools, stage, maxTokens); } };
        const result = await answerLongQuestion(recordingBackend, restored.prepared, { id: question.id, category: question.category, question: question.question });
        if (fatal(result.public.failure)) throw new EvalFailure(result.public.failure!);
        const answer: ComparisonAnswer = { public: { ...result.public, answerCalls: calls(backend) - before, answerUsage: usageSince(backend, metricStart) },
          private: { ...result.private, submittedMessages, deliveredEvidence: optionalDeliveredEvidence(result, restored.prepared, submittedMessages), optionalComparisonIdentityHash: identityHash } };
        Object.assign(answer.public, sourceCoverage(question, answer, data)); answer.private.answerContentHash = answerContentHash(answer); save(path, answer); checkLedger(path, question);
        progress({ phase: "optional-answer", completed: index + 1, total: data.questions.length, failures: Number(!!answer.public.failure), cumulativeCalls: calls(backend) });
      }
      return { phase: "optional-answers-complete", answerCells: data.questions.length, cumulativeCalls: calls(backend) };
    }
    const answers = data.questions.map(question => { const path = pathFor(question); if (!existsSync(path)) throw new EvalFailure("OPTCHAT_ANSWERS_NOT_COMPLETE"); return { question, answer: readAnswer(path, question) }; });
    baselineGradePreflight(root, data, supplement, frozen.freeze.baselineIdentityHash);
    const checkOptionalGrade = (saved: { identityHash: string; questionId: string; category: string; arm: string; answerHash: string; gradingInputHash: string; grade: BeamGradeResult }, question: NormalizedLongCase["questions"][number], answer: ComparisonAnswer) => {
      const expected = expectedGradingInputHash({ ...question, nativeAuthorReference: supplement.questions[question.id] }, answer);
      if (saved.identityHash !== identityHash || saved.questionId !== question.id || saved.category !== question.category || saved.arm !== "optchat" || saved.answerHash !== hash(answer.private.finalText) || saved.gradingInputHash !== expected) throw new EvalFailure("OPTIONAL_GRADE_MISMATCH");
      verifyGradingInput(saved.grade, expected);
    };
    for (const { question, answer } of answers) {
      const path = resolve(root, "optional-grades", `${hash(question.id).slice(0, 16)}.json`);
      if (existsSync(path)) checkOptionalGrade(load(path), question, answer);
    }
    const reportPath = resolve(root, "public-result-comparison.json");
    if (existsSync(reportPath)) { const report = load<Record<string, any>>(reportPath); if (report.optionalComparisonIdentityHash !== identityHash) throw new EvalFailure("OPTIONAL_RESULT_MISMATCH"); return report; }
    const baseline = await runBaselineOnly(["--case", casePath, "--run", root, "--supplement", supplementPath, "--mode", "grade"], { backend, onProgress: progress });
    baselineGradePreflight(root, data, supplement, frozen.freeze.baselineIdentityHash);
    const calibration = load<{ public: BeamCalibrationPublic }>(resolve(root, "baseline-calibration.json"));
    let calibrationAccepted = false;
    try { requireBeamCalibration(calibration.public); calibrationAccepted = baseline.qualityComparisonAccepted === true; } catch (error) { if (code(error) !== "GRADER_CALIBRATION_FAILED") throw error; }
    const optRows: Record<string, any>[] = [];
    for (const { question, answer } of answers) {
      let grade: BeamGradeResult | undefined, gradingCalls = 0, gradingUsage = { inputTokens: 0, outputTokens: 0, knownCalls: 0 };
      if (calibrationAccepted) {
        const path = resolve(root, "optional-grades", `${hash(question.id).slice(0, 16)}.json`), answerHash = hash(answer.private.finalText);
        if (existsSync(path)) {
          const saved = load<{ identityHash: string; questionId: string; category: string; arm: string; answerHash: string; gradingInputHash: string; grade: BeamGradeResult; gradingCalls: number; gradingUsage: typeof gradingUsage }>(path);
          checkOptionalGrade(saved, question, answer); grade = saved.grade; gradingCalls = saved.gradingCalls; gradingUsage = saved.gradingUsage;
        } else {
          const before = calls(backend), metricStart = backend.metrics?.length ?? 0;
          grade = await gradeBeamCandidate(backend, { ...question, nativeAuthorReference: supplement.questions[question.id] }, answer.private.finalText, { calibration: calibration.public, deliveredEvidence: answer.private.deliveredEvidence });
          if (fatal(grade.private.failure)) throw new EvalFailure(grade.private.failure!);
          gradingCalls = calls(backend) - before; gradingUsage = usageSince(backend, metricStart);
          const gradingInputHash = expectedGradingInputHash({ ...question, nativeAuthorReference: supplement.questions[question.id] }, answer); verifyGradingInput(grade, gradingInputHash);
          save(path, { identityHash, questionId: question.id, category: question.category, arm: "optchat", answerHash, gradingInputHash, grade, gradingCalls, gradingUsage });
        }
      }
      optRows.push({ ...answer.public, ...(grade?.public ?? {}), gradingCalls, gradingUsage, answerHash: hash(answer.private.finalText) });
      progress({ phase: "optional-grade", completed: optRows.length, total: answers.length, accepted: Number(calibrationAccepted && grade?.public.valid === 1), cumulativeCalls: calls(backend) });
    }
    const rows: Record<string, any>[] = [...baseline.rows, ...optRows], qualityComparisonAccepted = calibrationAccepted && rows.every(row => row.valid === 1 && row.acceptedScore === 1);
    const arms = Object.fromEntries(["optchat", "boros", "recent"].map(arm => [arm, summarize(rows.filter(row => row.arm === arm), qualityComparisonAccepted)]));
    const categories = Object.fromEntries([...new Set(data.questions.map(question => question.category))].map(category => [category,
      Object.fromEntries(["optchat", "boros", "recent"].map(arm => [arm, summarize(rows.filter(row => row.arm === arm && row.category === category), qualityComparisonAccepted)]))]));
    const paired = qualityComparisonAccepted ? { optchatOnlyCorrect: 0, borosOnlyCorrect: 0, bothCorrect: 0, bothIncorrect: 0 } : null;
    if (paired) for (const question of data.questions) {
      const a = rows.find(row => row.arm === "optchat" && row.questionId === question.id)!, b = rows.find(row => row.arm === "boros" && row.questionId === question.id)!;
      const ac = a.valid === 1 && a.correct === 1 && !a.failure, bc = b.valid === 1 && b.correct === 1 && !b.failure;
      paired[ac && bc ? "bothCorrect" : ac ? "optchatOnlyCorrect" : bc ? "borosOnlyCorrect" : "bothIncorrect"]++;
    }
    const cumulativeCalls = calls(backend), modelUsage = usageSince(backend, 0);
    const report = { version: "beam-optional-comparison-result-1", optionalComparisonIdentityHash: identityHash, qualityComparisonAccepted, qualityComparisonHeld: !qualityComparisonAccepted,
      holdReason: !calibrationAccepted ? baseline.holdReason ?? "BASELINE_COMPARISON_HELD" : !qualityComparisonAccepted ? "INVALID_OPTCHAT_GRADES" : null,
      freeze: frozen.freeze, strictPreparationAbort: optPreparationFailure, continuation: restored.metadata, calibration: calibration.public,
      originalHistoryCount: data.messages.length, questionCount: data.questions.length, arms, categories, paired, rows,
      lineage: { inheritedInitialCalls: frozen.lineage.inheritedCalls, newCallsSinceCopy: cumulativeCalls - frozen.lineage.inheritedCalls, cumulativeCalls, inheritedCallsCountedOnce: true },
      cumulativeCalls, modelUsage, elapsedMs: backend.startedAt ? Date.now() - backend.startedAt : null };
    save(reportPath, report); return report;
  } finally { restored.store.close(); }
}
if (import.meta.main) runOptionalComparison(process.argv.slice(2)).then(result => console.log(JSON.stringify({ phase: "optional-comparison-complete", accepted: result.qualityComparisonAccepted ?? false, cumulativeCalls: result.cumulativeCalls }))).catch(error => { console.error(JSON.stringify({ error: code(error) })); process.exitCode = 1; });

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Engine, Store, assembleContext, bytes, hash, key, sourceKey, type Node, type Publication, type Turn } from "../src/index.ts";
import { validateCover } from "../src/core/tree.ts";
import { renderedBytes } from "../src/core/views.ts";
import { EvalFailure, recentRecords, type Backend, type Receipt } from "./local-memory-eval.ts";
import { longAnswerInstruction, longCaseHashes, longHistoryProtocol, longTools, ResumableLocalBackend, type NormalizedLongCase, type PreparedLongCase } from "./long-history-eval.ts";
import { classifyParentFailure } from "./optional-parent-preparation.ts";
import { optionalDeliveredEvidence } from "./optional-parent-comparison.ts";
import { freezeBaseline, fullNormalizedSources, optPreparationFailure } from "./beam-baseline-only.ts";
import { sourceCoverage, type ComparisonAnswer } from "./compare-long-history.ts";
import { QWEN_MODEL, type BorosEnvelope } from "./boros-context-driver.ts";
import { beamGraderInstruction, beamGradingProtocol, createBeamCalibrationControls, gradeBeamCandidate, parseBeamVerdict, requireBeamCalibration, type BeamGradeQuestion, type BeamGradeResult, type BeamCalibrationPublic } from "./beam-grader.ts";

type Messages = Parameters<Backend["complete"]>[0];
export type RequestTokenCounter = (messages: Messages, tools: unknown[], maxOutputTokens: number) => Promise<number>;
type CountedBackend = Backend & { readonly calls?: number; readonly startedAt?: number; readonly metrics?: { stage: string; latencyMs: number; inputTokens: number | null; outputTokens: number | null; success: boolean }[] };
export const expandedMemoryProtocol = {
  version: "beam-expanded-memory-comparison-1", memoryBytes: 65536, viewHighBytes: 65536, viewLowBytes: 49152,
  preliminaryByteEnvelope: 131072, contextTokens: 32768, outputTokens: 2048, safetyTokens: 1024, maxAnswerSteps: 12,
  summaryAcceptBytes: 1024, summaryPolicy: "Reuse the complete graph. Do not retry or run compaction.",
  inputCounting: "Actual Qwen request chat template and tokenizer, before each submitted request.",
  tools: "Unchanged search, source, and zoom tools.", temperature: 0, thinking: false, parallelCalls: false,
  gradePolicy: "Grade all three arms again. Omit deliveredEvidence. Report source coverage separately.",
  gradingActualContextTokens: 32768,
  gradingProtocol: beamGradingProtocol, calibration: "Verify and reuse unchanged accepted correctness-only controls.",
  arms: ["optchat", "boros", "recent"], baselinePolicy: "Reuse all immutable baseline answers after request and evidence checks.",
  answersBeforeGrading: true, maxCalls: 6000, additionalMinutes: 120,
} as const;
const fatalCodes = new Set(["CALL_LIMIT", "RUN_DEADLINE", "CONCURRENT_EVALUATION"]);
const safeCode = (error: unknown) => { const code = (error as { code?: unknown })?.code; return typeof code === "string" && /^[A-Z_0-9]{1,64}$/.test(code) ? code : "INTERNAL_FAILURE"; };
function failFatal(error: unknown) { const code = safeCode(error); if (fatalCodes.has(code)) throw error instanceof EvalFailure ? error : new EvalFailure(code); }
function load<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T; }
function save(path: string, value: unknown) { const directory = resolve(path, ".."); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
const fileHash = (path: string) => hash(readFileSync(path, "utf8"));
const calls = (backend: CountedBackend) => backend.calls ?? backend.metrics?.length ?? 0;
function usageSince(backend: CountedBackend, index: number) { return (backend.metrics ?? []).slice(index).reduce((sum, metric) => ({ inputTokens: sum.inputTokens + (metric.inputTokens ?? 0), outputTokens: sum.outputTokens + (metric.outputTokens ?? 0), knownCalls: sum.knownCalls + Number(metric.inputTokens !== null && metric.outputTokens !== null) }), { inputTokens: 0, outputTokens: 0, knownCalls: 0 }); }
function ledger(root: string, bucket: string, name: string, value: unknown) { const path = resolve(root, bucket, `${name}.json`); if (existsSync(path)) { if (JSON.stringify(load(path)) !== JSON.stringify(value)) throw new EvalFailure("IMMUTABLE_LEDGER_MISMATCH"); } else save(path, value); }

/** Audit accepted originals and publications before admitting a new reader. No worker runs here. */
export function reconstructExpandedPreparation(store: Store, data: NormalizedLongCase) {
  const hashes = longCaseHashes(data), sessionId = `archive-${hashes.caseHash.slice(0, 16)}`, scopeId = `scope-${hashes.caseHash.slice(0, 16)}`;
  const expectedIdentity = { ...hashes, source: data.source, protocol: longHistoryProtocol };
  if (JSON.stringify(store.get("longEvaluation", "identity")) !== JSON.stringify(expectedIdentity)) throw new EvalFailure("EXPANDED_CASE_MISMATCH");
  if (store.db.query("SELECT 1 FROM jobs WHERE status IN ('pending','running') LIMIT 1").get() || store.db.query("SELECT 1 FROM publication_candidates LIMIT 1").get() || store.db.query("SELECT 1 FROM publication_dependencies LIMIT 1").get()) throw new EvalFailure("EXPANDED_GRAPH_NOT_COMPLETE");
  const failureRows = store.db.query("SELECT id,input,attempts,fence,error FROM jobs WHERE status='failed' ORDER BY id").all() as { id: string; input: string; attempts: number; fence: number; error: string | null }[];
  const failures = failureRows.map(row => classifyParentFailure(store, row, sessionId, scopeId));
  if (failures.some(failure => !failure.optional)) throw new EvalFailure("MANDATORY_PREPARATION_FAILURE");
  const durableHashes = () => ({ sources: hash(JSON.stringify(store.db.query("SELECT id,value FROM sources ORDER BY id").all())), nodes: hash(JSON.stringify(store.db.query("SELECT id,value FROM nodes ORDER BY id").all())), publications: hash(JSON.stringify(store.all<Publication>("publications").sort((a, b) => a.id.localeCompare(b.id)))), jobs: hash(JSON.stringify(store.db.query("SELECT * FROM jobs ORDER BY id").all())) });
  const before = durableHashes();
  const forbidden = { async summarize(): Promise<never> { throw new EvalFailure("UNEXPECTED_PREPARATION_CALL"); }, async summarizeBatch(): Promise<never> { throw new EvalFailure("UNEXPECTED_PREPARATION_CALL"); } };
  const engine = new Engine(store, forbidden, { high: expandedMemoryProtocol.viewHighBytes, low: expandedMemoryProtocol.viewLowBytes, summaryAcceptBytes: expandedMemoryProtocol.summaryAcceptBytes, maxRunningJobs: 1 });
  const session = engine.session(sessionId);
  if (session.scopeId !== scopeId || session.projectId !== "beam-public-evaluation" || session.generation !== 0 || session.disabled) throw new EvalFailure("EXPANDED_CASE_MISMATCH");
  const sources = engine.sources(sessionId, 0), expectedSources = fullNormalizedSources(data);
  if (sources.length !== expectedSources.length || sources.some((source, index) => Object.keys(source).length !== Object.keys(expectedSources[index]!).length || Object.entries(expectedSources[index]!).some(([field, value]) => (source as any)[field] !== value)) || (store.db.query("SELECT count(*) n FROM sources").get() as { n: number }).n !== expectedSources.length) throw new EvalFailure("ORIGINAL_RETENTION_MISMATCH");
  const publications = store.all<Publication>("publications").sort((a, b) => a.publicationSeq - b.publicationSeq), expectedTurns = Math.ceil(sources.length / 2);
  if (publications.length !== expectedTurns || publications.some((publication, index) => publication.sessionId !== sessionId || publication.generation !== 0 || publication.scopeId !== scopeId || publication.publicationSeq !== index + 1 || publication.start !== index * 2 || publication.end !== Math.min(sources.length, index * 2 + 2) || publication.turnId !== `turn-${String(index).padStart(6, "0")}` || publication.outcome !== "completed")) throw new EvalFailure("PUBLICATION_RETENTION_MISMATCH");
  for (const publication of publications) {
    const turn = store.get<Turn>("turns", key(sessionId, 0, publication.turnId)), cover = publication.sourceCover.map(id => engine.node(id)), node = engine.node(publication.nodeId);
    if (!turn || turn.start !== publication.start || turn.end !== publication.end || turn.outcome !== "completed" || node.publicationId !== publication.id || node.start !== publication.publicationSeq - 1 || node.count !== 1 || JSON.stringify(node.children) !== JSON.stringify(publication.sourceCover)) throw new EvalFailure("PUBLICATION_RETENTION_MISMATCH");
    validateCover(cover, publication.start, publication.end);
  }
  engine.register("expanded-evaluation-reader", scopeId, "beam-public-evaluation");
  const snapshot = engine.admit("expanded-evaluation-reader", "fixed-expanded-history").snapshot;
  if (snapshot.ownBoundary !== 0 || snapshot.view.prefix !== expectedTurns || snapshot.highWater !== expectedTurns) throw new EvalFailure("PUBLICATION_COVER_INCOMPLETE");
  validateCover(snapshot.view.nodes.map(id => engine.node(id)), 0, expectedTurns);
  const projection = engine.projection(snapshot.view, expandedMemoryProtocol.memoryBytes), frontier = snapshot.view.nodes.map(id => engine.node(id));
  const nodes = (store.db.query("SELECT value FROM nodes").all() as { value: string }[]).map(row => JSON.parse(row.value) as Node), depths = new Map<string, number>(), visiting = new Set<string>();
  const depth = (id: string): number => { if (depths.has(id)) return depths.get(id)!; if (visiting.has(id)) throw new EvalFailure("GRAPH_CYCLE"); visiting.add(id); const node = engine.node(id); const value = node.children.length ? 1 + Math.max(...node.children.map(depth)) : 0; visiting.delete(id); depths.set(id, value); return value; };
  const counters = store.get<{ modelCalls: number; correctionRetries: number; batchCalls: number }>("longEvaluation", "summaryCounters") ?? { modelCalls: 0, correctionRetries: 0, batchCalls: 0 };
  const metrics: PreparedLongCase["metrics"] = { ...hashes, protocolHash: hash(JSON.stringify(expandedMemoryProtocol)), originalCount: sources.length, originalBytes: sources.reduce((sum, source) => sum + bytes(source.payload), 0), originalHashesValid: true, publications: expectedTurns, nodeCount: nodes.length, chunkNodes: nodes.filter(node => node.tree.startsWith('["chunk"')).length, fallbackNodes: nodes.filter(node => node.fallback).length, losslessNodes: nodes.filter(node => node.model === "lossless-local").length, summaryModelCalls: counters.modelCalls, summaryCorrectionRetries: counters.correctionRetries, summaryBatchCalls: counters.batchCalls, failedJobs: failures.length, jobRetries: (store.db.query("SELECT COALESCE(sum(max(attempts-1,0)),0) n FROM jobs").get() as { n: number }).n, maxSummaryBytes: Math.max(0, ...nodes.map(node => node.bytes)), projectionBytes: renderedBytes(projection), projectionCount: projection.length, projectionMaxDepth: Math.max(0, ...projection.map(node => depth(node.id))), selectedRangeMaxCount: Math.max(0, ...projection.map(node => node.count)), frontierCount: frontier.length, frontierBytes: renderedBytes(frontier) };
  if (JSON.stringify(before) !== JSON.stringify(durableHashes())) throw new EvalFailure("EXPANDED_GRAPH_CHANGED");
  return { prepared: { engine, snapshot, sources, metrics } satisfies PreparedLongCase, audit: { ...metrics, durableHashes: before, snapshotHash: hash(JSON.stringify(snapshot)), optionalFailures: failures.length, mandatoryFailures: 0, pendingJobs: 0, compactionCalls: 0, retainedFailureHash: hash(JSON.stringify(failureRows)) } };
}

export function expandedInitialMessages(prepared: PreparedLongCase, question: { question: string }): { messages: Messages; memory: string } {
  const memory = assembleContext(prepared.engine, { snapshot: prepared.snapshot, system: [{ type: "text", text: longAnswerInstruction }], tools: longTools, live: [{ role: "user", content: question.question }], budget: { contextTokens: expandedMemoryProtocol.preliminaryByteEnvelope, outputTokens: expandedMemoryProtocol.outputTokens, safetyTokens: expandedMemoryProtocol.safetyTokens, memoryBytes: expandedMemoryProtocol.memoryBytes } }).memory;
  return { memory, messages: [{ role: "system", content: longAnswerInstruction + " Search matches literal phrases. Short names or distinctive phrases can find originals. Use zoom to inspect summary ranges.\nHISTORICAL_DATA:\n" + memory }, { role: "user", content: question.question }] };
}
type RequestReceipt = { messages: Messages; tools: unknown[]; outputTokens: number; inputTokens: number; requestHash: string; providerInputTokens?: number | null };
export async function answerExpandedQuestion(backend: Backend, prepared: PreparedLongCase, question: { id: string; category: string; question: string }, options: { countRequestTokens: RequestTokenCounter; maxSteps?: number }) {
  const maxSteps = options.maxSteps ?? expandedMemoryProtocol.maxAnswerSteps;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 12) throw new EvalFailure("INVALID_ANSWER_STEPS");
  const { messages, memory } = expandedInitialMessages(prepared, question), retrieval = new (await import("../src/core/retrieval.ts")).Retrieval(prepared.engine), receipts: Receipt[] = [], pages = new Map<string, Map<number, { text: string; next: number | null }>>();
  const requestReceipts: RequestReceipt[] = [], available = expandedMemoryProtocol.contextTokens - expandedMemoryProtocol.outputTokens - expandedMemoryProtocol.safetyTokens;
  const count = async (candidate: Messages, tools: unknown[]) => { const tokens = await options.countRequestTokens(candidate, tools, expandedMemoryProtocol.outputTokens); if (!Number.isSafeInteger(tokens) || tokens < 0) throw new EvalFailure("INVALID_TOKEN_COUNT"); return tokens; };
  const toolCounts = { search: 0, source: 0, zoom: 0, errors: 0 }, started = Date.now();
  let finalText = "", failure: string | null = null, steps = 0, finalizationCalls = 0, responseBytes = 0, submittedMessages: Messages = [];
  const complete = async (tools: unknown[], stage: string) => {
    const inputTokens = await count(messages, tools); if (inputTokens > available) throw new EvalFailure("ANSWER_CONTEXT_BUDGET");
    submittedMessages = structuredClone(messages);
    const request = { messages: submittedMessages, tools: structuredClone(tools), outputTokens: expandedMemoryProtocol.outputTokens, inputTokens };
    const receipt: RequestReceipt = { ...request, requestHash: hash(JSON.stringify(request)) }; requestReceipts.push(receipt); steps++;
    const result = await backend.complete(messages, tools, stage, expandedMemoryProtocol.outputTokens); receipt.providerInputTokens = result.inputTokens;
    if (result.inputTokens === null) throw new EvalFailure("TOKENIZER_COUNT_MISSING");
    if (result.inputTokens !== inputTokens) throw new EvalFailure("TOKENIZER_COUNT_MISMATCH");
    return result;
  };
  const toolFits = async (id: string, value: unknown) => await count([...messages, { role: "tool", tool_call_id: id, content: JSON.stringify(value) }], longTools) <= available - 256;
  try {
    for (let round = 0; round < maxSteps; round++) {
      const result = await complete(longTools, `answer:optchat:${question.id}`); messages.push(result.message);
      if (!result.message.tool_calls?.length) { finalText = result.message.content ?? ""; break; }
      for (const call of result.message.tool_calls) {
        let value: any;
        try {
          const input = JSON.parse(call.function.arguments);
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new EvalFailure("INVALID_TOOL_INPUT");
          if (call.function.name === "optchat_search") {
            toolCounts.search++; if (typeof input.query !== "string") throw new EvalFailure("INVALID_TOOL_INPUT");
            let limit = input.limit ?? 12; value = retrieval.search(prepared.snapshot, input.query, input.offset ?? 0, limit);
            while (!await toolFits(call.id, value) && limit > 1) { limit--; value = retrieval.search(prepared.snapshot, input.query, input.offset ?? 0, limit); }
          } else if (call.function.name === "optchat_zoom") {
            toolCounts.zoom++; if (typeof input.id !== "string") throw new EvalFailure("INVALID_TOOL_INPUT");
            let limit = input.limit ?? 16; value = retrieval.zoom(prepared.snapshot, input.id, input.offset ?? 0, limit);
            while (!await toolFits(call.id, value) && limit > 1) { limit--; value = retrieval.zoom(prepared.snapshot, input.id, input.offset ?? 0, limit); }
          } else if (call.function.name === "optchat_source") {
            toolCounts.source++; if (typeof input.id !== "string") throw new EvalFailure("INVALID_TOOL_INPUT");
            const offset = input.offset ?? 0; let limit = input.maxBytes ?? 8192;
            if (!Number.isSafeInteger(limit) || limit < 4 || limit > 32768) throw new EvalFailure("INVALID_PAGE");
            value = retrieval.source(prepared.snapshot, input.id, offset, limit);
            while (!await toolFits(call.id, value) && limit > 4) { limit = Math.max(4, Math.floor(limit / 2)); value = retrieval.source(prepared.snapshot, input.id, offset, limit); }
            if (!await toolFits(call.id, value)) throw new EvalFailure("TOOL_CONTEXT_BUDGET");
            const original = prepared.engine.source(input.id), received = pages.get(value.sourceId) ?? new Map<number, { text: string; next: number | null }>(); received.set(offset, { text: value.text, next: value.next }); pages.set(value.sourceId, received);
            let cursor: number | null = 0, combined = ""; const visited = new Set<number>();
            while (cursor !== null && received.has(cursor) && !visited.has(cursor)) { visited.add(cursor); const page: { text: string; next: number | null } = received.get(cursor)!; combined += page.text; cursor = page.next; }
            receipts.push({ sourceId: value.sourceId, payloadHash: original.payloadHash, returnedHash: hash(combined), bytes: bytes(combined), complete: cursor === null, exact: cursor === null && combined === original.payload });
          } else throw new EvalFailure("UNKNOWN_TOOL");
          if (!await toolFits(call.id, value)) throw new EvalFailure("TOOL_CONTEXT_BUDGET");
        } catch (error) { failFatal(error); toolCounts.errors++; value = { error: safeCode(error) }; }
        if (!await toolFits(call.id, value)) throw new EvalFailure("TOOL_CONTEXT_BUDGET");
        const content = JSON.stringify(value); responseBytes += bytes(content); messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }
    if (!finalText) {
      finalizationCalls++; messages.push({ role: "user", content: "Answer the question now from the evidence already delivered. State any uncertainty. Cite original sourceId values. No further retrieval is available." });
      const result = await complete([], `answer:optchat:${question.id}:final`); messages.push(result.message);
      if (result.message.tool_calls?.length) throw new EvalFailure("FINALIZATION_TOOL_CALL"); finalText = result.message.content ?? "";
    }
    if (!finalText.trim()) failure = "EMPTY_ANSWER";
  } catch (error) { failFatal(error); failure = safeCode(error); }
  const exactSources = [...new Set(receipts.filter(receipt => receipt.complete && receipt.exact && receipt.payloadHash === receipt.returnedHash).map(receipt => receipt.sourceId))], citations = prepared.sources.map(sourceKey).filter(id => finalText.includes(id));
  const answer = { public: { questionId: question.id, questionHash: hash(question.question), category: question.category, arm: "optchat" as const, failure, steps, finalizationCalls, latencyMs: Date.now() - started, contextBytes: bytes(memory), toolResponseBytes: responseBytes, toolCounts, exactSourceReceipts: exactSources.length, citedOriginalCount: citations.length, maxRequestTokenBound: Math.max(0, ...requestReceipts.map(receipt => receipt.inputTokens)), caseHash: prepared.metrics.caseHash, protocolHash: hash(JSON.stringify(expandedMemoryProtocol)) }, private: { finalText, messages, submittedMessages, receipts, exactSources, citations, requestTokenBounds: requestReceipts.map(receipt => receipt.inputTokens), requestReceipts } };
  const evidence = optionalDeliveredEvidence(answer, prepared as Parameters<typeof optionalDeliveredEvidence>[1], submittedMessages);
  return { public: answer.public, private: { ...answer.private, deliveredEvidence: evidence } };
}

export function correctnessInputHash(question: BeamGradeQuestion, candidate: string) {
  const input = { question: question.question, category: question.category, referenceAnswer: question.referenceAnswer, nativeRubric: question.rubric, ...(question.nativeAuthorReference !== undefined ? { nativeAuthorReference: question.nativeAuthorReference } : {}), ...(question.idealSummary !== undefined ? { authoredIdealSummary: question.idealSummary } : {}), candidate };
  return hash(JSON.stringify([{ role: "system", content: beamGraderInstruction }, { role: "user", content: JSON.stringify(input) }]));
}
function verifyGrade(grade: BeamGradeResult, expected: string) {
  const verdict = grade.private.verdict, valid = Number(verdict !== null), parsed = parseBeamVerdict(grade.private.output);
  if (grade.private.inputHash !== expected || hash(JSON.stringify(grade.private.messages)) !== expected || grade.private.outputHash !== hash(grade.private.output) || grade.public.groundingRequested !== 0 || grade.public.grounded !== null || grade.public.valid !== valid || grade.public.correct !== (verdict ? Number(verdict.correct) : null) || grade.public.confidenceHigh !== (verdict ? Number(verdict.confidence === "high") : null) || verdict && (verdict.grounded !== null || grade.private.failure !== null || JSON.stringify(parsed) !== JSON.stringify(verdict)) || !verdict && !grade.private.failure) throw new EvalFailure("EXPANDED_GRADING_INPUT_MISMATCH");
}
export function verifyExpandedCalibration(root: string, questions: BeamGradeQuestion[], baselineIdentityHash: string) {
  const path = resolve(root, "baseline-calibration.json"), saved = load<{ public: BeamCalibrationPublic; private: { baselineIdentityHash: string; callStart: number; callEnd: number } }>(path), selected = createBeamCalibrationControls(questions);
  if (saved.private.baselineIdentityHash !== baselineIdentityHash) throw new EvalFailure("EXPANDED_CALIBRATION_MISMATCH");
  const controlHashes: Record<string, string> = {}, results: { kind: string; result: BeamGradeResult }[] = [];
  for (const control of selected.controls) {
    const name = hash(control.id), controlPath = resolve(root, "baseline-calibration-controls", `${name}.json`), cached = load<{ baselineIdentityHash: string; result: BeamGradeResult }>(controlPath);
    if (cached.baselineIdentityHash !== baselineIdentityHash) throw new EvalFailure("EXPANDED_CALIBRATION_MISMATCH");
    verifyGrade(cached.result, correctnessInputHash(control.question, control.candidate)); controlHashes[name] = fileHash(controlPath); results.push({ kind: control.kind, result: cached.result });
  }
  const positivesAccepted = results.filter(row => row.kind === "positive" && row.result.private.verdict?.correct === true).length, negativesRejected = results.filter(row => row.kind === "negative" && row.result.private.verdict?.correct === false).length, invalidCount = results.filter(row => row.result.public.valid !== 1).length, lowConfidenceCount = results.filter(row => row.result.private.verdict?.confidence === "low").length;
  const expected = { ...selected.public, accepted: Number(selected.public.positiveCount > 0 && positivesAccepted === selected.public.positiveCount && negativesRejected === selected.public.negativeCount && invalidCount === 0), positivesAccepted, negativesRejected, invalidCount, lowConfidenceCount };
  if (JSON.stringify(saved.public) !== JSON.stringify(expected)) throw new EvalFailure("EXPANDED_CALIBRATION_MISMATCH");
  requireBeamCalibration(saved.public);
  return { public: saved.public, aggregateHash: fileHash(path), controlHashes, callStart: saved.private.callStart, callEnd: saved.private.callEnd };
}

export function validateExpandedBaselines(root: string, data: NormalizedLongCase, baselineIdentityHash: string) {
  return data.questions.flatMap(question => ["boros", "recent"].map(arm => {
    const name = `${arm}-${hash(question.id).slice(0, 16)}`, path = resolve(root, "baseline-answers", `${name}.json`), answer = load<ComparisonAnswer>(path);
    if (answer.private.baselineIdentityHash !== baselineIdentityHash || fatalCodes.has(answer.public.failure) || answer.public.questionId !== question.id || answer.public.category !== question.category || answer.public.arm !== arm || typeof answer.private.finalText !== "string" || !Array.isArray(answer.private.messages)) throw new EvalFailure("BASELINE_ANSWER_MISMATCH");
    if (arm === "boros") {
      const context = load<{ envelope: BorosEnvelope }>(resolve(root, "boros-contexts", hash(question.id).slice(0, 16), "accepted.json")), native = context.envelope.attempts.find(attempt => attempt.arm === "ordinary_send")!;
      const evidence = native.sources!.map(source => ({ sourceId: source.event_id, text: source.text, complete: source.offset === 0 && source.bytes === source.source_bytes }));
      if (answer.public.submittedMessagesHash !== hash(JSON.stringify(native.messages)) || answer.public.nativePreparedBodyHash !== native.body_sha256 || answer.public.selectionHash !== native.selection_sha256 || JSON.stringify(answer.private.messages) !== JSON.stringify(native.messages) || JSON.stringify(answer.private.deliveredEvidence) !== JSON.stringify(evidence)) throw new EvalFailure("BASELINE_ANSWER_MISMATCH");
    } else {
      const sources = recentRecords(fullNormalizedSources(data), 16000), memory = JSON.stringify(sources.map(source => ({ sourceId: sourceKey(source), role: source.kind, text: source.payload })));
      const expected = [{ role: "system", content: longAnswerInstruction + " Complete recent originals follow in author order.\nHISTORICAL_DATA:\n" + memory }, { role: "user", content: question.question }], messages = answer.private.messages as Messages;
      if (JSON.stringify(messages.slice(0, 2)) !== JSON.stringify(expected) || JSON.stringify(answer.private.deliveredEvidence) !== JSON.stringify(sources.map(source => ({ sourceId: sourceKey(source), text: source.payload, complete: true }))) || messages.length < 2 || messages.length > 3 || messages.length === 3 && (messages[2]!.role !== "assistant" || messages[2]!.content !== answer.private.finalText)) throw new EvalFailure("BASELINE_ANSWER_MISMATCH");
    }
    if (Object.entries(sourceCoverage(question, answer, data)).some(([field, value]) => answer.public[field] !== value)) throw new EvalFailure("BASELINE_ANSWER_MISMATCH");
    return { question, arm, answer, name, fileHash: fileHash(path) };
  }));
}

function copyLineage(root: string) {
  const marker = load<{ sourceRunDirectory: string; sourceDatabaseHash: string; sourceBackendStateHash: string; inheritedCalls: number; originalStartedAt: number; effectiveDeadlineMs: number; maxCalls: number }>(resolve(root, "expanded-memory-copy.json")), sourceRoot = realpathSync(marker.sourceRunDirectory), localRoot = realpathSync(root);
  if (sourceRoot === localRoot) throw new EvalFailure("PRIVATE_COPY_REQUIRED");
  const sourceDatabase = resolve(sourceRoot, "memory.sqlite"), database = resolve(root, "memory.sqlite"), sourceStatePath = resolve(sourceRoot, "backend-state.json");
  if (new Bun.CryptoHasher("sha256").update(readFileSync(sourceDatabase)).digest("hex") !== marker.sourceDatabaseHash || fileHash(sourceStatePath) !== marker.sourceBackendStateHash) throw new EvalFailure("EXPANDED_COPY_MISMATCH");
  if (statSync(sourceDatabase).dev === statSync(database).dev && statSync(sourceDatabase).ino === statSync(database).ino) throw new EvalFailure("PRIVATE_COPY_REQUIRED");
  const state = load<{ calls: number; startedAt: number }>(sourceStatePath), copied = load<{ calls: number; startedAt: number }>(resolve(root, "backend-state.json"));
  if (!Number.isSafeInteger(state.calls) || state.calls < 0 || !Number.isFinite(state.startedAt) || copied.startedAt !== state.startedAt || copied.calls < state.calls || marker.inheritedCalls !== state.calls || marker.originalStartedAt !== state.startedAt || marker.maxCalls !== expandedMemoryProtocol.maxCalls || !Number.isFinite(marker.effectiveDeadlineMs) || marker.effectiveDeadlineMs <= state.startedAt) throw new EvalFailure("SOURCE_COUNTER_LINEAGE_MISMATCH");
  return { inheritedCalls: state.calls, startedAt: state.startedAt, effectiveDeadlineMs: marker.effectiveDeadlineMs, sourceBackendStateHash: marker.sourceBackendStateHash, sourceDatabaseHash: marker.sourceDatabaseHash, sourceDirectoryHash: hash(sourceRoot) };
}
function summarize(rows: Record<string, any>[], accepted: boolean) { const sorted = rows.map(row => row.latencyMs).sort((a, b) => a - b); return { questions: rows.length, correct: accepted ? rows.filter(row => row.valid === 1 && row.correct === 1 && !row.failure).length : null, grounded: null, failures: rows.filter(row => row.failure).length, invalidGrades: rows.filter(row => row.valid !== 1).length, lowConfidence: rows.filter(row => row.confidenceHigh === 0).length, medianLatencyMs: sorted[Math.floor(sorted.length / 2)] ?? null, answerCalls: rows.reduce((sum, row) => sum + (row.answerCalls ?? 0), 0), gradingCalls: rows.reduce((sum, row) => sum + row.gradingCalls, 0), answerInputTokens: rows.reduce((sum, row) => sum + (row.answerUsage?.inputTokens ?? 0), 0), answerOutputTokens: rows.reduce((sum, row) => sum + (row.answerUsage?.outputTokens ?? 0), 0), gradingInputTokens: rows.reduce((sum, row) => sum + row.gradingUsage.inputTokens, 0), gradingOutputTokens: rows.reduce((sum, row) => sum + row.gradingUsage.outputTokens, 0), resolvableGoldSources: rows.reduce((sum, row) => sum + row.resolvableGoldSources, 0), deliveredGoldSources: rows.reduce((sum, row) => sum + row.deliveredGoldSources, 0), fullyDeliveredGoldSources: rows.reduce((sum, row) => sum + row.fullyDeliveredGoldSources, 0) }; }
type RunOptions = { countRequestTokens: RequestTokenCounter; tokenizerIdentity: unknown; backend?: CountedBackend; onProgress?: (metadata: Record<string, unknown>) => void };
export async function runExpandedComparison(args: string[], options: RunOptions): Promise<Record<string, any>> {
  const flags = new Map<string, string>(); for (let index = 0; index < args.length; index += 2) { if (!["--case", "--run", "--supplement", "--mode"].includes(args[index]!) || !args[index + 1]) throw new EvalFailure("INVALID_CLI"); flags.set(args[index]!, args[index + 1]!); }
  const casePath = flags.get("--case"), run = flags.get("--run"), supplementPath = flags.get("--supplement"), mode = flags.get("--mode");
  if (!casePath || !run || !supplementPath || !["audit", "answers", "grade"].includes(mode ?? "") || !options.countRequestTokens || !options.tokenizerIdentity) throw new EvalFailure("EXPLICIT_EXPANDED_CONFIG_REQUIRED");
  const baseline = freezeBaseline(casePath, run, supplementPath), { data, root, supplement } = baseline, lineage = copyLineage(root), baselines = validateExpandedBaselines(root, data, baseline.identityHash);
  const questions = data.questions.map(question => ({ ...question, nativeAuthorReference: supplement.questions[question.id] })), calibration = verifyExpandedCalibration(root, questions, baseline.identityHash);
  const store = new Store(resolve(root, "memory.sqlite"));
  try {
    const { prepared, audit } = reconstructExpandedPreparation(store, data), freezePath = resolve(root, "expanded-comparison-freeze.json"), prior = existsSync(freezePath) ? load<Record<string, any>>(freezePath) : null;
    const deadlineAt = lineage.effectiveDeadlineMs;
    const dependencies = ["scripts/long-history-eval.ts", "scripts/local-memory-eval.ts", "scripts/optional-parent-preparation.ts", "scripts/optional-parent-comparison.ts", "scripts/beam-baseline-only.ts", "scripts/compare-long-history.ts", "scripts/boros-context-driver.ts", "scripts/beam-grader.ts", "src/core/engine.ts", "src/storage/store.ts", "src/core/context.ts", "src/core/retrieval.ts", "src/core/views.ts", "src/core/tree.ts", "src/core/types.ts", "src/compactor/summarizer.ts"];
    const freeze = { protocol: expandedMemoryProtocol, protocolHash: hash(JSON.stringify(expandedMemoryProtocol)), sourceHash: fileHash(import.meta.path), dependencyHashes: Object.fromEntries(dependencies.map(path => [path, fileHash(resolve(import.meta.dir, "..", path))])), tokenizerIdentity: options.tokenizerIdentity, tokenizerIdentityHash: hash(JSON.stringify(options.tokenizerIdentity)), caseFileHash: baseline.freeze.caseFileHash, caseHash: prepared.metrics.caseHash, referenceHash: prepared.metrics.referenceHash, supplementHash: baseline.freeze.supplementHash, baselineIdentityHash: baseline.identityHash, contextHashes: baseline.freeze.contextHashes, baselineAnswerHashes: Object.fromEntries(baselines.map(row => [row.name, row.fileHash])), calibration: { aggregateHash: calibration.aggregateHash, controlHashes: calibration.controlHashes, protocolHash: hash(JSON.stringify(beamGradingProtocol)) }, graph: audit, lineage, resources: { maxCalls: expandedMemoryProtocol.maxCalls, originalStartedAt: lineage.startedAt, deadlineAt, maxMinutes: (deadlineAt - lineage.startedAt) / 60000, additionalMinutes: expandedMemoryProtocol.additionalMinutes } };
    if (prior) { if (JSON.stringify(prior) !== JSON.stringify(freeze)) throw new EvalFailure("EXPANDED_FREEZE_MISMATCH"); } else save(freezePath, freeze);
    const identityHash = hash(JSON.stringify(freeze));
    for (const row of baselines) ledger(root, "expanded-baseline-ledger", row.name, { identityHash, questionId: row.question.id, category: row.question.category, arm: row.arm, caseHash: prepared.metrics.caseHash, fileHash: row.fileHash, contentHash: hash(JSON.stringify(row.answer.private)) });
    if (mode === "audit") return { phase: "audited", originalCount: audit.originalCount, publications: audit.publications, projectionBytes: audit.projectionBytes, optionalFailures: audit.optionalFailures, mandatoryFailures: 0, inheritedCalls: lineage.inheritedCalls, compactionCalls: 0, identityHash };
    const backend = options.backend ?? new ResumableLocalBackend({ url: "http://127.0.0.1:11234/v1/chat/completions", model: QWEN_MODEL, provider: "mlx", directory: root, maxCalls: freeze.resources.maxCalls, maxMinutes: freeze.resources.maxMinutes });
    if (backend.startedAt !== undefined && backend.startedAt !== lineage.startedAt || calls(backend) < lineage.inheritedCalls) throw new EvalFailure("SOURCE_COUNTER_LINEAGE_MISMATCH");
    const progress = options.onProgress ?? (details => console.log(JSON.stringify(details))), answers: ComparisonAnswer[] = [];
    const readAnswer = (question: NormalizedLongCase["questions"][number]) => {
      const name = `optchat-${hash(question.id).slice(0, 16)}`, path = resolve(root, "expanded-answers", `${name}.json`), answer = load<ComparisonAnswer>(path), initial = expandedInitialMessages(prepared, question).messages;
      if (answer.private.expandedIdentityHash !== identityHash || answer.public.questionId !== question.id || answer.public.category !== question.category || answer.public.arm !== "optchat" || answer.public.questionHash !== hash(question.question) || answer.public.caseHash !== prepared.metrics.caseHash || answer.public.protocolHash !== freeze.protocolHash || fatalCodes.has(answer.public.failure) || typeof answer.private.finalText !== "string" || !Array.isArray(answer.private.messages) || JSON.stringify((answer.private.messages as Messages).slice(0, 2)) !== JSON.stringify(initial)) throw new EvalFailure("EXPANDED_ANSWER_MISMATCH");
      const receipts = answer.private.requestReceipts as RequestReceipt[], submitted = answer.private.submittedMessages as Messages;
      const messages = answer.private.messages as Messages;
      if (!Array.isArray(receipts) || !Array.isArray(submitted) || receipts.length !== answer.public.steps || answer.public.maxRequestTokenBound !== Math.max(0, ...receipts.map(receipt => receipt.inputTokens)) || JSON.stringify(submitted) !== JSON.stringify(receipts.at(-1)?.messages ?? []) || receipts.some((receipt, index) => !Number.isSafeInteger(receipt.inputTokens) || receipt.inputTokens < 0 || receipt.inputTokens > expandedMemoryProtocol.contextTokens - expandedMemoryProtocol.outputTokens - expandedMemoryProtocol.safetyTokens || receipt.outputTokens !== expandedMemoryProtocol.outputTokens || receipt.requestHash !== hash(JSON.stringify({ messages: receipt.messages, tools: receipt.tools, outputTokens: receipt.outputTokens, inputTokens: receipt.inputTokens })) || JSON.stringify(receipt.messages) !== JSON.stringify(messages.slice(0, receipt.messages.length)) || JSON.stringify(receipt.messages.slice(0, 2)) !== JSON.stringify(initial) || JSON.stringify(receipt.tools) !== JSON.stringify(longTools) && !(index === receipts.length - 1 && answer.public.finalizationCalls === 1 && receipt.tools.length === 0) || !answer.public.failure && receipt.providerInputTokens !== receipt.inputTokens)) throw new EvalFailure("EXPANDED_REQUEST_MISMATCH");
      if (answer.private.finalText && (messages.at(-1)?.role !== "assistant" || messages.at(-1)?.content !== answer.private.finalText)) throw new EvalFailure("EXPANDED_ANSWER_MISMATCH");
      const evidence = optionalDeliveredEvidence(answer as any, prepared as Parameters<typeof optionalDeliveredEvidence>[1], submitted);
      if (JSON.stringify(evidence) !== JSON.stringify(answer.private.deliveredEvidence) || Object.entries(sourceCoverage(question, answer, data)).some(([field, value]) => answer.public[field] !== value)) throw new EvalFailure("EXPANDED_ANSWER_MISMATCH");
      ledger(root, "expanded-answer-ledger", name, { identityHash, questionId: question.id, category: question.category, arm: "optchat", fileHash: fileHash(path), contentHash: hash(JSON.stringify(answer.private)) }); return answer;
    };
    for (const question of data.questions) {
      const name = `optchat-${hash(question.id).slice(0, 16)}`, path = resolve(root, "expanded-answers", `${name}.json`);
      if (!existsSync(path)) {
        if (mode !== "answers") throw new EvalFailure("EXPANDED_ANSWERS_NOT_COMPLETE");
        const startCalls = calls(backend), startMetrics = backend.metrics?.length ?? 0, answer = await answerExpandedQuestion(backend, prepared, question, { countRequestTokens: options.countRequestTokens });
        Object.assign(answer.public, sourceCoverage(question, answer, data), { answerCalls: calls(backend) - startCalls, answerUsage: usageSince(backend, startMetrics), originalHistoryCount: data.messages.length });
        Object.assign(answer.private, { expandedIdentityHash: identityHash }); save(path, answer);
      }
      answers.push(readAnswer(question)); progress({ phase: "expanded-answer", completed: answers.length, total: data.questions.length, failures: Number(!!answers.at(-1)!.public.failure), cumulativeCalls: calls(backend) });
    }
    if (mode === "answers") return { phase: "answers-complete", answerCells: answers.length + baselines.length, optchatCells: answers.length, cumulativeCalls: calls(backend), identityHash };
    const rows: Record<string, any>[] = [];
    for (let index = 0; index < questions.length; index++) {
      const question = questions[index]!, candidates = [{ arm: "optchat", answer: answers[index]! }, ...baselines.filter(row => row.question.id === question.id)];
      for (const { arm, answer } of candidates) {
        const name = `${arm}-${hash(question.id).slice(0, 16)}`, path = resolve(root, "expanded-grades", `${name}.json`), inputHash = correctnessInputHash(question, answer.private.finalText), binding = { identityHash, questionId: question.id, category: question.category, arm, answerHash: hash(answer.private.finalText), inputHash };
        let saved: { binding: typeof binding; grade: BeamGradeResult; gradingCalls: number; gradingUsage: ReturnType<typeof usageSince>; tokenReceipt: { inputTokens: number; providerInputTokens?: number | null; outputTokens: number; requestHash: string } | null };
        if (existsSync(path)) { saved = load(path); if (JSON.stringify(saved.binding) !== JSON.stringify(binding)) throw new EvalFailure("EXPANDED_GRADE_MISMATCH"); }
        else {
          const before = calls(backend), metric = backend.metrics?.length ?? 0; let tokenReceipt: typeof saved.tokenReceipt = null;
          const verified: Backend = { async complete(messages, tools, stage, outputTokens) {
            const inputTokens = await options.countRequestTokens(messages, tools, outputTokens);
            if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new EvalFailure("INVALID_TOKEN_COUNT");
            tokenReceipt = { inputTokens, outputTokens, requestHash: hash(JSON.stringify({ messages, tools, outputTokens })) };
            if (inputTokens > Math.min(beamGradingProtocol.graderContextTokens, expandedMemoryProtocol.gradingActualContextTokens) - outputTokens - beamGradingProtocol.safetyTokens) throw new EvalFailure("GRADER_CONTEXT_BUDGET");
            const result = await backend.complete(messages, tools, stage, outputTokens); tokenReceipt.providerInputTokens = result.inputTokens;
            if (result.inputTokens === null) throw new EvalFailure("TOKENIZER_COUNT_MISSING");
            if (result.inputTokens !== inputTokens) throw new EvalFailure("TOKENIZER_COUNT_MISMATCH"); return result;
          } };
          const grade = await gradeBeamCandidate(verified, question, answer.private.finalText, { calibration: calibration.public }); saved = { binding, grade, gradingCalls: calls(backend) - before, gradingUsage: usageSince(backend, metric), tokenReceipt }; verifyGrade(grade, inputHash); save(path, saved);
        }
        verifyGrade(saved.grade, inputHash);
        if (saved.grade.public.valid && (!saved.tokenReceipt || !Number.isSafeInteger(saved.tokenReceipt.inputTokens) || saved.tokenReceipt.inputTokens < 0 || saved.tokenReceipt.requestHash !== hash(JSON.stringify({ messages: saved.grade.private.messages, tools: [], outputTokens: beamGradingProtocol.gradingTokens })) || saved.tokenReceipt.outputTokens !== beamGradingProtocol.gradingTokens || saved.tokenReceipt.inputTokens !== saved.tokenReceipt.providerInputTokens || saved.tokenReceipt.inputTokens > Math.min(beamGradingProtocol.graderContextTokens, expandedMemoryProtocol.gradingActualContextTokens) - beamGradingProtocol.gradingTokens - beamGradingProtocol.safetyTokens)) throw new EvalFailure("EXPANDED_GRADE_TOKEN_MISMATCH");
        ledger(root, "expanded-grade-ledger", name, { ...binding, fileHash: fileHash(path) });
        rows.push({ ...answer.public, ...saved.grade.public, gradingCalls: saved.gradingCalls, gradingUsage: saved.gradingUsage, answerHash: binding.answerHash }); progress({ phase: "expanded-grade", completed: rows.length, total: questions.length * 3, valid: saved.grade.public.valid, cumulativeCalls: calls(backend) });
      }
    }
    const qualityComparisonAccepted = calibration.public.accepted === 1 && rows.length === questions.length * 3 && rows.every(row => row.valid === 1 && row.acceptedScore === 1 && !/^(?:TOKENIZER_|INVALID_TOKEN_COUNT|SOURCE_)/.test(row.failure ?? ""));
    const arms = Object.fromEntries(expandedMemoryProtocol.arms.map(arm => [arm, summarize(rows.filter(row => row.arm === arm), qualityComparisonAccepted)])), categories = Object.fromEntries([...new Set(data.questions.map(question => question.category))].map(category => [category, Object.fromEntries(expandedMemoryProtocol.arms.map(arm => [arm, summarize(rows.filter(row => row.arm === arm && row.category === category), qualityComparisonAccepted)]))]));
    const paired = { bothCorrect: 0, optchatOnly: 0, borosOnly: 0, neitherCorrect: 0, excludedInvalidOrFailure: 0 };
    for (const question of data.questions) { const opt = rows.find(row => row.arm === "optchat" && row.questionId === question.id)!, boros = rows.find(row => row.arm === "boros" && row.questionId === question.id)!; if (opt.valid !== 1 || boros.valid !== 1 || opt.failure || boros.failure) paired.excludedInvalidOrFailure++; else if (opt.correct && boros.correct) paired.bothCorrect++; else if (opt.correct) paired.optchatOnly++; else if (boros.correct) paired.borosOnly++; else paired.neitherCorrect++; }
    const result = { version: expandedMemoryProtocol.version, expandedIdentityHash: identityHash, qualityComparisonAccepted, gradingPolicy: "correctness-only", groundedScores: null, calibration: calibration.public, preparation: audit, strictPreparationAbort: optPreparationFailure, continuation: { fullOriginals: audit.originalCount, publications: audit.publications, retainedOptionalFailures: audit.optionalFailures, compactionCalls: 0 }, arms, categories, paired: qualityComparisonAccepted ? paired : null, rows: qualityComparisonAccepted ? rows : rows.map(row => ({ ...row, correct: null, acceptedScore: 0 })), individualGradeDiagnostics: qualityComparisonAccepted ? [] : rows.map(row => ({ questionHash: hash(row.questionId), arm: row.arm, valid: row.valid, correctnessVerdict: row.correct, confidenceHigh: row.confidenceHigh })), lineage: { inheritedInitialCalls: lineage.inheritedCalls, cumulativeCalls: calls(backend), newCallsSinceCopy: calls(backend) - lineage.inheritedCalls, inheritedCountedOnce: true }, resources: freeze.resources };
    const resultPath = resolve(root, "public-result-expanded-comparison.json"); if (existsSync(resultPath)) { const priorResult = load<Record<string, any>>(resultPath); if (JSON.stringify(priorResult) !== JSON.stringify(result)) throw new EvalFailure("EXPANDED_RESULT_MISMATCH"); return priorResult; } save(resultPath, result); return result;
  } finally { store.close(); }
}

export async function runExpandedCLI(args: string[]) {
  const index = args.indexOf("--run"), root = index < 0 ? undefined : args[index + 1];
  if (!root) throw new EvalFailure("EXPLICIT_EXPANDED_CONFIG_REQUIRED");
  const { createQwenRequestTokenizer } = await import("./qwen-request-tokenizer.ts");
  const tokenizer = await createQwenRequestTokenizer({ directory: resolve(root) });
  const result = await runExpandedComparison(args, { countRequestTokens: tokenizer.countRequestTokens, tokenizerIdentity: tokenizer.identity });
  console.log(JSON.stringify({ phase: result.phase ?? "graded", originalCount: result.originalCount ?? result.preparation?.originalCount, publications: result.publications ?? result.preparation?.publications, answerCells: result.answerCells, cumulativeCalls: result.cumulativeCalls ?? result.lineage?.cumulativeCalls, qualityComparisonAccepted: result.qualityComparisonAccepted, identityHash: result.identityHash ?? result.expandedIdentityHash }));
}
if (import.meta.main) runExpandedCLI(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ error: safeCode(error) })); process.exitCode = 1; });

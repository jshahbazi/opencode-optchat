import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytes, hash, sourceKey, type SourceRecord } from "../src/index.ts";
import { conservativeTokens } from "../src/core/context.ts";
import { EvalFailure, recentRecords, type Backend } from "./local-memory-eval.ts";
import { longAnswerInstruction, longCaseHashes, ResumableLocalBackend, type NormalizedLongCase } from "./long-history-eval.ts";
import { answerBoros, nativeBorosInput, sourceCoverage, type ComparisonAnswer } from "./compare-long-history.ts";
import { QWEN_MODEL, BOROS_REVISION, verifyBorosEnvelope, type BorosInput, type BorosEnvelope } from "./boros-context-driver.ts";
import { beamGradingProtocol, createBeamCalibrationControls, gradeBeamCandidate, requireBeamCalibration, type BeamCalibrationPublic, type BeamGradeQuestion, type BeamGradeResult } from "./beam-grader.ts";

export const optPreparationFailure = { status: "strictPreparationAborted", scope: "strict-evaluation-preparation", failedJob: "optional-shared-parent", parentStart: 40, parentCount: 8, acceptedSize: 1024, ingested: 96, expected: 796, pubs: 48, calls: 282, code: "SUMMARY_SIZE" } as const;
export const baselineProtocol = {
  version: "beam-baseline-only-1", arms: ["boros", "recent"], originalHistory: "complete-normalized-history",
  questionOrder: "native", armOrder: "alternate-per-question", recentBytes: 16000, answerTokens: 2048,
  answerContextTokens: 32768, answerSafetyTokens: 1024, temperature: 0, thinking: false, parallelCalls: false,
  borosRevision: BOROS_REVISION, model: QWEN_MODEL, endpoint: "http://127.0.0.1:11234/v1/chat/completions",
  gradingAfterAllAnswers: true, gradingProtocol: beamGradingProtocol, optchatQualityScores: "unavailable-after-strict-preparation-abort",
  optPreparationFailure,
} as const;
type Arm = "boros" | "recent";
type CountedBackend = Backend & { readonly calls?: number; readonly startedAt?: number; readonly metrics?: { stage: string; latencyMs: number; inputTokens: number | null; outputTokens: number | null; success: boolean }[] };
type Supplement = { sourceProbeSHA256: string; normalizedCaseSHA256: string; questionCount: number; questions: Record<string, unknown> };
const fatalCodes = new Set(["CALL_LIMIT", "RUN_DEADLINE", "CONCURRENT_EVALUATION"]);
const errorCode = (error: unknown) => { const value = (error as { code?: unknown })?.code; return typeof value === "string" && /^[A-Z_0-9]+$/.test(value) ? value : "BASELINE_FAILURE"; };
function privateDirectory(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
function save(path: string, value: unknown) { privateDirectory(resolve(path, "..")); writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
function load<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T; }
const calls = (backend: CountedBackend) => backend.calls ?? backend.metrics?.length ?? 0;
function usageSince(backend: CountedBackend, index: number) {
  return (backend.metrics ?? []).slice(index).reduce((sum, metric) => ({ inputTokens: sum.inputTokens + (metric.inputTokens ?? 0), outputTokens: sum.outputTokens + (metric.outputTokens ?? 0), knownCalls: sum.knownCalls + Number(metric.inputTokens !== null && metric.outputTokens !== null) }), { inputTokens: 0, outputTokens: 0, knownCalls: 0 });
}

export function fullNormalizedSources(data: NormalizedLongCase): SourceRecord[] {
  const sessionId = `archive-${longCaseHashes(data).caseHash.slice(0, 16)}`;
  return data.messages.map(message => ({ sessionId, generation: 0, seq: message.seq, turnId: `turn-${String(Math.floor(message.seq / 2)).padStart(6, "0")}`,
    eventKey: `original-${message.seq}`, kind: message.role, timestamp: message.timeAnchor ?? "2026-10-12T00:00:00Z", payload: message.text, payloadHash: hash(message.text), projectId: "beam-public-evaluation" }));
}
export async function answerRecentFromCase(backend: Backend, data: NormalizedLongCase, question: { id: string; category: string; question: string }): Promise<ComparisonAnswer> {
  const selected = recentRecords(fullNormalizedSources(data), baselineProtocol.recentBytes);
  const memory = JSON.stringify(selected.map(source => ({ sourceId: sourceKey(source), role: source.kind, text: source.payload })));
  const messages: Parameters<Backend["complete"]>[0] = [{ role: "system", content: longAnswerInstruction + " Complete recent originals follow in author order.\nHISTORICAL_DATA:\n" + memory }, { role: "user", content: question.question }];
  const requestTokenBound = conservativeTokens({ messages, tools: [] }), started = Date.now();
  let finalText = "", failure: string | null = null, steps = 0;
  try {
    if (requestTokenBound > baselineProtocol.answerContextTokens - baselineProtocol.answerTokens - baselineProtocol.answerSafetyTokens) throw new EvalFailure("ANSWER_CONTEXT_BUDGET");
    steps = 1;
    const result = await backend.complete(messages, [], `answer:recent:${question.id}`, baselineProtocol.answerTokens);
    finalText = result.message.content ?? ""; messages.push(result.message);
    failure = result.message.tool_calls?.length ? "UNEXPECTED_TOOL_CALL" : !finalText.trim() ? "EMPTY_ANSWER" : null;
  } catch (error) {
    const code = errorCode(error); if (fatalCodes.has(code)) throw error instanceof EvalFailure ? error : new EvalFailure(code);
    failure = code;
  }
  return { public: { questionId: question.id, category: question.category, arm: "recent", failure, steps, latencyMs: Date.now() - started,
    contextBytes: bytes(memory), maxRequestTokenBound: requestTokenBound, exactSourceReceipts: selected.length,
    originalHistoryCount: data.messages.length, selectedOriginalCount: selected.length, selectedFirstSeq: selected[0]?.seq ?? null, selectedLastSeq: selected.at(-1)?.seq ?? null },
    private: { finalText, messages, deliveredEvidence: selected.map(source => ({ sourceId: sourceKey(source), text: source.payload, complete: true })) } };
}
export function validateNativeSupplement(supplement: Supplement, data: NormalizedLongCase, caseFileHash: string) {
  if (supplement.sourceProbeSHA256 !== data.source.rawProbeHash || supplement.normalizedCaseSHA256 !== caseFileHash || supplement.questionCount !== data.questions.length ||
      !supplement.questions || Object.keys(supplement.questions).length !== data.questions.length || data.questions.some(question => !supplement.questions[question.id] || typeof supplement.questions[question.id] !== "object")) throw new EvalFailure("NATIVE_REFERENCE_MISMATCH");
}
export function freezeBaseline(casePath: string, run: string, supplementPath: string) {
  const caseBytes = readFileSync(resolve(casePath), "utf8"), data = JSON.parse(caseBytes) as NormalizedLongCase, root = resolve(run);
  const supplementBytes = readFileSync(resolve(supplementPath), "utf8"), supplement = JSON.parse(supplementBytes) as Supplement;
  validateNativeSupplement(supplement, data, hash(caseBytes));
  const contextHashes = Object.fromEntries(data.questions.map(question => {
    const id = hash(question.id).slice(0, 16), path = resolve(root, "boros-contexts", id, "accepted.json"), content = readFileSync(path, "utf8");
    const accepted = JSON.parse(content) as { input: BorosInput; envelope: BorosEnvelope };
    if (JSON.stringify(accepted.input) !== JSON.stringify(nativeBorosInput(data, question, accepted.input.arms))) throw new EvalFailure("BOROS_CONTEXT_INPUT_MISMATCH");
    verifyBorosEnvelope(accepted.envelope, accepted.input);
    const attempt = accepted.envelope.attempts.find(item => item.arm === "ordinary_send");
    if (!attempt?.preparation_completed || attempt.semantic_index_received !== false) throw new EvalFailure("BOROS_PREPARATION_REJECTED");
    return [id, hash(content)];
  }));
  const repository = resolve(import.meta.dir, "..");
  const dependencies = ["scripts/compare-long-history.ts", "scripts/long-history-eval.ts", "scripts/local-memory-eval.ts", "scripts/boros-context-driver.ts", "scripts/boros-context-driver.swift", "scripts/beam-grader.ts", "src/core/types.ts", "src/core/context.ts"];
  const dependencyHashes = Object.fromEntries(dependencies.map(path => [path, hash(readFileSync(resolve(repository, path), "utf8"))]));
  const freeze = { protocol: baselineProtocol, protocolHash: hash(JSON.stringify(baselineProtocol)), hashes: longCaseHashes(data), caseFileHash: hash(caseBytes), supplementHash: hash(supplementBytes),
    sourceHash: hash(readFileSync(import.meta.path, "utf8")), dependencyHashes, contextHashes };
  privateDirectory(root);
  const path = resolve(root, "baseline-freeze.json");
  if (existsSync(path)) { if (JSON.stringify(load(path)) !== JSON.stringify(freeze)) throw new EvalFailure("BASELINE_FREEZE_MISMATCH"); }
  else save(path, freeze);
  return { data, supplement, root, freeze, identityHash: hash(JSON.stringify(freeze)) };
}
function loadAnswer(path: string, identityHash: string): ComparisonAnswer {
  const answer = load<ComparisonAnswer>(path);
  if (answer.private.baselineIdentityHash !== identityHash) throw new EvalFailure("BASELINE_ANSWER_MISMATCH");
  if (fatalCodes.has(answer.public.failure)) throw new EvalFailure("FATAL_ANSWER_CACHE");
  return answer;
}
async function calibrate(backend: CountedBackend, questions: BeamGradeQuestion[], root: string, identityHash: string) {
  const aggregatePath = resolve(root, "baseline-calibration.json");
  if (existsSync(aggregatePath)) {
    const saved = load<{ public: BeamCalibrationPublic; private: { baselineIdentityHash: string; callStart: number; callEnd: number } }>(aggregatePath);
    if (saved.private.baselineIdentityHash !== identityHash) throw new EvalFailure("BASELINE_CALIBRATION_MISMATCH"); return saved;
  }
  const selected = createBeamCalibrationControls(questions), results: { kind: "positive" | "negative"; result: BeamGradeResult }[] = [], callStart = calls(backend);
  for (const control of selected.controls) {
    const path = resolve(root, "baseline-calibration-controls", `${hash(control.id)}.json`);
    let result: BeamGradeResult;
    if (existsSync(path)) {
      const saved = load<{ baselineIdentityHash: string; result: BeamGradeResult }>(path);
      if (saved.baselineIdentityHash !== identityHash) throw new EvalFailure("BASELINE_CALIBRATION_MISMATCH"); result = saved.result;
    } else {
      result = await gradeBeamCandidate(backend, control.question, control.candidate);
      save(path, { baselineIdentityHash: identityHash, result });
    }
    results.push({ kind: control.kind, result });
  }
  const positivesAccepted = results.filter(row => row.kind === "positive" && row.result.private.verdict?.correct === true).length;
  const negativesRejected = results.filter(row => row.kind === "negative" && row.result.private.verdict?.correct === false).length;
  const invalidCount = results.filter(row => !row.result.public.valid).length, lowConfidenceCount = results.filter(row => row.result.private.verdict?.confidence === "low").length;
  const accepted = Number(selected.public.positiveCount > 0 && positivesAccepted === selected.public.positiveCount && negativesRejected === selected.public.negativeCount && invalidCount === 0) as 0 | 1;
  const summary = { public: { ...selected.public, accepted, positivesAccepted, negativesRejected, invalidCount, lowConfidenceCount }, private: { baselineIdentityHash: identityHash, callStart, callEnd: calls(backend) } };
  save(aggregatePath, summary); return summary;
}
function summarize(selected: Record<string, any>[], accepted: boolean) {
  const latencies = selected.map(row => row.latencyMs).sort((a, b) => a - b);
  return { questions: selected.length, correct: accepted ? selected.filter(row => row.valid && row.correct === 1 && !row.failure).length : null,
    grounded: accepted ? selected.filter(row => row.valid && row.grounded === 1 && !row.failure).length : null,
    invalidGrades: selected.filter(row => row.valid === 0).length, lowConfidence: selected.filter(row => row.confidenceHigh === 0).length,
    failures: selected.filter(row => row.failure).length, medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    answerCalls: selected.reduce((sum, row) => sum + row.answerCalls, 0), gradingCalls: selected.reduce((sum, row) => sum + (row.gradingCalls ?? 0), 0),
    answerInputTokens: selected.reduce((sum, row) => sum + (row.answerUsage?.inputTokens ?? 0), 0), answerOutputTokens: selected.reduce((sum, row) => sum + (row.answerUsage?.outputTokens ?? 0), 0), gradingInputTokens: selected.reduce((sum, row) => sum + (row.gradingUsage?.inputTokens ?? 0), 0), gradingOutputTokens: selected.reduce((sum, row) => sum + (row.gradingUsage?.outputTokens ?? 0), 0),
    callsWithKnownUsage: selected.reduce((sum, row) => sum + (row.answerUsage?.knownCalls ?? 0) + (row.gradingUsage?.knownCalls ?? 0), 0),
    resolvableGoldSources: selected.reduce((sum, row) => sum + row.resolvableGoldSources, 0), deliveredGoldSources: selected.reduce((sum, row) => sum + row.deliveredGoldSources, 0), fullyDeliveredGoldSources: selected.reduce((sum, row) => sum + row.fullyDeliveredGoldSources, 0) };
}
export async function runBaselineOnly(args: string[], options: { backend?: CountedBackend; onProgress?: (details: Record<string, unknown>) => void } = {}): Promise<Record<string, any>> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--case", "--run", "--mode", "--supplement"].includes(args[i]!) || !args[i + 1]) throw new EvalFailure("INVALID_CLI"); values.set(args[i]!, args[i + 1]!);
  }
  const casePath = values.get("--case"), run = values.get("--run"), mode = values.get("--mode"), supplementPath = values.get("--supplement");
  if (!casePath || !run || !supplementPath || (mode !== "answers" && mode !== "grade")) throw new EvalFailure("EXPLICIT_BASELINE_REQUIRED");
  const frozen = freezeBaseline(casePath, run, supplementPath), { data, supplement, root, identityHash } = frozen;
  const backend = options.backend ?? new ResumableLocalBackend({ url: baselineProtocol.endpoint, model: QWEN_MODEL, directory: root });
  const progress = options.onProgress ?? (details => console.log(JSON.stringify(details)));
  const pathFor = (arm: Arm, question: { id: string }) => resolve(root, "baseline-answers", `${arm}-${hash(question.id).slice(0, 16)}.json`);
  if (mode === "answers") {
    let completed = 0;
    for (let index = 0; index < data.questions.length; index++) {
      const question = data.questions[index]!, ordered: Arm[] = index % 2 ? ["recent", "boros"] : ["boros", "recent"];
      for (const arm of ordered) {
        const path = pathFor(arm, question);
        if (existsSync(path)) { loadAnswer(path, identityHash); completed++; continue; }
        const callStart = calls(backend), metricStart = backend.metrics?.length ?? 0; let answer: ComparisonAnswer;
        if (arm === "recent") answer = await answerRecentFromCase(backend, data, question);
        else {
          const contextPath = resolve(root, "boros-contexts", hash(question.id).slice(0, 16), "accepted.json");
          if (hash(readFileSync(contextPath, "utf8")) !== frozen.freeze.contextHashes[hash(question.id).slice(0, 16)]) throw new EvalFailure("BOROS_CONTEXT_CHANGED");
          const cached = load<{ input: BorosInput; envelope: BorosEnvelope }>(contextPath);
          answer = await answerBoros(backend, cached.envelope, cached.input, question);
        }
        if (fatalCodes.has(answer.public.failure)) throw new EvalFailure(answer.public.failure);
        Object.assign(answer.public, sourceCoverage(question, answer, data), { originalHistoryCount: data.messages.length, answerCalls: calls(backend) - callStart, answerUsage: usageSince(backend, metricStart) });
        answer.private.baselineIdentityHash = identityHash;
        save(path, answer); completed++;
        progress({ phase: "baseline-answer", completed, total: data.questions.length * 2, failures: Number(!!answer.public.failure), cumulativeCalls: calls(backend) });
      }
    }
    return { phase: "answers-complete", answerCells: completed, cumulativeCalls: calls(backend), optPreparationFailure };
  }
  const questions = data.questions.map(question => ({ ...question, nativeAuthorReference: supplement.questions[question.id] }));
  const answers = questions.flatMap(question => (["boros", "recent"] as Arm[]).map(arm => {
    const path = pathFor(arm, question); if (!existsSync(path)) throw new EvalFailure("ANSWERS_NOT_COMPLETE"); return { question, arm, answer: loadAnswer(path, identityHash) };
  }));
  const resultPath = resolve(root, "public-result-baseline.json");
  if (existsSync(resultPath)) {
    const saved = load<Record<string, any>>(resultPath); if (saved.baselineIdentityHash !== identityHash) throw new EvalFailure("BASELINE_RESULT_MISMATCH"); return saved;
  }
  const calibration = await calibrate(backend, questions, root, identityHash);
  let calibrationAccepted = false;
  try { requireBeamCalibration(calibration.public); calibrationAccepted = true; } catch (error) { if (errorCode(error) !== "GRADER_CALIBRATION_FAILED") throw error; }
  const rows: Record<string, any>[] = [];
  for (const { question, arm, answer } of answers) {
    let grade: BeamGradeResult | undefined, gradingCalls = 0, gradingUsage = { inputTokens: 0, outputTokens: 0, knownCalls: 0 };
    if (calibrationAccepted) {
      const path = resolve(root, "baseline-grades", `${arm}-${hash(question.id).slice(0, 16)}.json`), answerHash = hash(answer.private.finalText);
      if (existsSync(path)) {
        const saved = load<{ baselineIdentityHash: string; answerHash: string; grade: BeamGradeResult; gradingCalls: number; gradingUsage: typeof gradingUsage }>(path);
        if (saved.baselineIdentityHash !== identityHash || saved.answerHash !== answerHash) throw new EvalFailure("BASELINE_GRADE_MISMATCH"); grade = saved.grade; gradingCalls = saved.gradingCalls; gradingUsage = saved.gradingUsage;
      } else {
        const before = calls(backend), metricStart = backend.metrics?.length ?? 0; grade = await gradeBeamCandidate(backend, question, answer.private.finalText, { calibration: calibration.public, deliveredEvidence: answer.private.deliveredEvidence }); gradingCalls = calls(backend) - before; gradingUsage = usageSince(backend, metricStart);
        save(path, { baselineIdentityHash: identityHash, answerHash, grade, gradingCalls, gradingUsage });
      }
    }
    rows.push({ ...answer.public, ...(grade?.public ?? {}), gradingCalls, gradingUsage, answerHash: hash(answer.private.finalText) });
    progress({ phase: "baseline-grade", completed: rows.length, total: answers.length, accepted: Number(calibrationAccepted && grade?.public.valid === 1), cumulativeCalls: calls(backend) });
  }
  const qualityComparisonAccepted = calibrationAccepted && rows.every(row => row.valid === 1 && row.acceptedScore === 1);
  const arms = Object.fromEntries((["boros", "recent"] as Arm[]).map(arm => [arm, summarize(rows.filter(row => row.arm === arm), qualityComparisonAccepted)]));
  const categories = Object.fromEntries([...new Set(data.questions.map(question => question.category))].map(category => [category,
    Object.fromEntries((["boros", "recent"] as Arm[]).map(arm => [arm, summarize(rows.filter(row => row.arm === arm && row.category === category), qualityComparisonAccepted)]))]));
  const modelUsage = (backend.metrics ?? []).reduce((sum, metric) => ({ inputTokens: sum.inputTokens + (metric.inputTokens ?? 0), outputTokens: sum.outputTokens + (metric.outputTokens ?? 0), callsWithKnownUsage: sum.callsWithKnownUsage + Number(metric.inputTokens !== null && metric.outputTokens !== null) }), { inputTokens: 0, outputTokens: 0, callsWithKnownUsage: 0 });
  const report = { version: "beam-baseline-result-1", baselineIdentityHash: identityHash, qualityComparisonAccepted, qualityComparisonHeld: !qualityComparisonAccepted,
    holdReason: !calibrationAccepted ? "GRADER_CALIBRATION_FAILED" : !qualityComparisonAccepted ? "INVALID_GRADES" : null,
    freeze: frozen.freeze, originalHistoryCount: data.messages.length, questionCount: data.questions.length, optPreparationFailure,
    calibration: calibration.public, arms, categories, cumulativeCalls: calls(backend), elapsedMs: backend.startedAt ? Date.now() - backend.startedAt : null, modelUsage, rows };
  save(resultPath, report); return report;
}
if (import.meta.main) runBaselineOnly(process.argv.slice(2)).then(result => console.log(JSON.stringify({ phase: "baseline-complete", accepted: result.qualityComparisonAccepted ?? false, cumulativeCalls: result.cumulativeCalls }))).catch(error => { console.error(JSON.stringify({ error: errorCode(error) })); process.exitCode = 1; });

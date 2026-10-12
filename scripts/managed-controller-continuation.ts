import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store, hash } from "../src/index.ts";
import { EvalFailure, requestBody } from "./local-memory-eval.ts";
import { ResumableLocalBackend, longCaseHashes, longTools, type NormalizedLongCase } from "./long-history-eval.ts";
import { expandedInitialMessages, reconstructExpandedPreparation, verifyExpandedCalibration } from "./expanded-memory-comparison.ts";
import { validateNativeSupplement } from "./beam-baseline-only.ts";
import { optionalDeliveredEvidence } from "./optional-parent-comparison.ts";
import { sourceCoverage, type ComparisonAnswer } from "./compare-long-history.ts";
import { gradeDiagnosticCandidate, verifyDiagnosticGrade } from "./boros-context-diagnostics.ts";
import { QWEN_MODEL } from "./boros-context-driver.ts";
import { createQwenRequestTokenizer, createRawQwenRequestTokenizer } from "./qwen-request-tokenizer.ts";
import { answerManagedQuestion, managedControllerProtocol, managedDeliveredEvidence, managedFinalInstruction } from "./managed-optchat-controller.ts";

import { managedComparisonProtocol, managedResources, verifyManagedCachedAnswer as verifyOriginalManagedCachedAnswer } from "./managed-controller-comparison.ts";

const load = <T = any>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
const digest = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
function privateDirectory(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
function save(path: string, value: unknown) { privateDirectory(resolve(path, "..")); writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
function immutable(path: string, value: unknown) { if (existsSync(path)) { if (JSON.stringify(load(path)) !== JSON.stringify(value)) throw new EvalFailure("MANAGED_IMMUTABLE_MISMATCH"); } else save(path, value); }
function checkBindings(bindings: Record<string, string>) { if (Object.entries(bindings).some(([path, expected]) => digest(path) !== expected)) throw new EvalFailure("MANAGED_SOURCE_DRIFT"); }
export { checkBindings as checkContinuationBindings };
function safeCode(error: unknown) { const code = (error as { code?: unknown })?.code; return typeof code === "string" && /^[A-Z_0-9]{1,64}$/.test(code) ? code : "MANAGED_COMPARISON_FAILURE"; }
const label = (id: string) => hash(id).slice(0, 16);
function usageSince(backend: ResumableLocalBackend, index: number) {
  return backend.metrics.slice(index).reduce((sum, metric) => ({ inputTokens: sum.inputTokens + (metric.inputTokens ?? 0), outputTokens: sum.outputTokens + (metric.outputTokens ?? 0), knownCalls: sum.knownCalls + Number(metric.inputTokens !== null && metric.outputTokens !== null) }), { inputTokens: 0, outputTokens: 0, knownCalls: 0 });
}

export const managedReceiptAmendment = {
  version: "managed-controller-failed-receipt-amendment-1", answeringChanges: false, retries: 0,
  failure: "Keep incomplete generated output outside the saved candidate. Assign zero credit.",
  validation: "Authenticate the last missing provider count from captured usage and the persisted failed metric.",
  continuity: "Keep the original identity, resources, controller, saved answers, and first 128 metrics unchanged.",
} as const;

export function incompleteReceiptView(answer: ComparisonAnswer, captureInput: any, captureOutput: any, metric: any, questionId: string) {
  const receipts = answer.private.requestReceipts as any[], last = receipts?.at(-1), expectedStage = `answer:optchat:${questionId}:final`;
  if (answer.public.failure !== "MODEL_OUTPUT_INCOMPLETE" || answer.private.finalText !== "" || !Array.isArray(receipts) || !last || receipts.slice(0, -1).some(receipt => receipt.inputTokens !== receipt.providerInputTokens) || last.providerInputTokens !== undefined || last.tools?.length !== 0 || last.outputTokens !== 2048 || !Number.isSafeInteger(last.inputTokens) || last.inputTokens < 0 || last.inputTokens > 29696 || last.requestHash !== hash(JSON.stringify({ messages: last.messages, tools: last.tools, outputTokens: last.outputTokens, inputTokens: last.inputTokens })) || answer.public.finalizationCalls !== 1 || JSON.stringify(captureInput) !== JSON.stringify(requestBody(QWEN_MODEL, last.messages, last.tools, 2048, "mlx")) || captureOutput?.choices?.length !== 1 || captureOutput.choices[0]?.finish_reason !== "length" || captureOutput.choices[0]?.message?.role !== "assistant" || typeof captureOutput.choices[0]?.message?.content !== "string" || (captureOutput.choices[0]?.message?.tool_calls?.length ?? 0) !== 0 || captureOutput.usage?.prompt_tokens !== last.inputTokens || captureOutput.usage?.completion_tokens !== 2048 || captureOutput.usage?.total_tokens !== last.inputTokens + 2048 || metric?.stage !== expectedStage || metric.success !== false || metric.code !== "MODEL_OUTPUT_INCOMPLETE" || metric.inputTokens !== last.inputTokens || metric.outputTokens !== 2048 || !Number.isSafeInteger(metric.call) || metric.call < 1 || typeof metric.invocation !== "string" || !/^[0-9a-f-]{36}$/.test(metric.invocation)) throw new EvalFailure("MANAGED_FAILED_RECEIPT_PROOF_MISMATCH");
  const view = structuredClone(answer);
  (view.private.requestReceipts as any[]).at(-1).providerInputTokens = captureOutput.usage.prompt_tokens;
  return view;
}

function authenticateFailure(root: string, answer: ComparisonAnswer, questionId: string) {
  const state = load(resolve(root, "backend-state.json")), expectedStage = `answer:optchat:${questionId}:final`, metrics = state.metrics.filter((metric: any) => metric.stage === `answer:optchat:${questionId}` || metric.stage === expectedStage);
  const metric = metrics.at(-1);
  if (metrics.length !== answer.public.steps || answer.public.answerCalls !== answer.public.steps || !metric || metric.stage !== expectedStage || typeof metric.invocation !== "string" || !/^[0-9a-f-]{36}$/.test(metric.invocation) || !Number.isSafeInteger(metric.call) || metric.call < 1) throw new EvalFailure("MANAGED_FAILED_RECEIPT_PROOF_MISMATCH");
  const captureDirectory = resolve(root, "calls", metric.invocation, String(metric.call).padStart(6, "0")), inputPath = resolve(captureDirectory, "call-000-input.json"), outputPath = resolve(captureDirectory, "call-000-output.json");
  const view = incompleteReceiptView(answer, load(inputPath), load(outputPath), metric, questionId);
  return { view, bindings: { [inputPath]: digest(inputPath), [outputPath]: digest(outputPath) }, proof: { questionLabel: label(questionId), call: metric.call, invocation: metric.invocation, requestHash: (answer.private.requestReceipts as any[]).at(-1).requestHash, inputTokens: metric.inputTokens, outputTokens: metric.outputTokens, code: metric.code, finishReason: "length", candidateHash: hash(answer.private.finalText) } };
}

function verifyContinuationCachedAnswer(answer: ComparisonAnswer, initial: any[], identityHash: string, question: NormalizedLongCase["questions"][number], root: string) {
  const receipts = answer.private.requestReceipts as any[];
  if (receipts?.at(-1)?.providerInputTokens === undefined && answer.public.failure === "MODEL_OUTPUT_INCOMPLETE") {
    const authenticated = authenticateFailure(root, answer, question.id);
    verifyOriginalManagedCachedAnswer(authenticated.view, initial, identityHash, question);
    immutable(resolve(root, "managed-failed-receipt-proofs", `${label(question.id)}.json`), { identityHash, answerHash: hash(JSON.stringify(answer)), captureBindings: authenticated.bindings, proof: authenticated.proof });
  } else verifyOriginalManagedCachedAnswer(answer, initial, identityHash, question);
}

export function verifyContinuationState(state: any, manifest: any) {
  if (state.version !== 1 || state.endpoint !== manifest.endpoint || state.model !== manifest.model || state.provider !== manifest.provider || state.startedAt !== manifest.startedAt || !Number.isSafeInteger(state.calls) || state.calls < manifest.prefixCalls || state.calls > manifest.maxCalls || !Array.isArray(state.metrics) || state.metrics.length !== state.calls || hash(JSON.stringify(state.metrics.slice(0, manifest.prefixCalls))) !== manifest.metricsPrefixHash) throw new EvalFailure("MANAGED_CONTINUATION_PREFIX_MISMATCH");
}

function continuationManifest(root: string, repository: string, identityHash: string, data: NormalizedLongCase, resources: any) {
  const path = resolve(root, "managed-controller-continuation-freeze.json");
  if (!existsSync(path)) {
    const state = load(resolve(root, "backend-state.json")), directory = resolve(root, "managed-answers"), expected = data.questions.slice(0, 17).map(question => label(question.id));
    if (state.calls !== 128 || state.metrics.length !== 128 || expected.some(id => !existsSync(resolve(directory, `${id}.json`))) || data.questions.slice(17).some(question => existsSync(resolve(directory, `${label(question.id)}.json`)))) throw new EvalFailure("MANAGED_CONTINUATION_START_MISMATCH");
    const knownQuestion = data.questions[16]!;
    if (label(knownQuestion.id) !== "feefc64438f4b93b") throw new EvalFailure("MANAGED_CONTINUATION_START_MISMATCH");
    const failed = load<ComparisonAnswer>(resolve(directory, `${label(knownQuestion.id)}.json`)), authenticated = authenticateFailure(root, failed, knownQuestion.id);
    if (authenticated.proof.call !== 128 || authenticated.proof.inputTokens !== 26019 || authenticated.proof.outputTokens !== 2048) throw new EvalFailure("MANAGED_CONTINUATION_START_MISMATCH");
    const sourceBindings = Object.fromEntries([resolve(repository, "scripts/managed-controller-continuation.ts"), resolve(repository, "docs/evaluation/managed-controller-receipt-amendment.md"), resolve(root, "managed-controller-freeze.json"), resolve(root, "managed-resources.json"), ...expected.map(id => resolve(directory, `${id}.json`))].map(file => [file, digest(file)]));
    Object.assign(sourceBindings, authenticated.bindings);
    immutable(path, { protocol: managedReceiptAmendment, originalIdentityHash: identityHash, sourceBindings, prefixCalls: 128, metricsPrefixHash: hash(JSON.stringify(state.metrics)), knownFailedProof: authenticated.proof, endpoint: state.endpoint, model: state.model, provider: state.provider, startedAt: state.startedAt, deadlineAt: resources.deadlineAt, maxCalls: resources.maxCalls });
  }
  const manifest = load(path);
  if (JSON.stringify(manifest.protocol) !== JSON.stringify(managedReceiptAmendment) || manifest.originalIdentityHash !== identityHash || manifest.prefixCalls !== 128 || manifest.maxCalls !== 320 || manifest.startedAt !== resources.startedAt || manifest.deadlineAt !== resources.deadlineAt || manifest.deadlineAt !== manifest.startedAt + 3600000) throw new EvalFailure("MANAGED_CONTINUATION_FREEZE_MISMATCH");
  checkBindings(manifest.sourceBindings); verifyContinuationState(load(resolve(root, "backend-state.json")), manifest);
  return { manifest, identityHash: hash(JSON.stringify(manifest)) };
}

function summary(rows: Record<string, any>[], accepted: boolean) {
  const latencies = rows.map(row => row.latencyMs ?? 0).sort((a, b) => a - b);
  return { questions: rows.length, correct: accepted ? rows.filter(row => row.correct === 1 && !row.failure).length : null, failures: rows.filter(row => row.failure).length, nonemptyAnswers: rows.filter(row => row.nonempty).length, invalidGrades: rows.filter(row => row.valid !== 1).length, lowConfidence: rows.filter(row => row.confidenceHigh !== 1).length, answerCalls: rows.reduce((sum, row) => sum + row.answerCalls, 0), answerInputTokens: rows.reduce((sum, row) => sum + row.answerUsage.inputTokens, 0), answerOutputTokens: rows.reduce((sum, row) => sum + row.answerUsage.outputTokens, 0), medianLatencyMs: latencies.length ? (latencies[(latencies.length - 1) >> 1]! + latencies[latencies.length >> 1]!) / 2 : null, deliveredGoldSources: rows.reduce((sum, row) => sum + row.deliveredGoldSources, 0), fullyDeliveredGoldSources: rows.reduce((sum, row) => sum + row.fullyDeliveredGoldSources, 0) };
}

export async function runManagedContinuation(args: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) { if (!["--source-run", "--run", "--case", "--supplement", "--mode"].includes(args[i]!) || !args[i + 1] || flags.has(args[i]!)) throw new EvalFailure("INVALID_CLI"); flags.set(args[i]!, args[i + 1]!); }
  const sourceArg = flags.get("--source-run"), rootArg = flags.get("--run"), caseArg = flags.get("--case"), supplementArg = flags.get("--supplement"), mode = flags.get("--mode");
  if (!sourceArg || !rootArg || !caseArg || !supplementArg || !["freeze", "answers", "grade"].includes(mode ?? "")) throw new EvalFailure("EXPLICIT_MANAGED_CONFIG_REQUIRED");
  const repository = resolve(import.meta.dir, ".."), sourceRoot = realpathSync(resolve(sourceArg)), root = resolve(rootArg), casePath = resolve(caseArg), supplementPath = resolve(supplementArg);
  privateDirectory(root);
  if (!realpathSync(root).startsWith(resolve(repository, ".optchat") + "/") || realpathSync(root) === sourceRoot) throw new EvalFailure("MANAGED_PRIVATE_COPY_REQUIRED");
  const oldFreezePath = resolve(sourceRoot, "expanded-comparison-freeze.json"), oldResultPath = resolve(sourceRoot, "public-result-expanded-comparison.json"), sourceStatePath = resolve(sourceRoot, "backend-state.json"), old = load(oldFreezePath), oldResult = load(oldResultPath), sourceState = load(sourceStatePath);
  const oldIdentity = hash(JSON.stringify(old));
  if (oldIdentity !== "be518edb91187148eccac0a5943ba992f8597405c5457a53d5648aaffe7d4330" || oldResult.expandedIdentityHash !== oldIdentity || !oldResult.qualityComparisonAccepted || sourceState.calls !== 2628 || oldResult.lineage.cumulativeCalls !== sourceState.calls || digest(casePath) !== old.caseFileHash || digest(supplementPath) !== old.supplementHash || digest(resolve(repository, "scripts/expanded-memory-comparison.ts")) !== old.sourceHash || Object.entries(old.dependencyHashes).some(([path, value]) => digest(resolve(repository, path)) !== value)) throw new EvalFailure("MANAGED_ORIGINAL_MISMATCH");
  const data = load<NormalizedLongCase>(casePath), supplement = load(supplementPath);
  validateNativeSupplement(supplement, data, digest(casePath));
  if (data.questions.length !== 20 || longCaseHashes(data).caseHash !== old.caseHash) throw new EvalFailure("MANAGED_CASE_MISMATCH");
  const tokenizer = await createQwenRequestTokenizer({ directory: sourceRoot }), renderer = createRawQwenRequestTokenizer();
  if (JSON.stringify(tokenizer.identity) !== JSON.stringify(old.tokenizerIdentity) || Object.entries(renderer.identity).some(([key, value]) => JSON.stringify((tokenizer.identity as any)[key]) !== JSON.stringify(value))) throw new EvalFailure("MANAGED_TOKENIZER_MISMATCH");
  const questions = data.questions.map(question => ({ ...question, nativeAuthorReference: supplement.questions[question.id] })), calibration = verifyExpandedCalibration(sourceRoot, questions, old.baselineIdentityHash);
  const sourceBindings: Record<string, string> = Object.fromEntries([oldFreezePath, oldResultPath, sourceStatePath, casePath, supplementPath, resolve(repository, "scripts/managed-controller-comparison.ts"), resolve(repository, "scripts/managed-optchat-controller.ts"), resolve(repository, "docs/evaluation/managed-controller-protocol.md"), resolve(sourceRoot, "qwen-tokenizer-validation.json"), resolve(sourceRoot, "baseline-calibration.json"), ...Object.keys(old.dependencyHashes).map(path => resolve(repository, path)), resolve(repository, "scripts/expanded-memory-comparison.ts"), resolve(repository, "scripts/boros-context-diagnostics.ts"), resolve(repository, "scripts/qwen-request-tokenizer.ts"), ...Object.keys(calibration.controlHashes).map(name => resolve(sourceRoot, "baseline-calibration-controls", `${name}.json`))].map(path => [path, digest(path)]));
  const priorDiagnosticPath = resolve(repository, ".optchat/boros-confirm-01/backend-state.json"), priorDiagnostic = load(priorDiagnosticPath);
  if (priorDiagnostic.calls !== 95) throw new EvalFailure("MANAGED_LINEAGE_MISMATCH");
  sourceBindings[priorDiagnosticPath] = digest(priorDiagnosticPath);
  const savedAnswers = data.questions.map(question => {
    const name = `optchat-${label(question.id)}`, path = resolve(sourceRoot, "expanded-answers", `${name}.json`), ledgerPath = resolve(sourceRoot, "expanded-answer-ledger", `${name}.json`), answer = load<ComparisonAnswer>(path), ledger = load(ledgerPath);
    if (answer.private.expandedIdentityHash !== oldIdentity || answer.public.questionId !== question.id || answer.public.category !== question.category || answer.public.arm !== "optchat" || ledger.identityHash !== oldIdentity || ledger.fileHash !== digest(path) || ledger.contentHash !== hash(JSON.stringify(answer.private))) throw new EvalFailure("MANAGED_SAVED_CANDIDATE_MISMATCH");
    sourceBindings[path] = digest(path); sourceBindings[ledgerPath] = digest(ledgerPath);
    return { question, answer, path };
  });
  const sourceDatabase = resolve(sourceRoot, "memory.sqlite"), database = resolve(root, "memory.sqlite"), copyPath = resolve(root, "managed-database-copy.json");
  const sourceDatabaseFiles = [sourceDatabase, `${sourceDatabase}-wal`].filter(existsSync), sourceDatabaseHashes = Object.fromEntries(sourceDatabaseFiles.map(path => [path, digest(path)]));
  if (!existsSync(copyPath)) {
    if (existsSync(database)) throw new EvalFailure("MANAGED_DATABASE_COPY_INCOMPLETE");
    const reader = new Database(sourceDatabase, { readonly: true });
    try { reader.run("VACUUM INTO ?", [database]); } finally { reader.close(); }
    chmodSync(database, 0o600);
    checkBindings(sourceDatabaseHashes);
    save(copyPath, { sourceDatabaseHashes, copiedDatabaseHash: digest(database) });
  }
  const copy = load(copyPath);
  if (JSON.stringify(copy.sourceDatabaseHashes) !== JSON.stringify(sourceDatabaseHashes) || statSync(sourceDatabase).ino === statSync(database).ino && statSync(sourceDatabase).dev === statSync(database).dev) throw new EvalFailure("MANAGED_PRIVATE_COPY_REQUIRED");
  Object.assign(sourceBindings, copy.sourceDatabaseHashes); sourceBindings[copyPath] = digest(copyPath);
  const store = new Store(database);
  try {
    const { prepared, audit } = reconstructExpandedPreparation(store, data);
    if (JSON.stringify(audit.durableHashes) !== JSON.stringify(old.graph.durableHashes) || audit.snapshotHash !== old.graph.snapshotHash || audit.projectionBytes !== old.graph.projectionBytes || audit.retainedFailureHash !== old.graph.retainedFailureHash || audit.compactionCalls !== 0) throw new EvalFailure("MANAGED_GRAPH_MISMATCH");
    for (const { question, answer } of savedAnswers) {
      const initial = expandedInitialMessages(prepared, question).messages;
      if (JSON.stringify((answer.private.messages as any[]).slice(0, 2)) !== JSON.stringify(initial)) throw new EvalFailure("MANAGED_INITIAL_CONTEXT_MISMATCH");
      const evidence = optionalDeliveredEvidence(answer as any, prepared as any, answer.private.submittedMessages as any);
      if (JSON.stringify(evidence) !== JSON.stringify(answer.private.deliveredEvidence) || Object.entries(sourceCoverage(question, answer, data)).some(([key, value]) => answer.public[key] !== value)) throw new EvalFailure("MANAGED_SAVED_EVIDENCE_MISMATCH");
    }
    const resources = managedResources(root, sourceState.calls, priorDiagnostic.calls);
    const cells = [] as any[];
    for (const question of data.questions) {
      const initial = expandedInitialMessages(prepared, question).messages, inputTokens = await tokenizer.countRequestTokens(initial, longTools, 2048);
      if (inputTokens > 29696) throw new EvalFailure("MANAGED_INITIAL_CONTEXT_UNSUPPORTED");
      cells.push({ questionId: question.id, questionLabel: label(question.id), category: question.category, initialMessagesHash: hash(JSON.stringify(initial)), inputTokens });
    }
    checkBindings(sourceBindings);
    const freeze = { protocol: managedComparisonProtocol, controllerProtocol: managedControllerProtocol, sourceBindings, originalExpandedIdentityHash: oldIdentity, caseHash: old.caseHash, tokenizerIdentity: tokenizer.identity, calibration, graph: audit, resources, cells };
    immutable(resolve(root, "managed-controller-freeze.json"), freeze);
    const identityHash = hash(JSON.stringify(freeze));
    const continuation = continuationManifest(root, repository, identityHash, data, resources);
    const checkContinuation = () => { checkBindings(sourceBindings); checkBindings(continuation.manifest.sourceBindings); verifyContinuationState(load(resolve(root, "backend-state.json")), continuation.manifest); };
    if (mode === "freeze") return { phase: "frozen", identityHash, continuationIdentityHash: continuation.identityHash, questionCount: cells.length, deadlineAt: resources.deadlineAt, oldCalls: sourceState.calls, priorDiagnosticCalls: priorDiagnostic.calls };
    const backend = new ResumableLocalBackend({ directory: root, url: "http://127.0.0.1:11234/v1/chat/completions", model: QWEN_MODEL, provider: "mlx", maxCalls: resources.maxCalls, maxMinutes: resources.maxMinutes });
    if (backend.startedAt !== resources.startedAt) throw new EvalFailure("MANAGED_RESOURCE_MISMATCH");
    const complete = backend.complete.bind(backend);
    backend.complete = async (...parameters) => { checkContinuation(); return complete(...parameters); };
    const answers: ComparisonAnswer[] = [];
    for (const question of data.questions) {
      checkContinuation();
      const cellId = label(question.id), path = resolve(root, "managed-answers", `${cellId}.json`);
      if (!existsSync(path)) {
        if (mode !== "answers") throw new EvalFailure("MANAGED_ANSWERS_NOT_COMPLETE");
        const before = backend.calls, metric = backend.metrics.length, answer = await answerManagedQuestion(backend, prepared, question, { countRequestTokens: tokenizer.countRequestTokens });
        const modelSeen = managedDeliveredEvidence(answer as any, prepared, answer.private.requestReceipts.flatMap(receipt => receipt.messages));
        const modelSeenCoverage = sourceCoverage(question, { ...answer, private: { ...answer.private, deliveredEvidence: modelSeen } }, data);
        Object.assign(answer.public, sourceCoverage(question, answer, data), { answerCalls: backend.calls - before, answerUsage: usageSince(backend, metric), originalHistoryCount: data.messages.length });
        Object.assign(answer.public, { modelSeenOriginalCount: new Set(modelSeen.map(item => item.sourceId)).size, modelSeenCompleteOriginalCount: modelSeen.filter(item => item.complete).length, modelSeenGoldSources: modelSeenCoverage.deliveredGoldSources, modelSeenCompleteGoldSources: modelSeenCoverage.fullyDeliveredGoldSources });
        Object.assign(answer.private, { managedIdentityHash: identityHash, modelSeenEvidence: modelSeen }); save(path, answer);
      }
      const answer = load<ComparisonAnswer>(path);
      verifyContinuationCachedAnswer(answer, expandedInitialMessages(prepared, question).messages, identityHash, question, root);
      if (answer.public.caseHash !== old.caseHash) throw new EvalFailure("MANAGED_ANSWER_MISMATCH");
      const evidence = managedDeliveredEvidence(answer as any, prepared, answer.private.submittedMessages as any);
      if (JSON.stringify(evidence) !== JSON.stringify(answer.private.deliveredEvidence) || Object.entries(sourceCoverage(question, answer, data)).some(([key, value]) => answer.public[key] !== value)) throw new EvalFailure("MANAGED_CURRENT_EVIDENCE_MISMATCH");
      const modelSeen = managedDeliveredEvidence(answer as any, prepared, (answer.private.requestReceipts as any[]).flatMap(receipt => receipt.messages));
      const seenCoverage = sourceCoverage(question, { ...answer, private: { ...answer.private, deliveredEvidence: modelSeen } }, data);
      if (JSON.stringify(modelSeen) !== JSON.stringify(answer.private.modelSeenEvidence) || answer.public.modelSeenOriginalCount !== new Set(modelSeen.map(item => item.sourceId)).size || answer.public.modelSeenCompleteOriginalCount !== modelSeen.filter(item => item.complete).length || answer.public.modelSeenGoldSources !== seenCoverage.deliveredGoldSources || answer.public.modelSeenCompleteGoldSources !== seenCoverage.fullyDeliveredGoldSources) throw new EvalFailure("MANAGED_SEEN_EVIDENCE_MISMATCH");
      immutable(resolve(root, "managed-answer-ledger", `${cellId}.json`), { identityHash, fileHash: digest(path), candidateHash: hash(answer.private.finalText) });
      answers.push(answer);
      console.log(JSON.stringify({ phase: "managed-answer", completed: answers.length, total: 20, failure: answer.public.failure, phaseCalls: backend.calls }));
    }
    if (mode === "answers") return { phase: "answers-complete", identityHash, continuationIdentityHash: continuation.identityHash, answerCells: answers.length, phaseCalls: backend.calls };
    const rows: Record<string, any>[] = [];
    for (let index = 0; index < questions.length; index++) {
      const question = questions[index]!, variants = index % 2 ? ["managed", "saved"] : ["saved", "managed"];
      for (const variant of variants) {
        checkContinuation();
        const answer = variant === "managed" ? answers[index]! : savedAnswers[index]!.answer, cellId = `${label(question.id)}-${variant}`, path = resolve(root, "managed-grades", `${cellId}.json`);
        if (!existsSync(path)) save(path, await gradeDiagnosticCandidate(backend, question, answer.private.finalText, cellId, identityHash, calibration.public, tokenizer.countRequestTokens));
        const grade = load(path); verifyDiagnosticGrade(grade, question, answer.private.finalText, cellId, identityHash);
        immutable(resolve(root, "managed-grade-ledger", `${cellId}.json`), { identityHash, fileHash: digest(path), candidateHash: hash(answer.private.finalText), inputHash: grade.binding.inputHash });
        rows.push({ questionLabel: label(question.id), category: question.category, variant, failure: answer.public.failure, nonempty: !!answer.private.finalText.trim(), steps: answer.public.steps, finalizationCalls: answer.public.finalizationCalls, latencyMs: answer.public.latencyMs, toolCounts: answer.public.toolCounts, maxRequestTokenBound: answer.public.maxRequestTokenBound, controller: answer.public.controller ?? null, answerCalls: answer.public.answerCalls, answerUsage: answer.public.answerUsage, resolvableGoldSources: answer.public.resolvableGoldSources, deliveredGoldSources: answer.public.deliveredGoldSources, fullyDeliveredGoldSources: answer.public.fullyDeliveredGoldSources, modelSeenGoldSources: answer.public.modelSeenGoldSources ?? null, modelSeenCompleteGoldSources: answer.public.modelSeenCompleteGoldSources ?? null, valid: grade.grade.public.valid, confidenceHigh: grade.grade.public.confidenceHigh, correctnessVerdict: grade.grade.public.correct, acceptedScore: grade.grade.public.acceptedScore, gradingFailure: grade.grade.private.failure, gradingCalls: grade.calls, gradingUsage: grade.usage, answerHash: hash(answer.private.finalText), previousCorrect: oldResult.rows.find((row: any) => row.arm === "optchat" && row.questionId === question.id).correct });
        console.log(JSON.stringify({ phase: "managed-grade", completed: rows.length, total: 40, valid: grade.grade.public.valid, phaseCalls: backend.calls }));
      }
    }
    checkContinuation();
    const qualityAccepted = calibration.public.accepted === 1 && rows.length === 40 && rows.every(row => row.valid === 1 && row.acceptedScore === 1 && !/^(?:TOKENIZER_|INVALID_TOKEN_COUNT|SOURCE_|MANAGED_)/.test(row.failure ?? ""));
    for (const row of rows) row.correct = qualityAccepted ? Number(row.correctnessVerdict === 1 && !row.failure) : null;
    const variants = Object.fromEntries(["saved", "managed"].map(variant => [variant, summary(rows.filter(row => row.variant === variant), qualityAccepted)]));
    const paired = { bothCorrect: 0, managedOnly: 0, savedOnly: 0, neitherCorrect: 0, savedGradeDrift: 0 };
    if (qualityAccepted) for (const cell of cells) {
      const saved = rows.find(row => row.variant === "saved" && row.questionLabel === cell.questionLabel)!, managed = rows.find(row => row.variant === "managed" && row.questionLabel === cell.questionLabel)!;
      if (saved.correct !== saved.previousCorrect) paired.savedGradeDrift++;
      if (saved.correct && managed.correct) paired.bothCorrect++; else if (managed.correct) paired.managedOnly++; else if (saved.correct) paired.savedOnly++; else paired.neitherCorrect++;
    }
    const categories = Object.fromEntries([...new Set(rows.map(row => row.category))].map(category => [category, Object.fromEntries(["saved", "managed"].map(variant => [variant, summary(rows.filter(row => row.category === category && row.variant === variant), qualityAccepted)]))]));
    const result = { version: managedComparisonProtocol.version, developmentOnly: true, identityHash, originalExpandedIdentityHash: oldIdentity, receiptAmendment: { version: managedReceiptAmendment.version, identityHash: continuation.identityHash, retainedPrefixCalls: continuation.manifest.prefixCalls, unchangedCandidateBytes: true, failedCandidatesReceiveZeroCredit: true, retries: 0 }, qualityAccepted, variants, categories, paired: qualityAccepted ? paired : null, rows, calibration: calibration.public, graph: audit, resources, lineage: { originalCalls: sourceState.calls, priorDiagnosticCalls: priorDiagnostic.calls, phaseCalls: backend.calls, cumulativeKnownCalls: sourceState.calls + priorDiagnostic.calls + backend.calls, sourceCounterUnchanged: true }, limits: { reusedDevelopmentQuestions: true, sameLocalAnswererAndGrader: true, runtimeScope: managedComparisonProtocol.runtimeScope, unchangedInitialContext: true, unchangedLiteralSearch: true, noNewCompaction: true } };
    immutable(resolve(root, "public-result-managed-controller.json"), result); return result;
  } finally { store.close(); }
}
if (import.meta.main) runManagedContinuation(process.argv.slice(2)).then(result => console.log(JSON.stringify({ phase: "phase" in result ? result.phase : "graded", identityHash: result.identityHash, qualityAccepted: "qualityAccepted" in result ? result.qualityAccepted : undefined }))).catch(error => { console.error(JSON.stringify({ error: safeCode(error) })); process.exitCode = 1; });

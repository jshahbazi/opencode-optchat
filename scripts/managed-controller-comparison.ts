import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store, hash } from "../src/index.ts";
import { EvalFailure } from "./local-memory-eval.ts";
import { ResumableLocalBackend, longCaseHashes, longTools, type NormalizedLongCase } from "./long-history-eval.ts";
import { expandedInitialMessages, reconstructExpandedPreparation, verifyExpandedCalibration } from "./expanded-memory-comparison.ts";
import { validateNativeSupplement } from "./beam-baseline-only.ts";
import { optionalDeliveredEvidence } from "./optional-parent-comparison.ts";
import { sourceCoverage, type ComparisonAnswer } from "./compare-long-history.ts";
import { gradeDiagnosticCandidate, verifyDiagnosticGrade } from "./boros-context-diagnostics.ts";
import { QWEN_MODEL } from "./boros-context-driver.ts";
import { createQwenRequestTokenizer, createRawQwenRequestTokenizer } from "./qwen-request-tokenizer.ts";
import { answerManagedQuestion, managedControllerProtocol, managedDeliveredEvidence, managedFinalInstruction } from "./managed-optchat-controller.ts";

export const managedComparisonProtocol = {
  version: "beam-managed-controller-comparison-1", developmentOnly: true,
  controller: "Bound the local evaluation retrieval transcript. Preserve initial context and search semantics.",
  questionOrder: "All twenty unchanged native questions, in native order.",
  answersBeforeGrades: true, gradeOrder: "Alternate saved and managed candidates by question index.",
  grading: "Unchanged blind correctness-only judge with accepted authored calibration.",
  contextTokens: 32768, outputTokens: 2048, safetyTokens: 1024, maxAnswerSteps: 12,
  temperature: 0, thinking: false, serialCalls: true, retries: 0,
  maxCalls: 320, maxMinutes: 60, questionCount: 20, gradeCells: 40,
  preparation: "Copy the saved graph. No new compaction or failed-job retry.",
  baselines: "Generate managed answers once. Regrade all twenty saved OptChat candidates once.",
  runtimeScope: "Local evaluation controller. The OpenCode host loop and application defaults remain unchanged.",
} as const;
const load = <T = any>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
const digest = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
function privateDirectory(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
function save(path: string, value: unknown) { privateDirectory(resolve(path, "..")); writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
function immutable(path: string, value: unknown) { if (existsSync(path)) { if (JSON.stringify(load(path)) !== JSON.stringify(value)) throw new EvalFailure("MANAGED_IMMUTABLE_MISMATCH"); } else save(path, value); }
function checkBindings(bindings: Record<string, string>) { if (Object.entries(bindings).some(([path, expected]) => digest(path) !== expected)) throw new EvalFailure("MANAGED_SOURCE_DRIFT"); }
function safeCode(error: unknown) { const code = (error as { code?: unknown })?.code; return typeof code === "string" && /^[A-Z_0-9]{1,64}$/.test(code) ? code : "MANAGED_COMPARISON_FAILURE"; }
const label = (id: string) => hash(id).slice(0, 16);
function usageSince(backend: ResumableLocalBackend, index: number) {
  return backend.metrics.slice(index).reduce((sum, metric) => ({ inputTokens: sum.inputTokens + (metric.inputTokens ?? 0), outputTokens: sum.outputTokens + (metric.outputTokens ?? 0), knownCalls: sum.knownCalls + Number(metric.inputTokens !== null && metric.outputTokens !== null) }), { inputTokens: 0, outputTokens: 0, knownCalls: 0 });
}

export function managedResources(root: string, sourceCalls: number, priorDiagnosticCalls: number) {
  const path = resolve(root, "managed-resources.json");
  const resource = existsSync(path) ? load(path) : { version: managedComparisonProtocol.version, startedAt: Date.now(), maxCalls: 320, maxMinutes: 60, sourceCalls, priorDiagnosticCalls };
  resource.deadlineAt ??= resource.startedAt + 60 * 60000;
  if (resource.version !== managedComparisonProtocol.version || resource.maxCalls !== 320 || resource.maxMinutes !== 60 || resource.sourceCalls !== sourceCalls || resource.priorDiagnosticCalls !== priorDiagnosticCalls || !Number.isSafeInteger(resource.startedAt) || resource.deadlineAt !== resource.startedAt + 60 * 60000) throw new EvalFailure("MANAGED_RESOURCE_MISMATCH");
  immutable(path, resource);
  const statePath = resolve(root, "backend-state.json");
  if (!existsSync(statePath)) save(statePath, { version: 1, endpoint: "http://127.0.0.1:11234/v1/chat/completions", model: QWEN_MODEL, provider: "mlx", startedAt: resource.startedAt, calls: 0, metrics: [] });
  const state = load(statePath);
  if (state.startedAt !== resource.startedAt || !Number.isSafeInteger(state.calls) || state.calls < 0 || state.calls > resource.maxCalls) throw new EvalFailure("MANAGED_RESOURCE_MISMATCH");
  return resource;
}

export function verifyManagedMessageProtocol(messages: any[], finalization: boolean) {
  for (let index = 2; index < messages.length;) {
    const message = messages[index++];
    if (message?.role === "user" && finalization && index === messages.length && message.content === managedFinalInstruction) continue;
    if (message?.role !== "assistant") throw new EvalFailure("MANAGED_TOOL_PROTOCOL_MISMATCH");
    const calls = message.tool_calls ?? [];
    if (!Array.isArray(calls) || new Set(calls.map((call: any) => call.id)).size !== calls.length || calls.some((call: any) => typeof call.id !== "string" || !call.id || call.type !== "function")) throw new EvalFailure("MANAGED_TOOL_PROTOCOL_MISMATCH");
    const expected = new Set(calls.map((call: any) => call.id));
    for (let count = 0; count < calls.length; count++) {
      const result = messages[index++];
      if (result?.role !== "tool" || !expected.delete(result.tool_call_id) || typeof result.content !== "string") throw new EvalFailure("MANAGED_TOOL_PROTOCOL_MISMATCH");
    }
  }
}

export function verifyManagedCachedAnswer(answer: ComparisonAnswer, initial: any[], identityHash: string, question: NormalizedLongCase["questions"][number]) {
  const receipts = answer.private.requestReceipts as any[], submitted = answer.private.submittedMessages as any[];
  if (answer.private.managedIdentityHash !== identityHash || answer.public.questionId !== question.id || answer.public.questionHash !== hash(question.question) || answer.public.category !== question.category || answer.public.arm !== "optchat" || typeof answer.private.finalText !== "string" || !Array.isArray(receipts) || receipts.length !== answer.public.steps || !Array.isArray(submitted) || JSON.stringify(submitted) !== JSON.stringify(receipts.at(-1)?.messages ?? []) || receipts.some(receipt => {
    return JSON.stringify(receipt.messages.slice(0, 2)) !== JSON.stringify(initial) || receipt.requestHash !== hash(JSON.stringify({ messages: receipt.messages, tools: receipt.tools, outputTokens: receipt.outputTokens, inputTokens: receipt.inputTokens })) || receipt.outputTokens !== 2048 || !Number.isSafeInteger(receipt.inputTokens) || receipt.inputTokens < 0 || receipt.inputTokens > 29696 || receipt.inputTokens !== receipt.providerInputTokens || JSON.stringify(receipt.tools) !== JSON.stringify(longTools) && receipt.tools.length !== 0;
  })) throw new EvalFailure("MANAGED_ANSWER_MISMATCH");
  for (const receipt of receipts) verifyManagedMessageProtocol(receipt.messages, receipt.tools.length === 0);
  const finalRequests = receipts.filter(receipt => receipt.tools.length === 0), groups = answer.private.groups as any[], buffer = answer.private.bufferLedger as any[], evictions = answer.private.evictions as any[];
  if (answer.public.protocolHash !== hash(JSON.stringify(managedControllerProtocol)) || receipts.length > 13 || receipts.filter(receipt => receipt.tools.length).length > 12 || finalRequests.length > 1 || finalRequests.length && finalRequests[0] !== receipts.at(-1) || finalRequests.length !== answer.public.finalizationCalls || answer.public.maxRequestTokenBound !== Math.max(0, ...receipts.map(receipt => receipt.inputTokens)) || !Array.isArray(groups) || !Array.isArray(buffer) || !Array.isArray(evictions) || buffer.length !== receipts.length) throw new EvalFailure("MANAGED_BUFFER_LEDGER_MISMATCH");
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    if (group.index !== index || group.groupHash !== hash(JSON.stringify(group.messages))) throw new EvalFailure("MANAGED_BUFFER_LEDGER_MISMATCH");
    verifyManagedMessageProtocol([...initial, ...group.messages], false);
  }
  for (let index = 0; index < buffer.length; index++) {
    const entry = buffer[index]!, receipt = receipts[index]!;
    if (entry.requestIndex !== index || !Array.isArray(entry.groupIndices) || entry.groupIndices.some((group: number) => !groups[group]) || new Set(entry.groupIndices).size !== entry.groupIndices.length || JSON.stringify(entry.groupHashes) !== JSON.stringify(entry.groupIndices.map((group: number) => groups[group].groupHash)) || entry.finalizing !== (receipt.tools.length === 0)) throw new EvalFailure("MANAGED_BUFFER_LEDGER_MISMATCH");
    const messages = [...initial, ...entry.groupIndices.flatMap((group: number) => groups[group].messages), ...(entry.finalizing ? [{ role: "user", content: managedFinalInstruction }] : [])];
    if (entry.messagesHash !== hash(JSON.stringify(messages)) || JSON.stringify(messages) !== JSON.stringify(receipt.messages)) throw new EvalFailure("MANAGED_BUFFER_LEDGER_MISMATCH");
    for (const group of entry.groupIndices) if (evictions.some(eviction => eviction.groupIndex === group && eviction.beforeRequest <= index)) throw new EvalFailure("MANAGED_RETIRED_GROUP_REUSED");
  }
  for (const eviction of evictions) if (!groups[eviction.groupIndex] || eviction.groupHash !== groups[eviction.groupIndex].groupHash || !Number.isSafeInteger(eviction.beforeRequest) || eviction.beforeRequest < 0 || eviction.beforeRequest > receipts.length || !["duplicate", "navigation_budget", "source_budget", "pending_budget"].includes(eviction.reason)) throw new EvalFailure("MANAGED_BUFFER_LEDGER_MISMATCH");
  const final = (answer.private.fullTranscript as any[]).at(-1);
  if (answer.private.finalText && (final?.role !== "assistant" || final.content !== answer.private.finalText)) throw new EvalFailure("MANAGED_ANSWER_MISMATCH");
  if (answer.private.finalText.trim() && answer.public.failure) throw new EvalFailure("MANAGED_ANSWER_MISMATCH");
}

function summary(rows: Record<string, any>[], accepted: boolean) {
  const latencies = rows.map(row => row.latencyMs ?? 0).sort((a, b) => a - b);
  return { questions: rows.length, correct: accepted ? rows.filter(row => row.correct === 1 && !row.failure).length : null, failures: rows.filter(row => row.failure).length, nonemptyAnswers: rows.filter(row => row.nonempty).length, invalidGrades: rows.filter(row => row.valid !== 1).length, lowConfidence: rows.filter(row => row.confidenceHigh !== 1).length, answerCalls: rows.reduce((sum, row) => sum + row.answerCalls, 0), answerInputTokens: rows.reduce((sum, row) => sum + row.answerUsage.inputTokens, 0), answerOutputTokens: rows.reduce((sum, row) => sum + row.answerUsage.outputTokens, 0), medianLatencyMs: latencies.length ? (latencies[(latencies.length - 1) >> 1]! + latencies[latencies.length >> 1]!) / 2 : null, deliveredGoldSources: rows.reduce((sum, row) => sum + row.deliveredGoldSources, 0), fullyDeliveredGoldSources: rows.reduce((sum, row) => sum + row.fullyDeliveredGoldSources, 0) };
}

export async function runManagedComparison(args: string[]) {
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
  const sourceBindings: Record<string, string> = Object.fromEntries([oldFreezePath, oldResultPath, sourceStatePath, casePath, supplementPath, import.meta.path, resolve(repository, "scripts/managed-optchat-controller.ts"), resolve(repository, "docs/evaluation/managed-controller-protocol.md"), resolve(sourceRoot, "qwen-tokenizer-validation.json"), resolve(sourceRoot, "baseline-calibration.json"), ...Object.keys(old.dependencyHashes).map(path => resolve(repository, path)), resolve(repository, "scripts/expanded-memory-comparison.ts"), resolve(repository, "scripts/boros-context-diagnostics.ts"), resolve(repository, "scripts/qwen-request-tokenizer.ts"), ...Object.keys(calibration.controlHashes).map(name => resolve(sourceRoot, "baseline-calibration-controls", `${name}.json`))].map(path => [path, digest(path)]));
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
    if (mode === "freeze") return { phase: "frozen", identityHash, questionCount: cells.length, deadlineAt: resources.deadlineAt, oldCalls: sourceState.calls, priorDiagnosticCalls: priorDiagnostic.calls };
    const backend = new ResumableLocalBackend({ directory: root, url: "http://127.0.0.1:11234/v1/chat/completions", model: QWEN_MODEL, provider: "mlx", maxCalls: resources.maxCalls, maxMinutes: resources.maxMinutes });
    if (backend.startedAt !== resources.startedAt) throw new EvalFailure("MANAGED_RESOURCE_MISMATCH");
    const answers: ComparisonAnswer[] = [];
    for (const question of data.questions) {
      checkBindings(sourceBindings);
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
      verifyManagedCachedAnswer(answer, expandedInitialMessages(prepared, question).messages, identityHash, question);
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
    if (mode === "answers") return { phase: "answers-complete", identityHash, answerCells: answers.length, phaseCalls: backend.calls };
    const rows: Record<string, any>[] = [];
    for (let index = 0; index < questions.length; index++) {
      const question = questions[index]!, variants = index % 2 ? ["managed", "saved"] : ["saved", "managed"];
      for (const variant of variants) {
        checkBindings(sourceBindings);
        const answer = variant === "managed" ? answers[index]! : savedAnswers[index]!.answer, cellId = `${label(question.id)}-${variant}`, path = resolve(root, "managed-grades", `${cellId}.json`);
        if (!existsSync(path)) save(path, await gradeDiagnosticCandidate(backend, question, answer.private.finalText, cellId, identityHash, calibration.public, tokenizer.countRequestTokens));
        const grade = load(path); verifyDiagnosticGrade(grade, question, answer.private.finalText, cellId, identityHash);
        immutable(resolve(root, "managed-grade-ledger", `${cellId}.json`), { identityHash, fileHash: digest(path), candidateHash: hash(answer.private.finalText), inputHash: grade.binding.inputHash });
        rows.push({ questionLabel: label(question.id), category: question.category, variant, failure: answer.public.failure, nonempty: !!answer.private.finalText.trim(), steps: answer.public.steps, finalizationCalls: answer.public.finalizationCalls, latencyMs: answer.public.latencyMs, toolCounts: answer.public.toolCounts, maxRequestTokenBound: answer.public.maxRequestTokenBound, controller: answer.public.controller ?? null, answerCalls: answer.public.answerCalls, answerUsage: answer.public.answerUsage, resolvableGoldSources: answer.public.resolvableGoldSources, deliveredGoldSources: answer.public.deliveredGoldSources, fullyDeliveredGoldSources: answer.public.fullyDeliveredGoldSources, modelSeenGoldSources: answer.public.modelSeenGoldSources ?? null, modelSeenCompleteGoldSources: answer.public.modelSeenCompleteGoldSources ?? null, valid: grade.grade.public.valid, confidenceHigh: grade.grade.public.confidenceHigh, correctnessVerdict: grade.grade.public.correct, acceptedScore: grade.grade.public.acceptedScore, gradingFailure: grade.grade.private.failure, gradingCalls: grade.calls, gradingUsage: grade.usage, answerHash: hash(answer.private.finalText), previousCorrect: oldResult.rows.find((row: any) => row.arm === "optchat" && row.questionId === question.id).correct });
        console.log(JSON.stringify({ phase: "managed-grade", completed: rows.length, total: 40, valid: grade.grade.public.valid, phaseCalls: backend.calls }));
      }
    }
    checkBindings(sourceBindings);
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
    const result = { version: managedComparisonProtocol.version, developmentOnly: true, identityHash, originalExpandedIdentityHash: oldIdentity, qualityAccepted, variants, categories, paired: qualityAccepted ? paired : null, rows, calibration: calibration.public, graph: audit, resources, lineage: { originalCalls: sourceState.calls, priorDiagnosticCalls: priorDiagnostic.calls, phaseCalls: backend.calls, cumulativeKnownCalls: sourceState.calls + priorDiagnostic.calls + backend.calls, sourceCounterUnchanged: true }, limits: { reusedDevelopmentQuestions: true, sameLocalAnswererAndGrader: true, runtimeScope: managedComparisonProtocol.runtimeScope, unchangedInitialContext: true, unchangedLiteralSearch: true, noNewCompaction: true } };
    immutable(resolve(root, "public-result-managed-controller.json"), result); return result;
  } finally { store.close(); }
}
if (import.meta.main) runManagedComparison(process.argv.slice(2)).then(result => console.log(JSON.stringify({ phase: "phase" in result ? result.phase : "graded", identityHash: result.identityHash, qualityAccepted: "qualityAccepted" in result ? result.qualityAccepted : undefined }))).catch(error => { console.error(JSON.stringify({ error: safeCode(error) })); process.exitCode = 1; });

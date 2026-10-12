import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store, hash } from "../src/index.ts";
import { EvalFailure, type Backend } from "./local-memory-eval.ts";
import { longCaseHashes, longTools, type NormalizedLongCase } from "./long-history-eval.ts";
import { expandedInitialMessages, reconstructExpandedPreparation, validateExpandedBaselines, correctnessInputHash } from "./expanded-memory-comparison.ts";
import { validateNativeSupplement } from "./beam-baseline-only.ts";
import { nativeBorosInput, sourceCoverage, type ComparisonAnswer } from "./compare-long-history.ts";
import { verifyBorosEnvelope, type BorosEnvelope, type BorosInput, BOROS_REVISION } from "./boros-context-driver.ts";
import { beamGraderInstruction, createBeamCalibrationControls, parseBeamVerdict, type BeamGradeQuestion, type BeamCalibrationPublic } from "./beam-grader.ts";
import { answerManagedQuestion, managedControllerProtocol, managedDeliveredEvidence, managedInputTokens } from "./high-output-optchat-controller.ts";
import { verifyManagedCachedAnswer as verifyOriginalManagedAnswer } from "./managed-controller-comparison.ts";
import { incompleteReceiptView as originalIncompleteReceiptView } from "./managed-controller-continuation.ts";
import { verifyManagedCachedAnswer as verifyHighManagedAnswer } from "./high-output-controller-comparison.ts";
import { SolBackend, solBackendProtocol, solRequestBody, solPayloadHash, solVisibleMessage } from "./sol-responses-backend.ts";

type Messages = Parameters<Backend["complete"]>[0];
type Arm = "optchat" | "boros";
export const solComparisonProtocol = {
  version: "beam-sol-paired-memory-1", developmentOnly: true, model: "gpt-6.1-sol",
  contextTokens: 32768, outputTokens: 8192, safetyTokens: 1024, inputTokens: 23552,
  answerReasoning: "medium", graderReasoning: "low", gradeOutputTokens: 8192,
  arms: ["optchat", "boros"], questions: 20, answerCells: 40, gradeCells: 80,
  answerOrder: "Alternate the two arms in native question order. Complete all answers before grading.",
  grading: "Use the unchanged blind authored correctness rubric. Regrade forty saved Qwen candidates with the same Sol judge.",
  calibration: "Use fourteen authored positives and twenty fabricated negatives. Report six unavailable positive controls.",
  preparation: "Reuse the saved graph and exact accepted Boros source contexts. Do not run compaction or native preparation.",
  optchatController: managedControllerProtocol, borosRevision: BOROS_REVISION,
  backend: solBackendProtocol, maxCalls: 420, maxCountCalls: 3000, maxMinutes: 120, maxCostUsd: 60,
  requestTimeoutMs: 600000, retries: 0, serialRequests: true,
  transport: "Stateless Responses requests with visible conversation and paired tool results. Do not store hidden reasoning.",
  limitations: "Reused development questions, Qwen-prepared summaries, saved Boros preparations, and the same Sol answerer and grader.",
} as const;

const load = <T = any>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
const digest = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
const label = (id: string) => hash(id).slice(0, 16);
export function assertSolActive(root: string) { if (existsSync(resolve(root, "user-requested-stop.json"))) throw new EvalFailure("SOL_USER_STOPPED"); }
function privateDirectory(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
function save(root: string, path: string, value: unknown) { assertSolActive(root); privateDirectory(resolve(path, "..")); writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
function immutable(root: string, path: string, value: unknown) { if (existsSync(path)) { if (JSON.stringify(load(path)) !== JSON.stringify(value)) throw new EvalFailure("SOL_IMMUTABLE_MISMATCH"); } else save(root, path, value); }
function checkBindings(bindings: Record<string, string>) { if (Object.entries(bindings).some(([path, expected]) => digest(path) !== expected)) throw new EvalFailure("SOL_SOURCE_DRIFT"); }
const safeCode = (error: unknown) => { const code = (error as any)?.code; return typeof code === "string" && /^[A-Z_0-9]{1,64}$/.test(code) ? code : "SOL_COMPARISON_FAILURE"; };
function failFatal(error: unknown) { const code = safeCode(error); if (code.startsWith("SOL_") || ["CALL_LIMIT", "RUN_DEADLINE", "MANAGED_USER_STOPPED"].includes(code) || /^(?:TOKENIZER_|INVALID_TOKEN_COUNT|SOURCE_|SNAPSHOT_|CONCURRENT_)/.test(code)) throw error; }
function usageSince(backend: SolBackend, index: number) {
  return backend.metrics.slice(index).reduce((sum, item) => ({ inputTokens: sum.inputTokens + (item.inputTokens ?? 0), outputTokens: sum.outputTokens + (item.outputTokens ?? 0), knownCalls: sum.knownCalls + Number(item.inputTokens !== null && item.outputTokens !== null) }), { inputTokens: 0, outputTokens: 0, knownCalls: 0 });
}

export function verifySolDispatch(root: string, metric: SolBackend["metrics"][number], messages: Messages, tools: unknown[], outputTokens: number, stage: string) {
  const body = solRequestBody("gpt-6.1-sol", messages, tools, outputTokens, stage.startsWith("grade:") ? "low" : "medium"), directory = resolve(root, "calls", String(metric.call).padStart(6, "0"));
  const captured = load(resolve(directory, "input.json")), visible = load(resolve(directory, "output.json")), receipt = load(resolve(directory, "receipt.json"));
  if (metric.stage !== stage || metric.requestHash !== solPayloadHash(body) || solPayloadHash(captured) !== metric.requestHash || JSON.stringify(metric) !== JSON.stringify(receipt) || metric.maxOutputTokens !== outputTokens || metric.inputTokens !== metric.expectedInputTokens || metric.inputTokens === null || metric.inputTokens + outputTokens + 1024 > 32768 || visible.usage.input_tokens !== metric.inputTokens || visible.usage.output_tokens !== metric.outputTokens || visible.usage.total_tokens !== metric.totalTokens || visible.model !== metric.providerModel || visible.status !== metric.providerStatus) throw new EvalFailure("SOL_DISPATCH_RECEIPT_MISMATCH");
  return visible;
}
export function verifySolOptAnswer(root: string, backend: SolBackend, answer: ComparisonAnswer, initial: Messages, question: NormalizedLongCase["questions"][number], identityHash: string) {
  const metrics = backend.metrics.filter(metric => metric.stage === `answer:optchat:${question.id}` || metric.stage === `answer:optchat:${question.id}:final`), receipts = answer.private.requestReceipts as any[];
  if (!Array.isArray(receipts) || metrics.length !== receipts.length || answer.public.answerCalls !== receipts.length) throw new EvalFailure("SOL_ANSWER_RECEIPT_MISMATCH");
  const checked = structuredClone(answer); checked.private.managedIdentityHash = identityHash;
  let groupIndex = 0;
  for (const [index, receipt] of receipts.entries()) {
    const metric = metrics[index]!, stage = `answer:optchat:${question.id}${receipt.tools.length ? "" : ":final"}`;
    const visible = verifySolDispatch(root, metric, receipt.messages, receipt.tools, 8192, stage);
    if (receipt.inputTokens !== metric.inputTokens) throw new EvalFailure("SOL_ANSWER_RECEIPT_MISMATCH");
    if (receipt.providerInputTokens === undefined) {
      if (index !== receipts.length - 1 || metric.success || metric.code !== answer.public.failure || !["MODEL_OUTPUT_INCOMPLETE", "MODEL_REFUSAL"].includes(metric.code!) || answer.private.finalText !== "" || metric.code === "MODEL_OUTPUT_INCOMPLETE" && visible.status === "completed" && !visible.output.some((item: any) => item.status !== "completed")) throw new EvalFailure("SOL_FAILED_ANSWER_RECEIPT_MISMATCH");
      (checked.private.requestReceipts as any[])[index].providerInputTokens = metric.inputTokens;
    } else {
      if (receipt.providerInputTokens !== metric.inputTokens || !metric.success) throw new EvalFailure("SOL_ANSWER_RECEIPT_MISMATCH");
      const message = solVisibleMessage(visible);
      if (message.tool_calls?.length) {
        const group = (answer.private.groups as any[])[groupIndex++];
        if (JSON.stringify(group?.messages?.[0]) !== JSON.stringify(message)) throw new EvalFailure("SOL_ASSISTANT_RECEIPT_MISMATCH");
      } else if (index === receipts.length - 1 && (message.content ?? "") !== answer.private.finalText) throw new EvalFailure("SOL_ASSISTANT_RECEIPT_MISMATCH");
    }
  }
  if (groupIndex !== (answer.private.groups as any[]).length) throw new EvalFailure("SOL_ASSISTANT_RECEIPT_MISMATCH");
  verifyHighManagedAnswer(checked, initial, identityHash, question);
}

export function solGradeMessages(question: BeamGradeQuestion, candidate: string): Messages {
  const input = { question: question.question, category: question.category, referenceAnswer: question.referenceAnswer, nativeRubric: question.rubric,
    ...(question.nativeAuthorReference !== undefined ? { nativeAuthorReference: question.nativeAuthorReference } : {}),
    ...(question.idealSummary !== undefined ? { authoredIdealSummary: question.idealSummary } : {}), candidate };
  return [{ role: "system", content: beamGraderInstruction }, { role: "user", content: JSON.stringify(input) }];
}
export async function gradeSolCandidate(backend: SolBackend, question: BeamGradeQuestion, candidate: string, cellId: string, identityHash: string) {
  const messages = solGradeMessages(question, candidate), inputHash = hash(JSON.stringify(messages)), before = backend.calls, metric = backend.metrics.length, stage = `grade:${cellId}`;
  if (inputHash !== correctnessInputHash(question, candidate)) throw new EvalFailure("SOL_JUDGE_PROMPT_MISMATCH");
  const inputTokens = await backend.countRequestTokens(messages, [], 8192, stage);
  let output = "", verdict = null as ReturnType<typeof parseBeamVerdict>, failure: string | null = null;
  try {
    if (inputTokens > managedInputTokens) throw new EvalFailure("GRADER_CONTEXT_BUDGET");
    const result = await backend.complete(messages, [], stage, 8192);
    if (result.inputTokens !== inputTokens) throw new EvalFailure("TOKENIZER_COUNT_MISMATCH");
    if (result.message.tool_calls?.length) throw new EvalFailure("GRADER_TOOL_CALL");
    output = result.message.content ?? ""; verdict = parseBeamVerdict(output);
    if (!verdict || verdict.grounded !== null) throw new EvalFailure("GRADER_FORMAT");
  } catch (error) { failFatal(error); failure = safeCode(error); verdict = null; }
  return { binding: { identityHash, cellId, inputHash, candidateHash: hash(candidate) }, public: { valid: Number(verdict !== null), correct: verdict ? Number(verdict.correct) : null, confidenceHigh: verdict ? Number(verdict.confidence === "high") : null, failure },
    private: { messages, output, outputHash: hash(output), verdict }, inputTokens, outputTokens: 8192, calls: backend.calls - before, usage: usageSince(backend, metric) };
}
export function verifySolGrade(grade: Awaited<ReturnType<typeof gradeSolCandidate>>, question: BeamGradeQuestion, candidate: string, cellId: string, identityHash: string) {
  const messages = solGradeMessages(question, candidate), verdict = parseBeamVerdict(grade.private.output);
  if (JSON.stringify(grade.binding) !== JSON.stringify({ identityHash, cellId, inputHash: hash(JSON.stringify(messages)), candidateHash: hash(candidate) }) || JSON.stringify(messages) !== JSON.stringify(grade.private.messages) || grade.outputTokens !== 8192 || grade.inputTokens > 23552 || grade.private.outputHash !== hash(grade.private.output) || grade.public.valid !== Number(grade.private.verdict !== null) || grade.private.verdict && (JSON.stringify(verdict) !== JSON.stringify(grade.private.verdict) || verdict?.grounded !== null || grade.public.failure !== null || grade.public.correct !== Number(verdict?.correct) || grade.public.confidenceHigh !== Number(verdict?.confidence === "high")) || !grade.private.verdict && !grade.public.failure) throw new EvalFailure("SOL_GRADE_MISMATCH");
  if (!Number.isSafeInteger(grade.inputTokens) || grade.inputTokens < 0 || !Number.isSafeInteger(grade.calls) || grade.calls < 0 || grade.calls > 1 || grade.private.verdict && (grade.calls !== 1 || grade.usage.knownCalls !== 1 || grade.usage.inputTokens !== grade.inputTokens) || !grade.private.verdict && (grade.public.correct !== null || grade.public.confidenceHigh !== null)) throw new EvalFailure("SOL_GRADE_MISMATCH");
}

async function answerBoros(backend: SolBackend, question: NormalizedLongCase["questions"][number], oldAnswer: ComparisonAnswer) {
  const messages = structuredClone(oldAnswer.private.messages as Messages), before = backend.calls, metric = backend.metrics.length, started = Date.now();
  const inputTokens = await backend.countRequestTokens(messages, [], 8192, `answer:boros:${question.id}`);
  let finalText = "", failure: string | null = null;
  try {
    if (inputTokens > managedInputTokens) throw new EvalFailure("ANSWER_CONTEXT_BUDGET");
    const result = await backend.complete(messages, [], `answer:boros:${question.id}`, 8192);
    if (result.inputTokens !== inputTokens) throw new EvalFailure("TOKENIZER_COUNT_MISMATCH");
    if (result.message.tool_calls?.length) throw new EvalFailure("UNEXPECTED_TOOL_CALL");
    finalText = result.message.content ?? "";
    if (!finalText.trim()) failure = "EMPTY_ANSWER";
  } catch (error) { failFatal(error); failure = safeCode(error); }
  return { public: { questionId: question.id, category: question.category, questionHash: hash(question.question), arm: "boros", failure, steps: backend.calls - before, finalizationCalls: 0, latencyMs: Date.now() - started,
    maxRequestTokenBound: backend.calls > before ? inputTokens : 0, answerCalls: backend.calls - before, answerUsage: usageSince(backend, metric), nativePreparedBodyHash: oldAnswer.public.nativePreparedBodyHash, selectionHash: oldAnswer.public.selectionHash },
    private: { finalText, messages, submittedMessages: messages, deliveredEvidence: structuredClone(oldAnswer.private.deliveredEvidence), inputTokens, outputTokens: 8192 } } as ComparisonAnswer;
}

async function preflight(backend: SolBackend, root: string, identityHash: string) {
  const path = resolve(root, "provider-preflight.json");
  if (existsSync(path)) { const saved = load(path); if (saved.identityHash !== identityHash || saved.accepted !== true) throw new EvalFailure("SOL_PREFLIGHT_MISMATCH"); return; }
  const fixtureTools = [{ type: "function", function: { name: "synthetic_lookup", description: "Return a synthetic fixture value.", parameters: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false } } }];
  const initial: Messages = [{ role: "system", content: "Use the supplied function exactly once. After its result, answer with one word." }, { role: "user", content: "Call synthetic_lookup with label fixture. After the result, return the supplied value." }];
  const first = await backend.complete(initial, fixtureTools, "preflight:tool", 8192);
  if (first.message.tool_calls?.length !== 1 || first.message.tool_calls[0]!.function.name !== "synthetic_lookup" || JSON.stringify(JSON.parse(first.message.tool_calls[0]!.function.arguments)) !== JSON.stringify({ label: "fixture" })) throw new EvalFailure("SOL_PREFLIGHT_TOOL_MISMATCH");
  const next: Messages = [...initial, first.message, { role: "tool", tool_call_id: first.message.tool_calls[0]!.id, content: JSON.stringify({ value: "ready" }) }];
  const second = await backend.complete(next, [], "preflight:answer", 8192);
  if (second.message.tool_calls?.length || second.message.content?.trim().toLowerCase().replace(/[.!]/g, "") !== "ready") throw new EvalFailure("SOL_PREFLIGHT_CONTINUATION_MISMATCH");
  save(root, path, { identityHash, accepted: true, calls: 2, initialHash: hash(JSON.stringify(initial)), continuationHash: hash(JSON.stringify(next)), firstInputTokens: first.inputTokens, secondInputTokens: second.inputTokens, outputTokens: 8192, hiddenReasoningStored: false });
}

function summarize(rows: Record<string, any>[], accepted: boolean) {
  return { questions: rows.length, correct: accepted ? rows.filter(row => row.correct === 1 && !row.failure).length : null, failures: rows.filter(row => row.failure).length,
    nonemptyAnswers: rows.filter(row => row.nonempty).length, invalidGrades: rows.filter(row => row.valid !== 1).length, lowConfidence: rows.filter(row => row.confidenceHigh !== 1).length,
    answerCalls: rows.reduce((sum, row) => sum + (row.answerCalls ?? 0), 0), answerInputTokens: rows.reduce((sum, row) => sum + (row.answerUsage?.inputTokens ?? 0), 0), answerOutputTokens: rows.reduce((sum, row) => sum + (row.answerUsage?.outputTokens ?? 0), 0),
    deliveredGoldSources: rows.reduce((sum, row) => sum + (row.deliveredGoldSources ?? 0), 0), completeGoldSources: rows.reduce((sum, row) => sum + (row.fullyDeliveredGoldSources ?? 0), 0) };
}

export async function runSolComparison(args: string[]) {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) { if (!["--run", "--source-run", "--managed-run", "--case", "--supplement", "--key-file", "--mode"].includes(args[index]!) || !args[index + 1] || flags.has(args[index]!)) throw new EvalFailure("INVALID_CLI"); flags.set(args[index]!, args[index + 1]!); }
  if (["--run", "--source-run", "--managed-run", "--case", "--supplement", "--key-file", "--mode"].some(flag => !flags.has(flag)) || !["freeze", "preflight", "answers", "grade"].includes(flags.get("--mode")!)) throw new EvalFailure("EXPLICIT_SOL_CONFIG_REQUIRED");
  const root = resolve(flags.get("--run")!), repository = resolve(import.meta.dir, ".."), mode = flags.get("--mode")!;
  assertSolActive(root);
  if (!root.startsWith(resolve(repository, ".optchat") + "/")) throw new EvalFailure("SOL_PRIVATE_RUN_REQUIRED");
  const sourceRoot = realpathSync(resolve(flags.get("--source-run")!)), managedRoot = realpathSync(resolve(flags.get("--managed-run")!)), casePath = realpathSync(resolve(flags.get("--case")!)), supplementPath = realpathSync(resolve(flags.get("--supplement")!));
  if (root === sourceRoot || root === managedRoot) throw new EvalFailure("SOL_PRIVATE_COPY_REQUIRED");
  const oldFreezePath = resolve(sourceRoot, "expanded-comparison-freeze.json"), old = load(oldFreezePath), oldIdentity = hash(JSON.stringify(old));
  if (oldIdentity !== "be518edb91187148eccac0a5943ba992f8597405c5457a53d5648aaffe7d4330" || digest(casePath) !== old.caseFileHash || digest(supplementPath) !== old.supplementHash || digest(resolve(repository, "scripts/expanded-memory-comparison.ts")) !== old.sourceHash || Object.entries(old.dependencyHashes).some(([path, value]) => digest(resolve(repository, path)) !== value)) throw new EvalFailure("SOL_ORIGINAL_MISMATCH");
  const data = load<NormalizedLongCase>(casePath), supplement = load(supplementPath);
  validateNativeSupplement(supplement, data, digest(casePath));
  if (data.questions.length !== 20 || longCaseHashes(data).caseHash !== old.caseHash) throw new EvalFailure("SOL_CASE_MISMATCH");
  const questions = data.questions.map(question => ({ ...question, nativeAuthorReference: supplement.questions[question.id] }));
  const sourceBindings: Record<string, string> = {};
  const bind = (path: string) => { sourceBindings[path] = digest(path); };
  [oldFreezePath, casePath, supplementPath, import.meta.path, resolve(repository, "scripts/sol-responses-backend.ts"), resolve(repository, "scripts/high-output-controller-comparison.ts"), resolve(repository, "scripts/high-output-local-backend.ts"), resolve(repository, "scripts/high-output-optchat-controller.ts"), resolve(repository, "scripts/managed-controller-comparison.ts"), resolve(repository, "scripts/managed-optchat-controller.ts"), resolve(repository, "scripts/managed-controller-continuation.ts"), resolve(repository, "docs/evaluation/sol-paired-protocol.md"), ...Object.keys(old.dependencyHashes).map(path => resolve(repository, path)), resolve(repository, "scripts/expanded-memory-comparison.ts")].forEach(bind);
  const originalStatePath = resolve(sourceRoot, "backend-state.json"), diagnosticStatePath = resolve(repository, ".optchat/boros-confirm-01/backend-state.json"), managedStatePath = resolve(managedRoot, "backend-state.json"), managedFreezePath = resolve(managedRoot, "managed-controller-freeze.json"), managedAmendmentPath = resolve(managedRoot, "managed-controller-continuation-freeze.json"), managedStopPath = resolve(managedRoot, "user-requested-stop.json");
  [originalStatePath, diagnosticStatePath, managedStatePath, managedFreezePath, managedAmendmentPath, managedStopPath, resolve(managedRoot, "public-result-managed-controller.json")].forEach(bind);
  const previousCalls = { original: load(originalStatePath).calls, diagnostic: load(diagnosticStatePath).calls, managed: load(managedStatePath).calls };
  if (previousCalls.original !== 2628 || previousCalls.diagnostic !== 95 || previousCalls.managed !== 196) throw new EvalFailure("SOL_LINEAGE_MISMATCH");
  const managedFreeze = load(managedFreezePath), amendment = load(managedAmendmentPath), managedIdentity = hash(JSON.stringify(managedFreeze)), managedState = load(managedStatePath);
  checkBindings(managedFreeze.sourceBindings); checkBindings(amendment.sourceBindings);
  const baselines = validateExpandedBaselines(sourceRoot, data, old.baselineIdentityHash).filter(row => row.arm === "boros"), savedCandidates: { question: BeamGradeQuestion; arm: Arm; answer: ComparisonAnswer }[] = [];
  const checkedOriginals: { question: NormalizedLongCase["questions"][number]; answer: ComparisonAnswer }[] = [];
  const contextHashes: Record<string, string> = {};
  for (const question of questions) {
    const id = label(question.id), contextPath = resolve(sourceRoot, "boros-contexts", id, "accepted.json"), accepted = load<{ input: BorosInput; envelope: BorosEnvelope }>(contextPath);
    if (JSON.stringify(accepted.input) !== JSON.stringify(nativeBorosInput(data, question, accepted.input.arms)) || digest(contextPath) !== old.contextHashes[id]) throw new EvalFailure("SOL_BOROS_CONTEXT_MISMATCH");
    verifyBorosEnvelope(accepted.envelope, accepted.input); bind(contextPath); contextHashes[id] = digest(contextPath);
    const boros = baselines.find(row => row.question.id === question.id)!;
    bind(resolve(sourceRoot, "baseline-answers", `${boros.name}.json`)); savedCandidates.push({ question, arm: "boros", answer: boros.answer });
    const path = resolve(managedRoot, "managed-answers", `${id}.json`), answer = load<ComparisonAnswer>(path); bind(path);
    let checked = answer;
    if (answer.public.failure === "MODEL_OUTPUT_INCOMPLETE") {
      const metric = managedState.metrics.filter((item: any) => item.stage === `answer:optchat:${question.id}:final`).at(-1);
      const capture = resolve(managedRoot, "calls", metric.invocation, String(metric.call).padStart(6, "0")), inputPath = resolve(capture, "call-000-input.json"), outputPath = resolve(capture, "call-000-output.json");
      checked = originalIncompleteReceiptView(answer, load(inputPath), load(outputPath), metric, question.id); bind(inputPath); bind(outputPath);
    }
    checkedOriginals.push({ question, answer: checked });
    savedCandidates.push({ question, arm: "optchat", answer });
  }
  privateDirectory(root);
  const database = resolve(root, "memory.sqlite"), sourceDatabase = resolve(sourceRoot, "memory.sqlite"), copyPath = resolve(root, "database-copy.json");
  const databaseBindings = Object.fromEntries([sourceDatabase, `${sourceDatabase}-wal`].filter(existsSync).map(path => [path, digest(path)]));
  if (!existsSync(copyPath)) {
    if (existsSync(database)) throw new EvalFailure("SOL_COPY_INCOMPLETE");
    const reader = new Database(sourceDatabase, { readonly: true }); try { reader.run("VACUUM INTO ?", [database]); } finally { reader.close(); }
    chmodSync(database, 0o600); save(root, copyPath, { sourceBindings: databaseBindings, copiedHash: digest(database) });
  }
  const copy = load(copyPath); if (JSON.stringify(copy.sourceBindings) !== JSON.stringify(databaseBindings) || statSync(database).ino === statSync(sourceDatabase).ino && statSync(database).dev === statSync(sourceDatabase).dev) throw new EvalFailure("SOL_COPY_MISMATCH");
  Object.assign(sourceBindings, databaseBindings); bind(copyPath);
  const store = new Store(database);
  try {
    const { prepared, audit } = reconstructExpandedPreparation(store, data);
    if (JSON.stringify(audit.durableHashes) !== JSON.stringify(old.graph.durableHashes) || audit.snapshotHash !== old.graph.snapshotHash || audit.projectionBytes !== old.graph.projectionBytes || audit.compactionCalls !== 0) throw new EvalFailure("SOL_GRAPH_MISMATCH");
    for (const row of checkedOriginals) verifyOriginalManagedAnswer(row.answer, expandedInitialMessages(prepared, row.question).messages, managedIdentity, row.question);
    const selected = createBeamCalibrationControls(questions), cells = questions.map(question => ({ questionLabel: label(question.id), category: question.category, optchatInitialHash: hash(JSON.stringify(expandedInitialMessages(prepared, question).messages)), borosMessagesHash: hash(JSON.stringify(baselines.find(row => row.question.id === question.id)!.answer.private.messages)) }));
    checkBindings(sourceBindings);
    const freeze = { protocol: solComparisonProtocol, originalIdentity: oldIdentity, managedIdentity, caseHash: old.caseHash, sourceBindings, graph: audit, contextHashes, cells, controls: selected.controls.map(control => ({ idHash: hash(control.id), kind: control.kind, inputHash: correctnessInputHash(control.question, control.candidate), candidateHash: hash(control.candidate) })), previousCalls };
    immutable(root, resolve(root, "sol-comparison-freeze.json"), freeze); const identityHash = hash(JSON.stringify(freeze));
    if (mode === "freeze") return { phase: "frozen", identityHash, answerCells: 40, gradeCells: 80 };
    const backend = new SolBackend({ directory: root, keyFile: flags.get("--key-file")!, maxCalls: 420, maxCountCalls: 3000, maxMinutes: 120, maxCostUsd: 60, requestTimeoutMs: 600000 });
    const phaseCheck = () => { assertSolActive(root); checkBindings(sourceBindings); if (backend.haltedCode) throw new EvalFailure(backend.haltedCode); };
    const controllerFatal = (error: unknown): never => { const code = safeCode(error); if (code.startsWith("SOL_")) throw new EvalFailure(code === "SOL_USER_STOPPED" ? "MANAGED_USER_STOPPED" : "CALL_LIMIT"); throw error; };
    const counted = async (messages: Messages, tools: unknown[], output: number) => { try { phaseCheck(); return await backend.countRequestTokens(messages, tools, output, "answer"); } catch (error) { return controllerFatal(error); } };
    const complete = backend.complete.bind(backend); backend.complete = async (...parameters) => { phaseCheck(); return complete(...parameters); };
    const controllerBackend: Backend = { async complete(...parameters) { try { return await backend.complete(...parameters); } catch (error) { return controllerFatal(error); } } };
    await preflight(backend, root, identityHash);
    if (mode === "preflight") return { phase: "preflight-complete", identityHash, calls: backend.calls, countCalls: backend.countCalls, conservativeCostUsd: backend.costUsd };
    const answers: { question: BeamGradeQuestion; arm: Arm; answer: ComparisonAnswer }[] = [];
    for (const [index, question] of questions.entries()) for (const arm of (index % 2 ? ["boros", "optchat"] : ["optchat", "boros"]) as Arm[]) {
      phaseCheck(); const cellId = `${label(question.id)}-${arm}`, path = resolve(root, "sol-answers", `${cellId}.json`);
      if (!existsSync(path)) {
        if (mode !== "answers") throw new EvalFailure("SOL_ANSWERS_INCOMPLETE");
        const before = backend.calls, metric = backend.metrics.length;
        const answer = arm === "optchat" ? await answerManagedQuestion(controllerBackend, prepared, question, { countRequestTokens: counted }) : await answerBoros(backend, question, baselines.find(row => row.question.id === question.id)!.answer);
        Object.assign(answer.public, { answerCalls: backend.calls - before, answerUsage: usageSince(backend, metric) }, sourceCoverage(question, answer, data));
        if (arm === "optchat") {
          const seen = managedDeliveredEvidence(answer as any, prepared, (answer.private.requestReceipts as any[]).flatMap(receipt => receipt.messages));
          const seenCoverage = sourceCoverage(question, { ...answer, private: { ...answer.private, deliveredEvidence: seen } }, data);
          Object.assign(answer.private, { modelSeenEvidence: seen }); Object.assign(answer.public, { modelSeenGoldSources: seenCoverage.deliveredGoldSources, modelSeenCompleteGoldSources: seenCoverage.fullyDeliveredGoldSources });
        }
        Object.assign(answer.private, { solIdentityHash: identityHash }); save(root, path, answer);
      }
      const answer = load<ComparisonAnswer>(path);
      if (answer.private.solIdentityHash !== identityHash || answer.public.questionHash !== hash(question.question) || answer.public.arm !== arm || answer.public.category !== question.category || answer.public.maxRequestTokenBound > 23552 || answer.private.finalText.trim() && answer.public.failure) throw new EvalFailure("SOL_ANSWER_MISMATCH");
      if (arm === "boros" && JSON.stringify(answer.private.messages) !== JSON.stringify(baselines.find(row => row.question.id === question.id)!.answer.private.messages)) throw new EvalFailure("SOL_BOROS_CONTEXT_MISMATCH");
      if (arm === "optchat") {
        verifySolOptAnswer(root, backend, answer, expandedInitialMessages(prepared, question).messages, question, identityHash);
        const delivered = managedDeliveredEvidence(answer as any, prepared, answer.private.submittedMessages as Messages), seen = managedDeliveredEvidence(answer as any, prepared, (answer.private.requestReceipts as any[]).flatMap(receipt => receipt.messages));
        if (JSON.stringify(delivered) !== JSON.stringify(answer.private.deliveredEvidence) || JSON.stringify(seen) !== JSON.stringify(answer.private.modelSeenEvidence)) throw new EvalFailure("SOL_EVIDENCE_MISMATCH");
      } else {
        const metrics = backend.metrics.filter(metric => metric.stage === `answer:boros:${question.id}`);
        if (metrics.length !== answer.public.answerCalls || metrics.length > 1) throw new EvalFailure("SOL_ANSWER_RECEIPT_MISMATCH");
        if (metrics.length) {
          const visible = verifySolDispatch(root, metrics[0]!, answer.private.messages as Messages, [], 8192, `answer:boros:${question.id}`);
          const visibleText = visible.output.filter((item: any) => item.type === "message").map((item: any) => item.content.filter((part: any) => part.type === "output_text").map((part: any) => part.text).join("")).join("\n");
          if (metrics[0]!.success ? answer.private.finalText !== visibleText : answer.private.finalText !== "" || metrics[0]!.code !== answer.public.failure) throw new EvalFailure("SOL_ANSWER_RECEIPT_MISMATCH");
        }
      }
      if (Object.entries(sourceCoverage(question, answer, data)).some(([field, value]) => answer.public[field] !== value)) throw new EvalFailure("SOL_EVIDENCE_MISMATCH");
      immutable(root, resolve(root, "sol-answer-ledger", `${cellId}.json`), { identityHash, fileHash: digest(path), candidateHash: hash(answer.private.finalText) });
      answers.push({ question, arm, answer }); phaseCheck();
      console.log(JSON.stringify({ phase: "sol-answer", completed: answers.length, total: 40, arm, failure: answer.public.failure ?? null, calls: backend.calls, countCalls: backend.countCalls }));
    }
    if (mode === "answers") return { phase: "answers-complete", identityHash, answerCells: answers.length, calls: backend.calls, countCalls: backend.countCalls, costUsd: backend.costUsd };
    const controlRows: { kind: string; grade: Awaited<ReturnType<typeof gradeSolCandidate>> }[] = [];
    for (const control of selected.controls) {
      phaseCheck(); const cellId = `control-${hash(control.id).slice(0, 24)}`, path = resolve(root, "sol-controls", `${cellId}.json`);
      if (!existsSync(path)) save(root, path, await gradeSolCandidate(backend, control.question, control.candidate, cellId, identityHash));
      const grade = load<Awaited<ReturnType<typeof gradeSolCandidate>>>(path); verifySolGrade(grade, control.question, control.candidate, cellId, identityHash);
      const metric = backend.metrics.find(metric => metric.stage === `grade:${cellId}`);
      if (grade.calls === 1 && (!metric || solVisibleMessage(verifySolDispatch(root, metric, grade.private.messages, [], 8192, `grade:${cellId}`)).content !== grade.private.output)) throw new EvalFailure("SOL_GRADE_RECEIPT_MISMATCH");
      controlRows.push({ kind: control.kind, grade });
    }
    const calibration: BeamCalibrationPublic = { ...selected.public, positivesAccepted: controlRows.filter(row => row.kind === "positive" && row.grade.public.correct === 1).length, negativesRejected: controlRows.filter(row => row.kind === "negative" && row.grade.public.correct === 0).length, invalidCount: controlRows.filter(row => row.grade.public.valid !== 1).length, lowConfidenceCount: controlRows.filter(row => row.grade.public.confidenceHigh !== 1).length, accepted: 0 };
    calibration.accepted = Number(calibration.positivesAccepted === calibration.positiveCount && calibration.negativesRejected === calibration.negativeCount && calibration.invalidCount === 0) as 0 | 1;
    immutable(root, resolve(root, "sol-calibration.json"), calibration);
    console.log(JSON.stringify({ phase: "sol-calibration", ...calibration, calls: backend.calls }));
    const rows: Record<string, any>[] = [];
    for (const [index, question] of questions.entries()) {
      const order = index % 2 ? ["saved-boros", "sol-boros", "saved-optchat", "sol-optchat"] : ["sol-optchat", "saved-optchat", "sol-boros", "saved-boros"];
      for (const variant of order) {
        phaseCheck(); const arm = variant.endsWith("optchat") ? "optchat" : "boros", isSaved = variant.startsWith("saved"), answer = (isSaved ? savedCandidates : answers).find(row => row.question.id === question.id && row.arm === arm)!.answer;
        const cellId = `${label(question.id)}-${variant}`, path = resolve(root, "sol-grades", `${cellId}.json`);
        if (!existsSync(path)) save(root, path, await gradeSolCandidate(backend, question, answer.private.finalText, cellId, identityHash));
        const grade = load<Awaited<ReturnType<typeof gradeSolCandidate>>>(path); verifySolGrade(grade, question, answer.private.finalText, cellId, identityHash);
        const metric = backend.metrics.find(metric => metric.stage === `grade:${cellId}`);
        if (grade.calls === 1 && (!metric || solVisibleMessage(verifySolDispatch(root, metric, grade.private.messages, [], 8192, `grade:${cellId}`)).content !== grade.private.output)) throw new EvalFailure("SOL_GRADE_RECEIPT_MISMATCH");
        immutable(root, resolve(root, "sol-grade-ledger", `${cellId}.json`), { identityHash, candidateHash: hash(answer.private.finalText), fileHash: digest(path) });
        rows.push({ questionLabel: label(question.id), category: question.category, variant, arm, failure: answer.public.failure ?? null, nonempty: !!answer.private.finalText.trim(), answerHash: hash(answer.private.finalText), valid: grade.public.valid, confidenceHigh: grade.public.confidenceHigh, correctnessVerdict: grade.public.correct, gradingFailure: grade.public.failure, answerCalls: answer.public.answerCalls, answerUsage: answer.public.answerUsage, deliveredGoldSources: answer.public.deliveredGoldSources, fullyDeliveredGoldSources: answer.public.fullyDeliveredGoldSources, modelSeenGoldSources: answer.public.modelSeenGoldSources ?? null, gradeUsage: grade.usage });
        console.log(JSON.stringify({ phase: "sol-grade", completed: rows.length, total: 80, valid: grade.public.valid, calls: backend.calls }));
      }
    }
    phaseCheck(); const accepted = calibration.accepted === 1 && calibration.lowConfidenceCount === 0 && rows.length === 80 && rows.every(row => row.valid === 1 && row.confidenceHigh === 1 && !/^(?:SOL_|TOKENIZER_|SOURCE_)/.test(row.failure ?? ""));
    for (const row of rows) row.correct = accepted ? Number(row.correctnessVerdict === 1 && !row.failure) : null;
    const variants = Object.fromEntries(["sol-optchat", "sol-boros", "saved-optchat", "saved-boros"].map(variant => [variant, summarize(rows.filter(row => row.variant === variant), accepted)]));
    const categories = Object.fromEntries([...new Set(questions.map(question => question.category))].map(category => [category, Object.fromEntries(["sol-optchat", "sol-boros"].map(variant => [variant, summarize(rows.filter(row => row.category === category && row.variant === variant), accepted)]))]));
    const paired = { bothCorrect: 0, optchatOnly: 0, borosOnly: 0, neitherCorrect: 0 };
    if (accepted) for (const cell of cells) { const opt = rows.find(row => row.variant === "sol-optchat" && row.questionLabel === cell.questionLabel)!, boros = rows.find(row => row.variant === "sol-boros" && row.questionLabel === cell.questionLabel)!; if (opt.correct && boros.correct) paired.bothCorrect++; else if (opt.correct) paired.optchatOnly++; else if (boros.correct) paired.borosOnly++; else paired.neitherCorrect++; }
    const result = { version: solComparisonProtocol.version, identityHash, qualityAccepted: accepted, variants, categories, paired: accepted ? paired : null, calibration, rows, graph: audit, protocol: solComparisonProtocol, usage: { calls: backend.calls, countCalls: backend.countCalls, conservativeCostUsd: backend.costUsd }, lineage: { ...previousCalls, priorTotal: 2919, newSolCalls: backend.calls, cumulativeKnownCalls: 2919 + backend.calls }, limitations: solComparisonProtocol.limitations };
    immutable(root, resolve(root, "public-result-sol-comparison.json"), result); return result;
  } finally { store.close(); }
}
if (import.meta.main) runSolComparison(process.argv.slice(2)).then(result => console.log(JSON.stringify({ phase: "phase" in result ? result.phase : "graded", identityHash: result.identityHash, qualityAccepted: "qualityAccepted" in result ? result.qualityAccepted : undefined }))).catch(error => { console.error(JSON.stringify({ code: safeCode(error) })); process.exitCode = 1; });

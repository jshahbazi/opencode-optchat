import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytes, hash } from "../src/index.ts";
import { EvalFailure } from "./local-memory-eval.ts";
import { ResumableLocalBackend } from "./long-history-eval.ts";
import { QWEN_MODEL } from "./boros-context-driver.ts";
import { verifyExpandedCalibration } from "./expanded-memory-comparison.ts";
import { answerDiagnosticRequest, gradeDiagnosticCandidate, verifyDiagnosticAnswer, verifyDiagnosticGrade } from "./boros-context-diagnostics.ts";
import { createQwenRequestTokenizer, createRawQwenRequestTokenizer } from "./qwen-request-tokenizer.ts";

export const confirmationProtocol = { version: "boros-diagnostic-confirmation-1", developmentOnly: true,
  knowledgeLabel: "cf558e1152a1b36e", knowledgeConditions: ["native_repeat_1", "evidence_review", "without_recent"],
  contradictionLabel: "cfe976a3493c9ea5", overviewCondition: "saved_overview", repeats: 2,
  overviewPolicy: "Append the exact saved shared-node interior inside a new untrusted overview tag. Preserve every original native message.",
  interpretation: "The overview combines derived evidence, length, and system presentation. It does not isolate tree causality.",
  answersBeforeGrades: true, answerCells: 8, gradeCells: 8, newCalls: 16, inheritedPhaseCalls: 79,
  maxCalls: 120, phaseMinutes: 30, contextTokens: 32768, answerTokens: 2048, gradeTokens: 384, safetyTokens: 1024,
  counters: "Copy the existing backend state. Retain its counter, start, and deadline. Never extend the phase.",
  temperature: 0, thinking: false, tools: false, retries: 0, serialCalls: true,
} as const;
const overviewTag = "\n<untrusted-historical-overview>\n";
const load = <T = any>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
const digest = (path: string) => hash(readFileSync(path, "utf8"));
function save(path: string, value: unknown) { const directory = resolve(path, ".."); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
function immutable(path: string, value: unknown) { if (existsSync(path)) { if (JSON.stringify(load(path)) !== JSON.stringify(value)) throw new EvalFailure("CONFIRMATION_IMMUTABLE_MISMATCH"); } else save(path, value); }
function checkBindings(bindings: Record<string, string>) { if (Object.entries(bindings).some(([path, expected]) => digest(path) !== expected)) throw new EvalFailure("CONFIRMATION_SOURCE_DRIFT"); }
function safeCode(error: unknown) { const value = (error as { code?: unknown })?.code; return typeof value === "string" && /^[A-Z_0-9]{1,64}$/.test(value) ? value : "CONFIRMATION_FAILURE"; }

export function extractSavedOverview(answer: any, expandedIdentityHash: string) {
  const system = answer?.private?.requestReceipts?.[0]?.messages?.[0]?.content, marker = "\nHISTORICAL_DATA:\n";
  if (answer?.private?.expandedIdentityHash !== expandedIdentityHash || answer?.public?.questionHash === undefined || typeof system !== "string" || system.split(marker).length !== 2) throw new EvalFailure("CONFIRMATION_OVERVIEW_MISMATCH");
  const overview = system.slice(system.indexOf(marker) + marker.length), shared = overview.match(/<optchat-shared-data>\n([\s\S]*?)<\/optchat-shared-data>/), own = overview.match(/<optchat-own-data>\n([\s\S]*?)<\/optchat-own-data>/);
  if (!shared || !own || bytes(shared[1]!) !== 35577 || own[1] !== "" || bytes(overview) !== 35941) throw new EvalFailure("CONFIRMATION_OVERVIEW_MISMATCH");
  return { fullPayload: overview, sharedNodes: shared[1]! };
}
export function appendSavedOverview(messages: Parameters<ResumableLocalBackend["complete"]>[0], overview: string) {
  const result = structuredClone(messages);
  if (result[0]?.role !== "system" || typeof result[0]?.content !== "string" || !overview || result.at(-1)?.role !== "user") throw new EvalFailure("CONFIRMATION_NATIVE_SHAPE_MISMATCH");
  result[0]!.content += overviewTag + overview + "</untrusted-historical-overview>"; return result;
}
export function confirmationBackendCopy(sourceRoot: string, root: string, sourceStateHash: string, sourceResources: any) {
  const sourcePath = resolve(sourceRoot, "backend-state.json"), path = resolve(root, "backend-state.json"), source = load(sourcePath);
  if (digest(sourcePath) !== sourceStateHash || source.calls !== 79 || source.startedAt !== sourceResources.startedAt || sourceResources.deadlineAt !== source.startedAt + 30 * 60000 || sourceResources.maxCalls !== 120) throw new EvalFailure("CONFIRMATION_RESOURCE_MISMATCH");
  const lineage = { sourceStateHash, inheritedCalls: 79, startedAt: source.startedAt, deadlineAt: sourceResources.deadlineAt, maxCalls: 120, sourceStartedAt: sourceResources.sourceStartedAt, originalCalls: sourceResources.inheritedCalls };
  if (!existsSync(path)) { mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700); copyFileSync(sourcePath, path); chmodSync(path, 0o600); }
  const state = load(path);
  if (state.startedAt !== source.startedAt || state.calls < 79 || state.calls > 120 || JSON.stringify(state.metrics.slice(0, source.metrics.length)) !== JSON.stringify(source.metrics)) throw new EvalFailure("CONFIRMATION_RESOURCE_MISMATCH");
  immutable(resolve(root, "confirmation-copy.json"), lineage); return lineage;
}

export async function runConfirmation(args: string[]) {
  const flags = new Map<string, string>(); for (let i = 0; i < args.length; i += 2) { if (!["--source-run", "--expanded-run", "--run", "--mode"].includes(args[i]!) || !args[i + 1] || flags.has(args[i]!)) throw new EvalFailure("INVALID_CLI"); flags.set(args[i]!, args[i + 1]!); }
  const sourceArg = flags.get("--source-run"), expandedArg = flags.get("--expanded-run"), rootArg = flags.get("--run"), mode = flags.get("--mode");
  if (!sourceArg || !expandedArg || !rootArg || !["freeze", "answers", "grade"].includes(mode ?? "")) throw new EvalFailure("EXPLICIT_CONFIRMATION_CONFIG_REQUIRED");
  const sourceRoot = realpathSync(resolve(sourceArg)), expandedRoot = realpathSync(resolve(expandedArg)), root = resolve(rootArg), repository = resolve(import.meta.dir, "..");
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  if (!realpathSync(root).startsWith(resolve(repository, ".optchat") + "/") || [sourceRoot, expandedRoot].includes(realpathSync(root))) throw new EvalFailure("CONFIRMATION_PRIVATE_DIRECTORY_REQUIRED");
  const firstFreezePath = resolve(sourceRoot, "diagnostic-freeze.json"), firstResultPath = resolve(sourceRoot, "public-result-boros-diagnostics.json"), firstStatePath = resolve(sourceRoot, "backend-state.json"), resourcePath = resolve(sourceRoot, "diagnostic-resources.json"), first = load(firstFreezePath), firstResult = load(firstResultPath), resources = load(resourcePath), expandedFreezePath = resolve(expandedRoot, "expanded-comparison-freeze.json"), expandedFreeze = load(expandedFreezePath), expandedIdentityHash = hash(JSON.stringify(expandedFreeze));
  if (hash(JSON.stringify(first)) !== "4b5b6c5de2cab4d7d298cc1ed38b023c5273eebacad1420f189ff00e3cba3376" || firstResult.diagnosticIdentityHash !== hash(JSON.stringify(first)) || !firstResult.qualityAccepted || firstResult.lineage.phaseCalls !== 79 || first.originalExpandedIdentityHash !== expandedIdentityHash) throw new EvalFailure("CONFIRMATION_FIRST_WAVE_MISMATCH");
  checkBindings(first.sourceBindings);
  const tokenizer = await createQwenRequestTokenizer({ directory: expandedRoot }), renderer = createRawQwenRequestTokenizer();
  if (JSON.stringify(tokenizer.identity) !== JSON.stringify(first.tokenizerIdentity) || Object.entries(renderer.identity).some(([key, value]) => JSON.stringify((tokenizer.identity as any)[key]) !== JSON.stringify(value))) throw new EvalFailure("CONFIRMATION_TOKENIZER_MISMATCH");
  const casePath = Object.keys(first.sourceBindings).find(path => path.endsWith("normalized-case-500K-1.json"))!, supplementPath = Object.keys(first.sourceBindings).find(path => path.endsWith("author-reference-500K-1.json"))!, data = load(casePath), supplement = load(supplementPath), questions = data.questions.map((question: any) => ({ ...question, nativeAuthorReference: supplement.questions[question.id] })), calibration = verifyExpandedCalibration(expandedRoot, questions, first.baselineIdentityHash);
  const overviewPath = resolve(expandedRoot, "expanded-answers", `optchat-${confirmationProtocol.contradictionLabel}.json`), overviewAnswer = load(overviewPath), overviewLedgerPath = resolve(expandedRoot, "expanded-answer-ledger", `optchat-${confirmationProtocol.contradictionLabel}.json`), overviewLedger = load(overviewLedgerPath), savedOverview = extractSavedOverview(overviewAnswer, expandedIdentityHash), overview = savedOverview.sharedNodes;
  if (overviewLedger.identityHash !== expandedIdentityHash || overviewLedger.fileHash !== digest(overviewPath) || overviewLedger.contentHash !== hash(JSON.stringify(overviewAnswer.private)) || overviewAnswer.public.caseHash !== expandedFreeze.caseHash || expandedFreeze.graph.projectionBytes !== 35577 || hash(savedOverview.fullPayload) !== "5186dc678ecf7ff1e8455cb621d323488502542e05e81d570312cf81fae2f483") throw new EvalFailure("CONFIRMATION_OVERVIEW_MISMATCH");
  const sourceBindings: Record<string, string> = { ...first.sourceBindings, ...Object.fromEntries([firstFreezePath, firstResultPath, firstStatePath, resourcePath, resolve(sourceRoot, "diagnostic-tokenizer-validation.json"), expandedFreezePath, overviewPath, overviewLedgerPath, import.meta.path].map(path => [path, digest(path)])) };
  const documentation = resolve(repository, "docs/evaluation/boros-diagnostic-confirmation-protocol.md"); if (existsSync(documentation)) sourceBindings[documentation] = digest(documentation);
  const selected = first.cells.filter((cell: any) => cell.questionLabel === confirmationProtocol.knowledgeLabel && confirmationProtocol.knowledgeConditions.includes(cell.condition));
  const contradiction = first.cells.find((cell: any) => cell.questionLabel === confirmationProtocol.contradictionLabel && cell.condition === "native_repeat_1");
  if (selected.length !== 3 || !contradiction) throw new EvalFailure("CONFIRMATION_COHORT_MISMATCH");
  const baseCells = [...selected.map((cell: any) => ({ ...cell, baseCellId: cell.cellId })), { ...contradiction, condition: "saved_overview", baseCellId: contradiction.cellId, messages: appendSavedOverview(contradiction.messages, overview) }];
  for (const base of baseCells) {
    const answerPath = resolve(sourceRoot, "diagnostic-answers", `${base.baseCellId}.json`), answerLedgerPath = resolve(sourceRoot, "answer-ledger", `${base.baseCellId}.json`), gradePath = resolve(sourceRoot, "diagnostic-grades", `${base.baseCellId}.json`), gradeLedgerPath = resolve(sourceRoot, "grade-ledger", `${base.baseCellId}.json`);
    for (const path of [answerPath, answerLedgerPath, gradePath, gradeLedgerPath]) sourceBindings[path] = digest(path);
    if (load(answerLedgerPath).fileHash !== digest(answerPath) || load(gradeLedgerPath).fileHash !== digest(gradePath)) throw new EvalFailure("CONFIRMATION_FIRST_WAVE_MISMATCH");
  }
  const cells = [] as { cellId: string; questionId: string; questionLabel: string; condition: string; repeat: number; messages: Parameters<ResumableLocalBackend["complete"]>[0]; requestHash: string; renderedRequestHash: string; inputTokens: number }[];
  for (const base of baseCells) for (let repeat = 1; repeat <= 2; repeat++) {
    const messages = base.messages, inputTokens = await tokenizer.countRequestTokens(messages, [], 2048);
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > 29696) throw new EvalFailure("CONFIRMATION_CONTEXT_UNSUPPORTED");
    cells.push({ cellId: `${base.questionLabel}-${base.condition}-confirmation_${repeat}`, questionId: base.questionId, questionLabel: base.questionLabel, condition: base.condition, repeat, messages, requestHash: hash(JSON.stringify({ messages, tools: [], outputTokens: 2048 })), renderedRequestHash: hash(renderer.render(messages, [])), inputTokens });
  }
  const lineage = confirmationBackendCopy(sourceRoot, root, digest(firstStatePath), resources), freeze = { protocol: confirmationProtocol, sourceBindings, firstWaveIdentityHash: hash(JSON.stringify(first)), tokenizerIdentity: tokenizer.identity, calibration, overview: { originalPayloadBytes: bytes(savedOverview.fullPayload), originalPayloadHash: hash(savedOverview.fullPayload), sharedNodeBytes: bytes(overview), sharedNodeHash: hash(overview), excludedEnvelopeBytes: bytes(savedOverview.fullPayload) - bytes(overview), sourceAnswerHash: digest(overviewPath), expandedIdentityHash }, lineage, cells };
  checkBindings(sourceBindings); immutable(resolve(root, "confirmation-freeze.json"), freeze); const identityHash = hash(JSON.stringify(freeze));
  if (mode === "freeze") return { phase: "frozen", identityHash, answerCells: cells.length, inheritedCalls: lineage.inheritedCalls, deadlineAt: lineage.deadlineAt, counts: cells.map(cell => ({ condition: cell.condition, repeat: cell.repeat, inputTokens: cell.inputTokens })) };
  const backend = new ResumableLocalBackend({ directory: root, url: "http://127.0.0.1:11234/v1/chat/completions", model: QWEN_MODEL, provider: "mlx", maxCalls: 120, maxMinutes: 30 });
  if (backend.startedAt !== lineage.startedAt) throw new EvalFailure("CONFIRMATION_RESOURCE_MISMATCH");
  const answers = [] as { cell: typeof cells[number]; answer: Awaited<ReturnType<typeof answerDiagnosticRequest>> }[];
  for (const cell of cells) {
    checkBindings(sourceBindings); const path = resolve(root, "confirmation-answers", `${cell.cellId}.json`);
    if (!existsSync(path)) { if (mode !== "answers") throw new EvalFailure("CONFIRMATION_ANSWERS_NOT_COMPLETE"); save(path, await answerDiagnosticRequest(backend, cell.messages, cell.cellId, identityHash, tokenizer.countRequestTokens)); }
    const answer = load(path); verifyDiagnosticAnswer(answer, cell.messages, cell.cellId, identityHash);
    immutable(resolve(root, "confirmation-answer-ledger", `${cell.cellId}.json`), { identityHash, fileHash: digest(path), requestHash: cell.requestHash, candidateHash: hash(answer.private.finalText) }); answers.push({ cell, answer });
    console.log(JSON.stringify({ phase: "confirmation-answer", completed: answers.length, total: cells.length, cumulativePhaseCalls: backend.calls, failure: answer.public.failure }));
  }
  if (mode === "answers") return { phase: "answers-complete", identityHash, answerCells: answers.length, cumulativePhaseCalls: backend.calls };
  const rows = [] as Record<string, any>[];
  for (const { cell, answer } of answers) {
    checkBindings(sourceBindings); const question = questions.find((question: any) => question.id === cell.questionId), path = resolve(root, "confirmation-grades", `${cell.cellId}.json`);
    if (!existsSync(path)) save(path, await gradeDiagnosticCandidate(backend, question, answer.private.finalText, cell.cellId, identityHash, calibration.public, tokenizer.countRequestTokens));
    const grade = load(path); verifyDiagnosticGrade(grade, question, answer.private.finalText, cell.cellId, identityHash);
    immutable(resolve(root, "confirmation-grade-ledger", `${cell.cellId}.json`), { identityHash, fileHash: digest(path), candidateHash: hash(answer.private.finalText), inputHash: grade.binding.inputHash });
    rows.push({ questionLabel: cell.questionLabel, condition: cell.condition, repeat: cell.repeat, answerHash: answer.public.answerHash, failure: answer.public.failure, inputTokens: cell.inputTokens, providerInputTokens: answer.private.tokenReceipt?.providerInputTokens ?? null, answerCalls: answer.public.calls, valid: grade.grade.public.valid, confidenceHigh: grade.grade.public.confidenceHigh, correctnessVerdict: grade.grade.public.correct, acceptedScore: grade.grade.public.acceptedScore, gradingFailure: grade.grade.private.failure, gradingCalls: grade.calls, gradingInputTokens: grade.tokenReceipt?.inputTokens ?? null });
    console.log(JSON.stringify({ phase: "confirmation-grade", completed: rows.length, total: answers.length, cumulativePhaseCalls: backend.calls }));
  }
  checkBindings(sourceBindings);
  const qualityAccepted = rows.length === 8 && rows.every(row => row.valid === 1 && row.acceptedScore === 1 && !/^(?:TOKENIZER_|INVALID_TOKEN_COUNT|SOURCE_)/.test(row.failure ?? ""));
  const result = { version: confirmationProtocol.version, developmentOnly: true, identityHash, firstWaveIdentityHash: hash(JSON.stringify(first)), qualityAccepted, overview: freeze.overview, rows: rows.map(row => ({ ...row, correct: qualityAccepted ? Number(row.correctnessVerdict === 1 && !row.failure) : null })), lineage: { inheritedCalls: 79, newCalls: backend.calls - 79, cumulativePhaseCalls: backend.calls, originalCalls: 2628, cumulativeCalls: 2628 + backend.calls, originalDeadlineAt: lineage.deadlineAt, originalStartPreserved: backend.startedAt === lineage.startedAt, source79Unchanged: true }, limits: { reusedDevelopmentQuestions: true, overviewIsCombinedControl: true, sameLocalAnswererAndGrader: true, noNewSummaryCalls: true, noRuntimeChanges: true } };
  immutable(resolve(root, "public-result-boros-confirmation.json"), result); return result;
}
if (import.meta.main) runConfirmation(process.argv.slice(2)).then(result => console.log(JSON.stringify({ phase: "phase" in result ? result.phase : "graded", identityHash: result.identityHash, qualityAccepted: "qualityAccepted" in result ? result.qualityAccepted : undefined }))).catch(error => { console.error(JSON.stringify({ error: safeCode(error) })); process.exitCode = 1; });

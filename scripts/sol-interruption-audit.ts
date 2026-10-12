import { chmodSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hash } from "../src/index.ts";
import { EvalFailure } from "./local-memory-eval.ts";
import { solBackendProtocol, solPayloadHash } from "./sol-responses-backend.ts";

export const solInterruptionProtocol = {
  version: "sol-call37-ceiling-continuation-1", failedCall: 37, generationPrefix: 37, countPrefix: 67, savedAnswers: 15,
  maxCalls: 420, maxCountCalls: 3000, maxMinutes: 120, maxCostUsd: 60, outputTokens: 8192,
  charge: "Charge the full unresolved reservation as a conservative ceiling. Keep provider usage unknown.",
  disposition: "Assign zero answer credit. Do not retry the interrupted request.",
} as const;
const known = {
  identity: "a02f686324d22d6ca6bd8f6dad460ac22f2383df2bbacb3431436382c6956583",
  stateHash: "291d6c5748d0c3f5e03737fc16e81c8b1fd4572d39675be0e342cc36ff306bdf",
  profile: "79025b9e3c90628394cdd3bc97759b631b53012f1d6e8e544cbc5a70fa96315b",
  requestHash: "eeb884aa9a61671e91e485d947fefb611a0014c6bf52b553b28cbc1158c42680",
  countHash: "209eb2dee2d9e34054af9d124d4bc43273c5bfd46ed427070d1d0b24c8655f76",
  inputFileHash: "92a0fd563e643204fce5ab206dbe37312d36193822b6be7ae2dac56999e3f3f4",
  receiptFileHash: "e4f1ba75dd3ce09f6e8407aaa8917a9bb87c7c3e899a2f759c3025f92dc3c80b",
  questionId: "d753dd3aef9ac783f13509c3", ceilingChargeUsd: 0.1257525, inputTokens: 17533,
  startedAt: 1791837089273, revision: 210, latencyMs: 635391,
} as const;
type State = Record<string, any>;
export type SolInterruptionManifest = {
  protocol: typeof solInterruptionProtocol; originalIdentityHash: string; originalStateHash: string;
  originalStateSnapshotPath: string; sourceBindings: Record<string, string>; profile: string; startedAt: number;
  deadlineAt: number; revisionBefore: number; prefixCalls: 37; prefixCountCalls: 67;
  metricsPrefixHash: string; countMetricsPrefixHash: string; countsPrefixHash: string;
  costBeforeUsd: number; ceilingChargeUsd: number; settledCostUsd: number; failedCall: 37;
  questionId: string; failedRequestHash: string; failedCountHash: string;
};
const parse = (path: string): any => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new EvalFailure("SOL_INTERRUPTION_INVALID_FILE"); } };
const digest = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
const contentHash = (value: unknown) => hash(JSON.stringify(value));
const near = (a: unknown, b: number) => typeof a === "number" && Number.isFinite(a) && Math.abs(a - b) <= 1e-10;
function fail(condition: unknown, code = "SOL_INTERRUPTION_MISMATCH"): asserts condition { if (!condition) throw new EvalFailure(code); }
function active(root: string) { if (existsSync(resolve(root, "user-requested-stop.json"))) throw new EvalFailure("SOL_USER_STOPPED"); }
function immutable(root: string, path: string, data: string) {
  active(root);
  if (existsSync(path)) { fail(readFileSync(path, "utf8") === data, "SOL_INTERRUPTION_IMMUTABLE_MISMATCH"); return; }
  writeFileSync(path, data, { mode: 0o600, flag: "wx" });
}
function privateJSON(root: string, path: string, value: unknown) { immutable(root, path, JSON.stringify(value, null, 2) + "\n"); }
function checkBindings(bindings: Record<string, string>) {
  for (const [path, expected] of Object.entries(bindings)) {
    fail(!/(?:openaikey|credentials?)(?:\.|\/|$)/i.test(path), "SOL_INTERRUPTION_CREDENTIAL_BINDING");
    fail(/^[a-f0-9]{64}$/.test(expected) && existsSync(path) && digest(path) === expected, "SOL_INTERRUPTION_SOURCE_DRIFT");
  }
}
function requestPrivacy(body: any) {
  const allowed = ["model", "input", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "truncation", "store", "stream", "max_output_tokens"];
  fail(Object.keys(body).every(key => allowed.includes(key)) && body.model === solBackendProtocol.model && body.store === false && body.stream === false
    && body.truncation === "disabled" && body.parallel_tool_calls === true && body.max_output_tokens === 8192
    && JSON.stringify(body.reasoning) === JSON.stringify({ effort: "medium" }) && Array.isArray(body.input), "SOL_INTERRUPTION_REQUEST_MISMATCH");
  fail(body.input.every((item: any) => item && [undefined, "message", "function_call", "function_call_output"].includes(item.type)
    && !Object.hasOwn(item, "encrypted_content") && !Object.hasOwn(item, "id") && !Object.hasOwn(item, "phase")), "SOL_INTERRUPTION_PRIVATE_PROVIDER_STATE");
}
function settlement(manifest: SolInterruptionManifest, identityHash: string) {
  return { version: "sol-unknown-cost-ceiling-1", amendmentIdentityHash: identityHash, failedCall: 37, originalStateHash: manifest.originalStateHash,
    chargeUsd: manifest.ceilingChargeUsd, authoritative: false, providerInputTokens: null, providerOutputTokens: null, retried: false };
}

// These pure checks permit synthetic fixtures. The file mutation entry point uses the fixed production identity.
export function validateSolInterruptionPrefix(state: State, manifest: SolInterruptionManifest) {
  fail(JSON.stringify(manifest.protocol) === JSON.stringify(solInterruptionProtocol) && manifest.failedCall === 37 && manifest.prefixCalls === 37 && manifest.prefixCountCalls === 67
    && manifest.deadlineAt === manifest.startedAt + 120 * 60000 && near(manifest.ceilingChargeUsd, 0.1257525)
    && near(manifest.settledCostUsd, manifest.costBeforeUsd + manifest.ceilingChargeUsd), "SOL_INTERRUPTION_MANIFEST_MISMATCH");
  fail(state.version === 1 && state.profile === manifest.profile && state.startedAt === manifest.startedAt && Number.isSafeInteger(state.revision)
    && state.revision > manifest.revisionBefore && Number.isSafeInteger(state.calls) && state.calls >= 37 && state.calls <= 420
    && Number.isSafeInteger(state.countCalls) && state.countCalls >= 67 && state.countCalls <= 3000 && Array.isArray(state.metrics)
    && state.metrics.length === state.calls && Array.isArray(state.countMetrics) && state.countMetrics.length === state.countCalls
    && contentHash(state.metrics.slice(0, 37)) === manifest.metricsPrefixHash
    && contentHash(state.countMetrics.slice(0, 67)) === manifest.countMetricsPrefixHash, "SOL_INTERRUPTION_PREFIX_MISMATCH");
  const prefixCounts = Object.fromEntries(Object.entries(state.counts ?? {}).filter(([, value]) => (value as any).countCall <= 67));
  fail(contentHash(prefixCounts) === manifest.countsPrefixHash, "SOL_INTERRUPTION_COUNT_CACHE_MISMATCH");
  const unknown = state.metrics[36];
  fail(unknown.call === 37 && unknown.status === "complete" && unknown.success === false && unknown.code === "SOL_TRANSPORT_FAILURE"
    && unknown.inputTokens === null && unknown.outputTokens === null && unknown.totalTokens === null && unknown.costUsd === null
    && unknown.requestHash === manifest.failedRequestHash && unknown.countHash === manifest.failedCountHash
    && near(unknown.reservedCostUsd, manifest.ceilingChargeUsd), "SOL_INTERRUPTION_USAGE_CHANGED");
  const laterCost = state.metrics.slice(37).reduce((sum: number, metric: any) => {
    fail(metric.costUsd === null || typeof metric.costUsd === "number" && Number.isFinite(metric.costUsd) && metric.costUsd >= 0, "SOL_INTERRUPTION_COST_MISMATCH");
    return sum + (metric.costUsd ?? 0);
  }, 0);
  fail(near(state.costUsd, manifest.settledCostUsd + laterCost) && typeof state.reservedCostUsd === "number" && Number.isFinite(state.reservedCostUsd)
    && state.reservedCostUsd >= 0 && state.costUsd + state.reservedCostUsd <= 60 + 1e-10, "SOL_INTERRUPTION_COST_MISMATCH");
  const identityHash = contentHash(manifest);
  fail(Array.isArray(state.unknownCostSettlements) && state.unknownCostSettlements.length === 1
    && JSON.stringify(state.unknownCostSettlements[0]) === JSON.stringify(settlement(manifest, identityHash)), "SOL_INTERRUPTION_SETTLEMENT_MISMATCH");
}

export function settledSolInterruptionState(original: State, manifest: SolInterruptionManifest): State {
  fail(original.calls === 37 && original.countCalls === 67 && original.revision === manifest.revisionBefore && original.haltedCode === "SOL_USAGE_UNRESOLVED"
    && near(original.reservedCostUsd, manifest.ceilingChargeUsd) && near(original.costUsd, manifest.costBeforeUsd)
    && original.unknownCostSettlements === undefined, "SOL_INTERRUPTION_START_MISMATCH");
  const next = structuredClone(original);
  next.costUsd += manifest.ceilingChargeUsd; next.reservedCostUsd = 0; next.haltedCode = null; next.revision++;
  next.unknownCostSettlements = [settlement(manifest, contentHash(manifest))];
  validateSolInterruptionPrefix(next, manifest); return next;
}

export function verifySolInterruption(rootArg: string, manifest: SolInterruptionManifest) {
  const root = realpathSync(rootArg); active(root);
  fail(manifest.originalIdentityHash === known.identity && manifest.originalStateHash === known.stateHash && manifest.profile === known.profile
    && manifest.startedAt === known.startedAt && manifest.revisionBefore === known.revision && manifest.questionId === known.questionId
    && manifest.failedRequestHash === known.requestHash && manifest.failedCountHash === known.countHash, "SOL_INTERRUPTION_KNOWN_PHASE_REQUIRED");
  checkBindings(manifest.sourceBindings);
  fail(manifest.originalStateSnapshotPath === resolve(root, "sol-interruption-state-before.json")
    && digest(manifest.originalStateSnapshotPath) === known.stateHash, "SOL_INTERRUPTION_SNAPSHOT_MISMATCH");
  const storedManifest = parse(resolve(root, "sol-interruption-freeze.json"));
  fail(JSON.stringify(storedManifest) === JSON.stringify(manifest), "SOL_INTERRUPTION_MANIFEST_MISMATCH");
  const original = parse(manifest.originalStateSnapshotPath), expected = settledSolInterruptionState(original, manifest), proof = parse(resolve(root, "sol-interruption-settlement.json"));
  fail(JSON.stringify(proof) === JSON.stringify({ version: "sol-full-ceiling-settlement-1", identityHash: contentHash(manifest),
    originalStateHash: known.stateHash, plannedSettledStateHash: contentHash(expected), failedCall: 37, chargeUsd: manifest.ceilingChargeUsd,
    authoritative: false, usageMustRemainUnknown: true, retried: false }), "SOL_INTERRUPTION_PROOF_MISMATCH");
  fail(!existsSync(resolve(root, "calls/000037/output.json")), "SOL_INTERRUPTION_PROVIDER_OUTPUT_APPEARED");
  validateSolInterruptionPrefix(parse(resolve(root, "sol-backend-state.json")), manifest);
  return { identityHash: contentHash(manifest), manifest, failedCall: 37 as const, ceilingChargeUsd: manifest.ceilingChargeUsd,
    questionId: manifest.questionId, originalStateSnapshot: original };
}

export function prepareSolInterruption(rootArg: string, repositoryArg: string) {
  const root = realpathSync(rootArg), repository = realpathSync(repositoryArg); active(root);
  fail(root === resolve(repository, ".optchat/beam-sol-02"), "SOL_INTERRUPTION_PRIVATE_PHASE_REQUIRED");
  const lock = resolve(root, "sol-backend-dispatch.lock");
  try { writeFileSync(lock, crypto.randomUUID(), { mode: 0o600, flag: "wx" }); } catch { throw new EvalFailure("SOL_CONCURRENT_EVALUATION"); }
  try {
    active(root);
    const freezePath = resolve(root, "sol-comparison-freeze.json"), statePath = resolve(root, "sol-backend-state.json"), manifestPath = resolve(root, "sol-interruption-freeze.json");
    if (existsSync(manifestPath) && digest(statePath) !== known.stateHash) return verifySolInterruption(root, parse(manifestPath));
    const freeze = parse(freezePath), originalText = readFileSync(statePath, "utf8"), state = JSON.parse(originalText), auditPath = resolve(root, "independent-private/unresolved-call37-audit.json"), audit = parse(auditPath);
    fail(contentHash(freeze) === known.identity && digest(statePath) === known.stateHash && state.profile === known.profile
      && state.startedAt === known.startedAt && state.revision === known.revision && state.calls === 37 && state.countCalls === 67
      && state.metrics.length === 37 && state.countMetrics.length === 67 && state.metrics.slice(0, 36).every((metric: any) => metric.success === true && metric.status === "complete")
      && state.countMetrics.every((metric: any) => metric.success === true && metric.status === "complete")
      && near(state.reservedCostUsd, known.ceilingChargeUsd) && state.haltedCode === "SOL_USAGE_UNRESOLVED", "SOL_INTERRUPTION_KNOWN_PHASE_REQUIRED");
    fail(freeze.protocol.model === solBackendProtocol.model && JSON.stringify(freeze.protocol.backend) === JSON.stringify(solBackendProtocol)
      && freeze.protocol.maxCalls === 420 && freeze.protocol.maxCountCalls === 3000 && freeze.protocol.maxMinutes === 120
      && freeze.protocol.maxCostUsd === 60 && freeze.protocol.outputTokens === 8192 && freeze.protocol.retries === 0, "SOL_INTERRUPTION_PROTOCOL_MISMATCH");
    fail(Date.now() < state.startedAt + 120 * 60000, "SOL_RUN_DEADLINE");
    checkBindings(freeze.sourceBindings);
    const metric = state.metrics[36], inputPath = resolve(root, "calls/000037/input.json"), receiptPath = resolve(root, "calls/000037/receipt.json"), body = parse(inputPath);
    requestPrivacy(body);
    fail(!existsSync(resolve(root, "calls/000037/output.json")) && digest(inputPath) === known.inputFileHash && digest(receiptPath) === known.receiptFileHash
      && JSON.stringify(parse(receiptPath)) === JSON.stringify(metric) && solPayloadHash(body) === known.requestHash
      && metric.stage === `answer:optchat:${known.questionId}` && metric.latencyMs === known.latencyMs && metric.expectedInputTokens === known.inputTokens
      && metric.maxOutputTokens === 8192 && metric.requestHash === known.requestHash && metric.countHash === known.countHash
      && metric.inputTokens === null && metric.outputTokens === null && metric.totalTokens === null && metric.costUsd === null
      && metric.status === "complete" && metric.success === false && metric.code === "SOL_TRANSPORT_FAILURE", "SOL_INTERRUPTION_RECEIPT_MISMATCH");
    fail(audit.version === "independent-unresolved-sol-call-1" && audit.passed === true && audit.originalPhaseIdentity === known.identity && audit.call === 37
      && audit.code === metric.code && audit.inputTokens === null && audit.outputTokens === null && audit.expectedInputTokens === known.inputTokens
      && audit.maxOutputTokens === 8192 && near(audit.reservedCostUsd, known.ceilingChargeUsd) && audit.latencyMs === known.latencyMs
      && audit.requestHash === known.requestHash && audit.countHash === known.countHash && audit.inputFileHash === known.inputFileHash
      && audit.receiptFileHash === known.receiptFileHash && audit.originalStateHash === known.stateHash && audit.providerOutputFileAbsent === true
      && audit.usageMustRemainUnknown === true && audit.priorStoppedCalls === 196, "SOL_INTERRUPTION_INDEPENDENT_AUDIT_MISMATCH");
    const answerDirectory = resolve(root, "sol-answers"), ledgerDirectory = resolve(root, "sol-answer-ledger"), answerNames = readdirSync(answerDirectory).sort(), ledgerNames = readdirSync(ledgerDirectory).sort();
    fail(answerNames.length === 15 && JSON.stringify(answerNames) === JSON.stringify(ledgerNames), "SOL_INTERRUPTION_ANSWER_PREFIX_MISMATCH");
    for (const name of answerNames) {
      const answerPath = resolve(answerDirectory, name), answer = parse(answerPath), ledger = parse(resolve(ledgerDirectory, name));
      fail(/^[a-f0-9]{16}-(?:optchat|boros)\.json$/.test(name) && answer.private.solIdentityHash === known.identity
        && ledger.identityHash === known.identity && ledger.fileHash === digest(answerPath) && ledger.candidateHash === hash(answer.private.finalText), "SOL_INTERRUPTION_ANSWER_PREFIX_MISMATCH");
    }
    const snapshotPath = resolve(root, "sol-interruption-state-before.json");
    immutable(root, snapshotPath, originalText);
    const files = [freezePath, snapshotPath, auditPath, resolve(repository, "scripts/sol-interruption-audit.ts"),
      resolve(repository, "scripts/sol-memory-continuation.ts"), resolve(repository, "docs/evaluation/sol-interruption-amendment.md"),
      ...answerNames.map(name => resolve(answerDirectory, name)), ...ledgerNames.map(name => resolve(ledgerDirectory, name))];
    for (let call = 1; call <= 37; call++) for (const name of ["input.json", "receipt.json", ...(call < 37 ? ["output.json"] : [])]) files.push(resolve(root, "calls", String(call).padStart(6, "0"), name));
    for (let call = 1; call <= 67; call++) for (const name of ["input.json", "output.json", "receipt.json"]) files.push(resolve(root, "counts", String(call).padStart(6, "0"), name));
    const sourceBindings = { ...freeze.sourceBindings, ...Object.fromEntries(files.map(path => [path, digest(path)])) };
    const manifest: SolInterruptionManifest = { protocol: solInterruptionProtocol, originalIdentityHash: known.identity, originalStateHash: known.stateHash,
      originalStateSnapshotPath: snapshotPath, sourceBindings, profile: state.profile, startedAt: state.startedAt, deadlineAt: state.startedAt + 120 * 60000,
      revisionBefore: state.revision, prefixCalls: 37, prefixCountCalls: 67, metricsPrefixHash: contentHash(state.metrics), countMetricsPrefixHash: contentHash(state.countMetrics),
      countsPrefixHash: contentHash(state.counts), costBeforeUsd: state.costUsd, ceilingChargeUsd: known.ceilingChargeUsd,
      settledCostUsd: state.costUsd + known.ceilingChargeUsd, failedCall: 37, questionId: known.questionId, failedRequestHash: known.requestHash, failedCountHash: known.countHash };
    const settled = settledSolInterruptionState(state, manifest), identityHash = contentHash(manifest);
    privateJSON(root, manifestPath, manifest);
    privateJSON(root, resolve(root, "sol-interruption-settlement.json"), { version: "sol-full-ceiling-settlement-1", identityHash,
      originalStateHash: known.stateHash, plannedSettledStateHash: contentHash(settled), failedCall: 37, chargeUsd: known.ceilingChargeUsd,
      authoritative: false, usageMustRemainUnknown: true, retried: false });
    active(root); fail(digest(statePath) === known.stateHash, "SOL_CONCURRENT_EVALUATION");
    const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(settled, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    try { active(root); renameSync(temporary, statePath); chmodSync(statePath, 0o600); } catch (error) { if (existsSync(temporary)) unlinkSync(temporary); throw error; }
    return verifySolInterruption(root, manifest);
  } finally { unlinkSync(lock); }
}

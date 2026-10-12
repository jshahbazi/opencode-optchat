import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Engine, Store, ModelSummarizer, assembleContext, bytes, hash, key, sourceKey, type JobInput, type Node, type Publication, type Turn } from "../src/index.ts";
import { renderedBytes } from "../src/core/views.ts";
import { EvalFailure, type Backend } from "./local-memory-eval.ts";
import { QWEN_MODEL } from "./boros-context-driver.ts";
import { longCompactorSystem, longAnswerInstruction, longTools, longCaseHashes, longHistoryProtocol, ResumableLocalBackend, type NormalizedLongCase, type PreparedLongCase } from "./long-history-eval.ts";

export const optionalParentProtocol = {
  version: "beam-optional-parent-continuation-1", baseProtocol: longHistoryProtocol,
  optionalParents: "Shared parents or session parents above two records without publication dependencies.",
  failedJobs: "Retain failed jobs without retries.", questionBlindPreparation: true,
  completion: "Require exact originals, complete publications, and a bounded complete reader context.",
} as const;
type FailureRow = { id: string; input: string; attempts: number; fence: number; error: string | null };
export type ParentFailure = { jobId: string; treeKind: string; start: number | null; count: number | null; end: number | null; units: "records" | "publications" | "unknown"; errorCode: string; optional: boolean; coveredByChildren: boolean };
type ContinuationReport = { version: string; status: "preparing" | "prepared" | "halted"; originalCount: number; publicationCount: number; optionalFailureCount: number; mandatoryFailureCount: number; failures: ParentFailure[]; terminalError: string | null; initialOriginalCount: number; initialPublicationCount: number; readerContextByteUpperBound?: number };
const errorCode = (error: unknown) => {
  const value = (error as { code?: unknown })?.code;
  return typeof value === "string" && /^[A-Z_0-9]{1,64}$/.test(value) ? value : "INTERNAL_FAILURE";
};
const storedCode = (text: string | null) => text?.match(/^(?:MemoryError|EvalFailure|Error): ([A-Z_0-9]{1,64})(?::|$)/)?.[1] ?? "INTERNAL_FAILURE";
const terminalCode = (code: string) => /BUDGET|LIMIT|DEADLINE/.test(code) || ["CONFIG", "CONCURRENT_EVALUATION", "SUMMARY_INPUT_TOO_LARGE"].includes(code);
const failedRows = (store: Store) => store.db.query("SELECT id,input,attempts,fence,error FROM jobs WHERE status='failed' ORDER BY id").all() as FailureRow[];
const dependencyPaths = ["src/index.ts", "src/core/abort.ts", "src/core/context.ts", "src/core/engine.ts", "src/core/provider-error.ts", "src/core/retrieval.ts",
  "src/core/tree.ts", "src/core/types.ts", "src/core/views.ts", "src/storage/store.ts", "src/compactor/summarizer.ts",
  "scripts/long-history-eval.ts", "scripts/local-memory-eval.ts", "scripts/boros-context-driver.ts"];
const dependencyHashes = () => Object.fromEntries(dependencyPaths.map(path => [path, hash(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))]));

export function classifyParentFailure(store: Store, row: FailureRow, sessionId: string, scopeId: string): ParentFailure {
  let input: JobInput | undefined, tree: unknown[] = [];
  try { input = JSON.parse(row.input); if (input && "tree" in input) tree = JSON.parse(input.tree); } catch {}
  const start = input && "start" in input && Number.isSafeInteger(input.start) ? input.start : null;
  const count = input?.type === "parent" && Number.isSafeInteger(input.count) ? input.count : null;
  const treeKind = typeof tree[0] === "string" ? tree[0] : "unknown", code = storedCode(row.error);
  const scope = store.get<{ epoch: number }>("scopes", scopeId), session = store.get<{ generation: number }>("sessions", sessionId);
  const dependency = input?.type === "parent" && store.db.query("SELECT 1 FROM publication_dependencies WHERE tree=? AND start=? AND count=? LIMIT 1").get(input.tree, input.start, input.count);
  const children = input?.type === "parent" ? input.children.map(id => {
    const child = store.db.query("SELECT tree,start,count FROM nodes WHERE id=?").get(id) as { tree: string; start: number; count: number } | null;
    return child;
  }).sort((a, b) => (a?.start ?? 0) - (b?.start ?? 0)) : [];
  const coveredByChildren = input?.type === "parent" && count !== null && start !== null && children.length === 2 && children.every((child, index) =>
    child && child.tree === input.tree && child.count === count / 2 && child.start === start + index * count / 2);
  const optional = ["SUMMARY_SIZE", "SUMMARY_BATCH_INVALID"].includes(code) && coveredByChildren && input?.type === "parent" && start !== null && start >= 0 && count !== null && count > 1 && start % count === 0 && Number.isInteger(Math.log2(count)) && !dependency &&
    (treeKind === "shared" && tree[1] === scopeId && tree[2] === scope?.epoch || treeKind === "session" && tree[1] === sessionId && tree[2] === session?.generation && count > 2);
  return { jobId: row.id, treeKind, start, count, end: start !== null && count !== null ? start + count : null,
    units: treeKind === "session" ? "records" : treeKind === "shared" ? "publications" : "unknown", errorCode: code, optional: !!optional, coveredByChildren: !!coveredByChildren };
}

export async function drainOptionalParents(engine: Engine, sessionId: string, scopeId: string, onFailure?: () => void) {
  const initial = failedRows(engine.store);
  if (initial.some(row => !classifyParentFailure(engine.store, row, sessionId, scopeId).optional)) throw new EvalFailure("MANDATORY_PREPARATION_FAILURE");
  const known = new Set(initial.map(row => row.id));
  for (;;) {
    try { await engine.drain(100000); return; }
    catch (error) {
      onFailure?.();
      if (terminalCode(errorCode(error))) throw error;
      const added = failedRows(engine.store).filter(row => !known.has(row.id));
      if (!added.length || added.some(row => !classifyParentFailure(engine.store, row, sessionId, scopeId).optional)) throw error;
      for (const row of added) known.add(row.id);
    }
  }
}

export async function prepareOptionalParentCase(backend: Backend, store: Store, data: NormalizedLongCase,
  options: { onProgress?: (report: ContinuationReport) => void } = {}): Promise<PreparedLongCase & { continuation: ContinuationReport }> {
  const hashes = longCaseHashes(data), identity = { ...hashes, source: data.source, protocol: longHistoryProtocol };
  const registered = store.get("longEvaluation", "identity");
  if (registered && JSON.stringify(registered) !== JSON.stringify(identity)) throw new EvalFailure("PREPARATION_RESUME_MISMATCH");
  const continuationIdentity = { baseIdentity: identity, protocolHash: hash(JSON.stringify(optionalParentProtocol)),
    sourceHash: hash(readFileSync(import.meta.path, "utf8")), dependencyHashes: dependencyHashes() };
  const prior = store.get("optionalParentPreparation", "identity");
  if (prior && JSON.stringify(prior) !== JSON.stringify(continuationIdentity)) throw new EvalFailure("CONTINUATION_RESUME_MISMATCH");
  if (!registered) store.set("longEvaluation", "identity", identity);
  if (!prior) store.set("optionalParentPreparation", "identity", continuationIdentity);
  const sessionId = `archive-${hashes.caseHash.slice(0, 16)}`, scopeId = `scope-${hashes.caseHash.slice(0, 16)}`, projectId = "beam-public-evaluation";
  const initialSources = (store.db.query("SELECT id,value FROM sources ORDER BY id").all() as { id: string; value: string }[]);
  const initialPublications = store.all<Publication>("publications"), initialFailures = failedRows(store);
  const initialCounts = store.get<{ sources: number; publications: number }>("optionalParentPreparation", "initialCounts") ?? { sources: initialSources.length, publications: initialPublications.length };
  store.set("optionalParentPreparation", "initialCounts", initialCounts);
  const summarizer = new ModelSummarizer(async prompt => {
    const counters = store.get<{ modelCalls: number; correctionRetries: number; batchCalls: number }>("longEvaluation", "summaryCounters") ?? { modelCalls: 0, correctionRetries: 0, batchCalls: 0 };
    const header = prompt.split("UNTRUSTED_JSON_DATA:\n", 1)[0]!;
    counters.modelCalls++; if (header.includes("Previous response")) counters.correctionRetries++; if (header.includes("BATCH_CONTRACT")) counters.batchCalls++;
    store.set("longEvaluation", "summaryCounters", counters);
    const result = await backend.complete([{ role: "system", content: longCompactorSystem }, { role: "user", content: prompt }], [], "summary:optchat", longHistoryProtocol.summaryTokens);
    if (result.message.tool_calls?.length) throw new EvalFailure("SUMMARY_TOOL_CALL");
    return result.message.content ?? "";
  }, "explicit-loopback-model", 12000, longHistoryProtocol.summaryRetries, true, longHistoryProtocol.summaryAcceptBytes);
  const engine = new Engine(store, summarizer, { high: longHistoryProtocol.viewHighBytes, low: longHistoryProtocol.viewLowBytes, chunkBytes: longHistoryProtocol.leafInputBytes,
    maxRunningJobs: 1, parentBatchSize: longHistoryProtocol.summaryBatchSize, leafBatchSize: longHistoryProtocol.summaryBatchSize, summaryAcceptBytes: longHistoryProtocol.summaryAcceptBytes, compactEvidence: true });
  engine.register(sessionId, scopeId, projectId);
  const report = (status: ContinuationReport["status"], terminalError: string | null = null): ContinuationReport => {
    const failures = failedRows(store).map(row => classifyParentFailure(store, row, sessionId, scopeId));
    const value: ContinuationReport = { version: optionalParentProtocol.version, status, originalCount: engine.sources(sessionId, 0).length,
      publicationCount: store.all<Publication>("publications").length, optionalFailureCount: failures.filter(failure => failure.optional).length,
      mandatoryFailureCount: failures.filter(failure => !failure.optional).length, failures, terminalError,
      initialOriginalCount: initialCounts.sources, initialPublicationCount: initialCounts.publications };
    store.set("optionalParentPreparation", "report", value); options.onProgress?.(value); return value;
  };
  const verifyOriginals = (full: boolean) => {
    const sources = engine.sources(sessionId, 0);
    if (sources.length > data.messages.length || full && sources.length !== data.messages.length || !sources.every((source, index) => {
      const message = data.messages[index]!;
      return source.seq === index && source.kind === message.role && source.payload === message.text && source.payloadHash === hash(message.text) && source.eventKey === `original-${index}`;
    })) throw new EvalFailure("ORIGINAL_RETENTION_MISMATCH");
    return sources;
  };
  try {
    verifyOriginals(false); report("preparing");
    await drainOptionalParents(engine, sessionId, scopeId, () => report("preparing"));
    for (let start = 0; start < data.messages.length; start += longHistoryProtocol.recordsPerTurn) {
      const turnId = `turn-${String(start / 2).padStart(6, "0")}`, pair = data.messages.slice(start, start + longHistoryProtocol.recordsPerTurn);
      const retained = store.get<Turn>("turns", key(sessionId, 0, turnId));
      if (retained?.outcome) {
        if (retained.outcome !== "completed" || retained.start !== start || retained.end !== start + pair.length) throw new EvalFailure("TURN_RESUME_MISMATCH");
      } else {
        engine.admit(sessionId, turnId);
        for (const message of pair) {
          const original = engine.append({ sessionId, generation: 0, turnId, eventKey: `original-${message.seq}`, kind: message.role, projectId,
            timestamp: message.timeAnchor ?? "2026-10-12T00:00:00Z", payload: message.text });
          store.set("longOriginalMetadata", sourceKey(original), { originalId: message.originalId, seq: message.seq, role: message.role, timeAnchor: message.timeAnchor });
        }
        engine.finish(sessionId, turnId, "completed", "2026-10-12T00:00:00Z");
      }
      await drainOptionalParents(engine, sessionId, scopeId, () => report("preparing")); report("preparing");
    }
    const sources = verifyOriginals(true), expectedTurns = Math.ceil(data.messages.length / longHistoryProtocol.recordsPerTurn);
    const publications = store.all<Publication>("publications").sort((a, b) => a.publicationSeq - b.publicationSeq);
    if (publications.length !== expectedTurns || !publications.every((publication, index) => publication.sessionId === sessionId && publication.generation === 0 &&
      publication.scopeId === scopeId && publication.publicationSeq === index + 1 && publication.start === index * 2 && publication.end === Math.min(data.messages.length, index * 2 + 2) &&
      publication.turnId === `turn-${String(index).padStart(6, "0")}` && publication.outcome === "completed")) throw new EvalFailure("PUBLICATION_RETENTION_MISMATCH");
    for (const source of initialSources) if ((store.db.query("SELECT value FROM sources WHERE id=?").get(source.id) as { value: string } | null)?.value !== source.value) throw new EvalFailure("INITIAL_EVIDENCE_CHANGED");
    for (const publication of initialPublications) if (JSON.stringify(store.get("publications", publication.id)) !== JSON.stringify(publication)) throw new EvalFailure("INITIAL_EVIDENCE_CHANGED");
    for (const failure of initialFailures) if (JSON.stringify(failedRows(store).find(row => row.id === failure.id)) !== JSON.stringify(failure)) throw new EvalFailure("FAILED_JOB_CHANGED");
    if (store.db.query("SELECT 1 FROM publication_candidates LIMIT 1").get() || store.db.query("SELECT 1 FROM jobs WHERE status IN ('pending','running') LIMIT 1").get()) throw new EvalFailure("PREPARATION_NOT_COMPLETE");
    engine.register("evaluation-reader", scopeId, projectId);
    const snapshot = engine.admit("evaluation-reader", "fixed-history").snapshot;
    if (snapshot.view.prefix !== expectedTurns) throw new EvalFailure("PUBLICATION_COVER_INCOMPLETE");
    const nodes = (store.db.query("SELECT value FROM nodes").all() as { value: string }[]).map(row => JSON.parse(row.value) as Node), byId = new Map(nodes.map(node => [node.id, node])), depths = new Map<string, number>();
    const depth = (id: string): number => { if (depths.has(id)) return depths.get(id)!; const node = byId.get(id); if (!node) throw new EvalFailure("MISSING_GRAPH_NODE");
      const value = node.children.length ? 1 + Math.max(...node.children.map(depth)) : 0; depths.set(id, value); return value; };
    const projection = engine.projection(snapshot.view, longHistoryProtocol.memoryBytes), frontier = snapshot.view.nodes.map(id => engine.node(id));
    const context = assembleContext(engine, { snapshot, system: [{ type: "text", text: longAnswerInstruction }], tools: longTools,
      live: [{ role: "user", content: "Preparation budget verification." }], budget: { contextTokens: longHistoryProtocol.contextTokens,
        outputTokens: longHistoryProtocol.answerTokens, safetyTokens: longHistoryProtocol.safetyTokens, memoryBytes: longHistoryProtocol.memoryBytes } });
    const counters = store.get<{ modelCalls: number; correctionRetries: number; batchCalls: number }>("longEvaluation", "summaryCounters") ?? { modelCalls: 0, correctionRetries: 0, batchCalls: 0 };
    const metrics: PreparedLongCase["metrics"] = { ...hashes, originalCount: sources.length, originalBytes: sources.reduce((sum, source) => sum + bytes(source.payload), 0), originalHashesValid: true,
      publications: snapshot.view.prefix, nodeCount: nodes.length, chunkNodes: nodes.filter(node => node.tree.startsWith('["chunk"')).length,
      fallbackNodes: nodes.filter(node => node.fallback).length, losslessNodes: nodes.filter(node => node.model === "lossless-local").length,
      summaryModelCalls: counters.modelCalls, summaryCorrectionRetries: counters.correctionRetries, summaryBatchCalls: counters.batchCalls, failedJobs: failedRows(store).length,
      jobRetries: (store.db.query("SELECT COALESCE(sum(max(attempts-1,0)),0) retries FROM jobs").get() as { retries: number }).retries,
      maxSummaryBytes: Math.max(0, ...nodes.map(node => node.bytes)), projectionBytes: renderedBytes(projection), projectionCount: projection.length,
      projectionMaxDepth: Math.max(0, ...projection.map(node => depth(node.id))), selectedRangeMaxCount: Math.max(0, ...projection.map(node => node.count)),
      frontierCount: frontier.length, frontierBytes: renderedBytes(frontier) };
    const continuation = { ...report("prepared"), readerContextByteUpperBound: context.tokenUpperBound };
    store.set("optionalParentPreparation", "report", continuation); store.set("optionalParentPreparation", "metrics", metrics);
    options.onProgress?.(continuation); return { engine, snapshot, sources, metrics, continuation };
  } catch (error) { report("halted", errorCode(error)); throw error; }
}

function saveMetadata(path: string, value: unknown) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); renameSync(temporary, path); chmodSync(path, 0o600);
}
export async function runOptionalParentCLI(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--dry-run") { values.set("--dry-run", "true"); continue; }
    if (!["--case", "--run"].includes(args[index]!) || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new EvalFailure("INVALID_CLI");
    values.set(args[index]!, args[++index]!);
  }
  if (!values.has("--case") || !values.has("--run")) throw new EvalFailure("EXPLICIT_CONTINUATION_REQUIRED");
  const root = realpathSync(resolve(values.get("--run")!)), casePath = resolve(values.get("--case")!), databasePath = resolve(root, "memory.sqlite");
  const markerPath = resolve(root, "optional-parent-copy.json");
  if (!existsSync(markerPath)) throw new EvalFailure("PRIVATE_COPY_REQUIRED");
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { sourceRunDirectory?: string; sourceDatabaseHash?: string };
  if (typeof marker.sourceRunDirectory !== "string" || typeof marker.sourceDatabaseHash !== "string" || realpathSync(marker.sourceRunDirectory) === root ||
    realpathSync(resolve(marker.sourceRunDirectory, "memory.sqlite")) === realpathSync(databasePath) || new Bun.CryptoHasher("sha256").update(readFileSync(resolve(marker.sourceRunDirectory, "memory.sqlite"))).digest("hex") !== marker.sourceDatabaseHash) throw new EvalFailure("PRIVATE_COPY_MISMATCH");
  for (const suffix of ["", "-wal", "-shm"]) {
    const sourcePath = resolve(marker.sourceRunDirectory!, `memory.sqlite${suffix}`), destinationPath = `${databasePath}${suffix}`;
    if (!existsSync(sourcePath) || !existsSync(destinationPath)) continue;
    const sourceStat = statSync(sourcePath), destinationStat = statSync(destinationPath);
    if (sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino) throw new EvalFailure("PRIVATE_COPY_MISMATCH");
  }
  const data = JSON.parse(readFileSync(casePath, "utf8")) as NormalizedLongCase, hashes = longCaseHashes(data);
  const backendState = JSON.parse(readFileSync(resolve(root, "backend-state.json"), "utf8")) as { endpoint: string; model: string; provider: string; startedAt: number; calls: number };
  if (backendState.endpoint !== "http://127.0.0.1:11234/v1/chat/completions" || backendState.model !== QWEN_MODEL || backendState.provider !== "mlx") throw new EvalFailure("BACKEND_RESUME_MISMATCH");
  const sourceBackendState = readFileSync(resolve(marker.sourceRunDirectory!, "backend-state.json"), "utf8");
  const freeze = { protocol: optionalParentProtocol, caseHash: hashes.caseHash, sourceHash: hash(readFileSync(import.meta.path, "utf8")), dependencyHashes: dependencyHashes(), copy: marker,
    sourceBackendStateHash: hash(sourceBackendState) };
  const freezePath = resolve(root, "optional-parent-freeze.json");
  if (existsSync(freezePath)) { if (JSON.stringify(JSON.parse(readFileSync(freezePath, "utf8"))) !== JSON.stringify(freeze)) throw new EvalFailure("CONTINUATION_RESUME_MISMATCH"); }
  else {
    if (hash(readFileSync(resolve(root, "backend-state.json"), "utf8")) !== freeze.sourceBackendStateHash) throw new EvalFailure("BACKEND_COPY_MISMATCH");
    saveMetadata(freezePath, freeze);
  }
  if (values.has("--dry-run")) {
    // A copied WAL database can require fresh journal files before metadata reads.
    const database = new Database(databasePath, { create: false, strict: true });
    try {
      const row = database.query("SELECT value FROM entities WHERE bucket='longEvaluation' AND id='identity'").get() as { value: string } | null;
      if (!row || row.value !== JSON.stringify({ ...hashes, source: data.source, protocol: longHistoryProtocol })) throw new EvalFailure("PREPARATION_RESUME_MISMATCH");
      console.log(JSON.stringify({ dryRun: true, expectedOriginals: data.messages.length, expectedPublications: Math.ceil(data.messages.length / 2),
        retainedOriginals: (database.query("SELECT count(*) n FROM sources").get() as { n: number }).n, cumulativeCalls: backendState.calls }));
    } finally { database.close(); }
    return;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  const backend = new ResumableLocalBackend({ url: backendState.endpoint, model: backendState.model, directory: root }), store = new Store(databasePath);
  try {
    const prepared = await prepareOptionalParentCase(backend, store, data, { onProgress: value => saveMetadata(resolve(root, "optional-parent-checkpoint.json"), value) });
    saveMetadata(resolve(root, "optional-parent-preparation.json"), { ...prepared.metrics, continuation: prepared.continuation });
    console.log(JSON.stringify({ phase: "complete", ...prepared.continuation, cumulativeCalls: backend.calls }));
  } finally { store.close(); }
}
if (import.meta.main) runOptionalParentCLI(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ error: errorCode(error) })); process.exitCode = 1; });

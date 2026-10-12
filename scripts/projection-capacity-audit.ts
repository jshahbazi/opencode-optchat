import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytes, hash, key, sessionTree, sharedTree, sourceKey, type Node, type Publication, type SourceRecord } from "../src/index.ts";
import { renderedBytes } from "../src/core/views.ts";
import { EvalFailure } from "./local-memory-eval.ts";
import { longCaseHashes, longHistoryProtocol, type NormalizedLongCase } from "./long-history-eval.ts";

export interface MinimumCover {
  complete: boolean; renderedBytes: number | null; nodeCount: number | null; eligibleNodeCount: number;
  ranges: { start: number; count: number }[];
}
// Dynamic programming permits subdivision when a stored parent costs more than its children.
export function minimumRenderedCover(nodes: Node[], tree: string, prefix: number): MinimumCover {
  if (!Number.isSafeInteger(prefix) || prefix < 0) throw new EvalFailure("INVALID_SHARED_PREFIX");
  const eligible = nodes.filter(node => node.tree === tree && typeof node.id === "string" && typeof node.text === "string" &&
    Number.isSafeInteger(node.start) && node.start >= 0 && Number.isSafeInteger(node.count) && node.count > 0 &&
    Number.isInteger(Math.log2(node.count)) && node.start % node.count === 0 && Number.isSafeInteger(node.start + node.count) && node.start + node.count <= prefix)
    .sort((a, b) => a.start - b.start || b.count - a.count || a.id.localeCompare(b.id));
  const groups = new Map<number, Node[]>();
  for (const node of eligible) { const group = groups.get(node.start) ?? []; group.push(node); groups.set(node.start, group); }
  type Step = { cost: number; count: number; previous?: number; node?: Node };
  const best = new Map<number, Step>([[0, { cost: 0, count: 0 }]]);
  for (const start of [...groups.keys()].sort((a, b) => a - b)) {
    const prior = best.get(start); if (!prior) continue;
    for (const node of groups.get(start)!) {
      const end = start + node.count, cost = prior.cost + renderedBytes([node]), count = prior.count + 1, old = best.get(end);
      if (!old || cost < old.cost || cost === old.cost && count < old.count) best.set(end, { cost, count, previous: start, node });
    }
  }
  const result = best.get(prefix), ranges: MinimumCover["ranges"] = [];
  if (!result) return { complete: false, renderedBytes: null, nodeCount: null, eligibleNodeCount: eligible.length, ranges };
  for (let end = prefix; end > 0;) { const step = best.get(end)!; ranges.unshift({ start: step.node!.start, count: step.node!.count }); end = step.previous!; }
  return { complete: true, renderedBytes: result.cost, nodeCount: result.count, eligibleNodeCount: eligible.length, ranges };
}
const entity = <T>(database: Database, bucket: string, id: string): T | undefined => {
  const row = database.query("SELECT value FROM entities WHERE bucket=? AND id=?").get(bucket, id) as { value: string } | null;
  return row ? JSON.parse(row.value) as T : undefined;
};
const storedCode = (error: string | null) => error?.match(/^(?:MemoryError|EvalFailure|Error): ([A-Z_0-9]{1,64})(?::|$)/)?.[1] ?? "UNKNOWN_FAILURE";
const digest = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
function covers(nodes: (Node | undefined)[], tree: string, start: number, end: number): boolean {
  let cursor = start;
  for (const node of nodes) {
    if (!node || node.tree !== tree || node.start !== cursor || !Number.isSafeInteger(node.count) || node.count <= 0 || cursor + node.count > end) return false;
    cursor += node.count;
  }
  return cursor === end;
}

export function auditProjectionCapacity(database: Database, data: NormalizedLongCase, budgetBytes = longHistoryProtocol.memoryBytes) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) throw new EvalFailure("INVALID_AUDIT_BUDGET");
  const hashes = longCaseHashes(data), sessionId = `archive-${hashes.caseHash.slice(0, 16)}`;
  const session = entity<{ scopeId: string; generation: number }>(database, "sessions", sessionId);
  if (!session || session.generation !== 0) throw new EvalFailure("AUDIT_SESSION_MISMATCH");
  const scope = entity<{ epoch: number; highWater: number }>(database, "scopes", session.scopeId);
  if (!scope || !Number.isSafeInteger(scope.epoch)) throw new EvalFailure("AUDIT_SCOPE_MISMATCH");
  const tree = sharedTree(session.scopeId, scope.epoch), localTree = sessionTree(sessionId, 0);
  const view = entity<{ tree: string; prefix: number; nodes: string[]; shrinking: boolean }>(database, "views", tree);
  if (!view || view.tree !== tree || !Array.isArray(view.nodes)) throw new EvalFailure("AUDIT_VIEW_MISMATCH");
  const sourceRows = database.query("SELECT id,value FROM sources ORDER BY seq").all() as { id: string; value: string }[];
  const sources = sourceRows.map(row => JSON.parse(row.value) as SourceRecord);
  const originalsExact = sources.length === data.messages.length && sources.every((source, index) => {
    const original = data.messages[index]!;
    return source.sessionId === sessionId && source.generation === 0 && source.seq === index && source.kind === original.role &&
      source.payload === original.text && source.payloadHash === hash(original.text) && source.eventKey === `original-${index}` &&
      source.turnId === `turn-${String(Math.floor(index / 2)).padStart(6, "0")}` && sourceRows[index]!.id === sourceKey(source);
  });
  const metadataExact = sources.every((source, index) => {
    const metadata = entity<{ originalId: unknown; seq: number; role: string; timeAnchor: string | null }>(database, "longOriginalMetadata", sourceKey(source));
    const original = data.messages[index];
    return original && metadata && metadata.originalId === original.originalId && metadata.seq === index && metadata.role === original.role && metadata.timeAnchor === original.timeAnchor;
  });
  const nodeRows = database.query("SELECT id,tree,start,count,value FROM nodes").all() as { id: string; tree: string; start: number; count: number; value: string }[];
  const nodes: Node[] = [], invalidNodeRows: number[] = [];
  for (const [index, row] of nodeRows.entries()) {
    const node = JSON.parse(row.value) as Node;
    if (node.id !== row.id || node.tree !== row.tree || node.start !== row.start || node.count !== row.count || typeof node.text !== "string" || node.bytes !== bytes(node.text)) invalidNodeRows.push(index);
    else nodes.push(node);
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const publicationRows = database.query("SELECT id,value FROM entities WHERE bucket='publications' ORDER BY json_extract(value,'$.publicationSeq')").all() as { id: string; value: string }[];
  const publications = publicationRows.map(row => JSON.parse(row.value) as Publication), expectedPublications = Math.ceil(data.messages.length / 2);
  const publicationsExact = publications.length === expectedPublications && publications.every((publication, index) => {
    const turnId = `turn-${String(index).padStart(6, "0")}`, leaf = byId.get(publication.nodeId);
    return publicationRows[index]!.id === publication.id && publication.id === hash(key(sessionId, 0, turnId)) && publication.sessionId === sessionId &&
      publication.generation === 0 && publication.scopeId === session.scopeId && publication.publicationSeq === index + 1 && publication.start === index * 2 &&
      publication.end === Math.min(data.messages.length, index * 2 + 2) && publication.turnId === turnId && publication.outcome === "completed" &&
      leaf?.tree === tree && leaf.start === index && leaf.count === 1 && leaf.publicationId === publication.id;
  });
  const publicationCoversExact = publications.every(publication => Array.isArray(publication.sourceCover) &&
    covers(publication.sourceCover.map(id => byId.get(id)), localTree, publication.start, publication.end));
  const frontier = view.nodes.map(id => byId.get(id)), frontierCoverExact = covers(frontier, tree, 0, view.prefix);
  const minimum = minimumRenderedCover(nodes, tree, view.prefix), jobs = database.query("SELECT status,count(*) count FROM jobs GROUP BY status ORDER BY status").all() as { status: string; count: number }[];
  const failureRows = database.query("SELECT input,error FROM jobs WHERE status='failed'").all() as { input: string; error: string | null }[];
  const failures = failureRows.map(row => {
    let input: any = {}; try { input = JSON.parse(row.input); } catch {}
    let treeKind = "unknown"; try { const kind = JSON.parse(input.tree)[0]; if (["session", "shared", "chunk"].includes(kind)) treeKind = kind; } catch {}
    return { type: ["leaf", "parent", "publication"].includes(input?.type) ? input.type as string : "unknown", treeKind,
      start: Number.isSafeInteger(input?.start) ? input.start as number : null, count: Number.isSafeInteger(input?.count) ? input.count as number : null,
      code: storedCode(row.error) };
  }).sort((a, b) => a.treeKind.localeCompare(b.treeKind) || (a.start ?? -1) - (b.start ?? -1) || (a.count ?? -1) - (b.count ?? -1));
  const failureCodes: Record<string, number> = {}, failureTreeKinds: Record<string, number> = {};
  for (const failure of failures) { failureCodes[failure.code] = (failureCodes[failure.code] ?? 0) + 1; failureTreeKinds[failure.treeKind] = (failureTreeKinds[failure.treeKind] ?? 0) + 1; }
  const counters = entity<{ modelCalls: number; correctionRetries: number; batchCalls: number }>(database, "longEvaluation", "summaryCounters");
  const summaryCounters = counters && [counters.modelCalls, counters.correctionRetries, counters.batchCalls].every(value => Number.isSafeInteger(value) && value >= 0)
    ? { modelCalls: counters.modelCalls, correctionRetries: counters.correctionRetries, batchCalls: counters.batchCalls } : null;
  const jobCounts = Object.fromEntries(jobs.map(row => [row.status, row.count]));
  const prefixExact = view.prefix === expectedPublications && scope.highWater === expectedPublications;
  return { version: "projection-capacity-audit-1", caseHash: hashes.caseHash, originalHash: hashes.originalHash,
    databaseSnapshotHash: digest(database.serialize()), budgetBytes,
    originals: { expected: data.messages.length, count: sources.length, bytes: sources.reduce((sum, source) => sum + bytes(source.payload), 0), exact: originalsExact, metadataExact },
    publications: { expected: expectedPublications, count: publications.length, exact: publicationsExact, sourceCoversExact: publicationCoversExact },
    shared: { treeHash: hash(tree), epoch: scope.epoch, prefix: view.prefix, highWater: scope.highWater, prefixExact, shrinking: view.shrinking,
      frontierCount: frontier.length, frontierCoverExact, frontierBytes: frontierCoverExact ? renderedBytes(frontier as Node[]) : null,
      minimum, fitsBudget: minimum.complete && minimum.renderedBytes! <= budgetBytes },
    invalidNodeRows: invalidNodeRows.length, summaryCounters,
    queue: { jobs: { pending: jobCounts.pending ?? 0, running: jobCounts.running ?? 0, done: jobCounts.done ?? 0, failed: jobCounts.failed ?? 0, revoked: jobCounts.revoked ?? 0 },
      publicationCandidates: (database.query("SELECT count(*) count FROM publication_candidates").get() as { count: number }).count,
      publicationDependencies: (database.query("SELECT count(*) count FROM publication_dependencies").get() as { count: number }).count },
    failures: { count: failures.length, byCode: failureCodes, byTreeKind: failureTreeKinds, coordinates: failures },
    verificationPassed: originalsExact && metadataExact && publicationsExact && publicationCoversExact && prefixExact && frontierCoverExact && invalidNodeRows.length === 0 };
}

export function runProjectionCapacityAudit(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!["--case", "--run"].includes(args[index]!) || !args[index + 1] || args[index + 1]!.startsWith("--")) throw new EvalFailure("INVALID_CLI");
    values.set(args[index]!, args[index + 1]!);
  }
  if (!values.has("--case") || !values.has("--run")) throw new EvalFailure("EXPLICIT_AUDIT_REQUIRED");
  const caseText = readFileSync(resolve(values.get("--case")!), "utf8"), data = JSON.parse(caseText) as NormalizedLongCase, root = resolve(values.get("--run")!);
  const database = new Database(resolve(root, "memory.sqlite"), { readonly: true, create: false, strict: true });
  let audit: ReturnType<typeof auditProjectionCapacity>;
  try { database.exec("BEGIN"); audit = auditProjectionCapacity(database, data); database.exec("ROLLBACK"); } finally { database.close(); }
  const artifact = { ...audit, caseFileHash: hash(caseText), sourceHash: hash(readFileSync(import.meta.path, "utf8")) };
  const text = JSON.stringify(artifact, null, 2) + "\n", path = resolve(root, "projection-capacity-audit.json");
  if (existsSync(path)) { if (readFileSync(path, "utf8") !== text) throw new EvalFailure("AUDIT_ARTIFACT_MISMATCH"); }
  else writeFileSync(path, text, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ verificationPassed: audit.verificationPassed, originalCount: audit.originals.count, publicationCount: audit.publications.count,
    frontierBytes: audit.shared.frontierBytes, minimumCoverBytes: audit.shared.minimum.renderedBytes, fitsBudget: audit.shared.fitsBudget, artifactHash: hash(text) }));
  return artifact;
}
if (import.meta.main) {
  try { runProjectionCapacityAudit(process.argv.slice(2)); }
  catch (error) { const code = (error as { code?: unknown })?.code; console.error(JSON.stringify({ error: typeof code === "string" && /^[A-Z_0-9]{1,64}$/.test(code) ? code : "AUDIT_FAILURE" })); process.exitCode = 1; }
}

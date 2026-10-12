import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Engine, Store, bytes, hash, sourceKey, type Node, type Publication } from "../src/index.ts";
import { renderedBytes } from "../src/core/views.ts";
import { longCaseHashes, type NormalizedLongCase } from "../scripts/long-history-eval.ts";
import { auditProjectionCapacity, minimumRenderedCover } from "../scripts/projection-capacity-audit.ts";

const stores: Store[] = [], readers: Database[] = [], directories: string[] = [];
afterEach(() => { for (const reader of readers.splice(0)) reader.close(); for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function node(id: string, start: number, count: number, text: string, tree = "shared-tree"): Node {
  return { id, tree, start, count, text, bytes: bytes(text), children: [], inputs: [], model: "fixture", promptVersion: "fixture", fallback: false };
}
function data(): NormalizedLongCase {
  return { version: 1, source: { repoRevision: "fixture", scaleLabel: "fixture", conversationId: "fixture", rawChatHash: hash("chat"), rawProbeHash: hash("probe"), license: "fixture" },
    messages: Array.from({ length: 4 }, (_, seq) => ({ seq, role: seq % 2 ? "assistant" : "user", text: `PRIVATE_ORIGINAL_SENTINEL ${seq}`, originalId: seq + 1, timeAnchor: null })),
    questions: [{ id: "fixture", category: "fixture", question: "PRIVATE_QUESTION_SENTINEL", referenceAnswer: "PRIVATE_GOLD_SENTINEL", rubric: "PRIVATE_RUBRIC_SENTINEL", sourceReferences: [1], resolvedMessageSeqs: [0], unresolvedReferences: [] }] };
}
async function fixture() {
  const normalized = data(), hashes = longCaseHashes(normalized), sessionId = `archive-${hashes.caseHash.slice(0, 16)}`, scopeId = `scope-${hashes.caseHash.slice(0, 16)}`;
  const directory = mkdtempSync(resolve(tmpdir(), "projection-capacity-fixture-")); directories.push(directory);
  const path = resolve(directory, "memory.sqlite"), store = new Store(path); stores.push(store);
  const engine = new Engine(store); engine.register(sessionId, scopeId, "beam-public-evaluation");
  for (let start = 0; start < normalized.messages.length; start += 2) {
    const turnId = `turn-${String(start / 2).padStart(6, "0")}`; engine.admit(sessionId, turnId);
    for (const message of normalized.messages.slice(start, start + 2)) {
      const original = engine.append({ sessionId, generation: 0, turnId, eventKey: `original-${message.seq}`, kind: message.role, projectId: "beam-public-evaluation",
        timestamp: "2026-10-12T00:00:00Z", payload: message.text });
      store.set("longOriginalMetadata", sourceKey(original), { originalId: message.originalId, seq: message.seq, role: message.role, timeAnchor: message.timeAnchor });
    }
    engine.finish(sessionId, turnId, "completed", "2026-10-12T00:00:00Z"); await engine.drain();
  }
  const reader = new Database(path, { readonly: true, create: false, strict: true }); readers.push(reader);
  return { normalized, engine, store, reader };
}

test("minimum cover reports gaps without inventing a partial-prefix result", () => {
  const result = minimumRenderedCover([node("first", 0, 2, "First range."), node("last", 3, 1, "Last range.")], "shared-tree", 4);
  expect(result).toEqual({ complete: false, renderedBytes: null, nodeCount: null, eligibleNodeCount: 2, ranges: [] });
});

test("minimum cover chooses cheaper subdivisions instead of an expensive durable parent", () => {
  const leaves = [node("a", 0, 1, "A"), node("b", 1, 1, "B")], parent = node("parent", 0, 2, "Large parent. ".repeat(50));
  const result = minimumRenderedCover([parent, ...leaves], "shared-tree", 2);
  expect(result.complete).toBe(true); expect(result.renderedBytes).toBe(renderedBytes(leaves)); expect(result.nodeCount).toBe(2);
  expect(result.ranges).toEqual([{ start: 0, count: 1 }, { start: 1, count: 1 }]);
});

test("minimum cover filters foreign trees, future nodes, and invalid dyadic coordinates", () => {
  const valid = node("valid", 0, 2, "Required evidence.");
  const result = minimumRenderedCover([valid, node("foreign", 0, 2, "", "old-epoch"), node("future", 0, 4, ""), node("negative", -2, 2, ""), node("unaligned", 1, 2, ""), node("nondyadic", 0, 3, "")], "shared-tree", 2);
  expect(result.eligibleNodeCount).toBe(1); expect(result.renderedBytes).toBe(renderedBytes([valid]));
  expect(minimumRenderedCover([valid], "shared-tree", 0)).toEqual({ complete: true, renderedBytes: 0, nodeCount: 0, eligibleNodeCount: 0, ranges: [] });
});

test("cover cost measures UTF-8 rendering, identifiers, escaping, and newline bytes", () => {
  const original = node("identifier", 0, 1, 'α😀<&>"'); original.bytes = 1;
  const expected = Buffer.byteLength("identifier | α😀&lt;&amp;&gt;&quot;\n", "utf8");
  expect(minimumRenderedCover([original], "shared-tree", 1).renderedBytes).toBe(expected);
  expect(expected).toBeGreaterThan(bytes(original.text));
});

test("audit verifies originals, publication covers, current prefix, and private metadata exclusion", async () => {
  const { normalized, reader, store } = await fixture();
  store.set("longEvaluation", "summaryCounters", { modelCalls: 7, correctionRetries: 2, batchCalls: 1 });
  const audit = auditProjectionCapacity(reader, normalized);
  expect(audit.verificationPassed).toBe(true);
  expect(audit.originals).toMatchObject({ expected: 4, count: 4, exact: true, metadataExact: true });
  expect(audit.publications).toEqual({ expected: 2, count: 2, exact: true, sourceCoversExact: true });
  expect(audit.shared.prefix).toBe(2); expect(audit.shared.minimum.complete).toBe(true); expect(audit.shared.fitsBudget).toBe(true);
  expect(audit.summaryCounters).toEqual({ modelCalls: 7, correctionRetries: 2, batchCalls: 1 });
  for (const marker of ["PRIVATE_ORIGINAL_SENTINEL", "PRIVATE_QUESTION_SENTINEL", "PRIVATE_GOLD_SENTINEL", "PRIVATE_RUBRIC_SENTINEL"]) expect(JSON.stringify(audit)).not.toContain(marker);
  expect(reader.query("SELECT count(*) count FROM sources").get()).toEqual({ count: 4 });
  expect(() => reader.query("DELETE FROM sources").run()).toThrow();
});

test("audit records failure codes and queue counts without including error content", async () => {
  const { normalized, reader, store, engine } = await fixture();
  const tree = engine.scope(engine.session(`archive-${longCaseHashes(normalized).caseHash.slice(0, 16)}`).scopeId);
  const id = store.enqueue({ type: "parent", tree: JSON.stringify(["shared", tree.id, tree.epoch]), start: 4, count: 4, children: [] });
  store.db.query("UPDATE jobs SET status='failed',error='MemoryError: SUMMARY_SIZE: PRIVATE_ERROR_SENTINEL' WHERE id=?").run(id);
  const audit = auditProjectionCapacity(reader, normalized);
  expect(audit.queue.jobs.failed).toBe(1); expect(audit.queue.jobs.pending).toBe(0); expect(audit.queue.jobs.running).toBe(0);
  expect(audit.failures.byCode).toEqual({ SUMMARY_SIZE: 1 }); expect(audit.failures.byTreeKind).toEqual({ shared: 1 });
  expect(audit.failures.coordinates).toEqual([{ type: "parent", treeKind: "shared", start: 4, count: 4, code: "SUMMARY_SIZE" }]);
  expect(JSON.stringify(audit)).not.toContain("PRIVATE_ERROR_SENTINEL");
});

test("original changes and publication coverage changes fail verification", async () => {
  const { normalized, reader, store } = await fixture();
  const publication = store.all<Publication>("publications")[0]!; publication.sourceCover = [];
  store.set("publications", publication.id, publication);
  let audit = auditProjectionCapacity(reader, normalized);
  expect(audit.publications.sourceCoversExact).toBe(false); expect(audit.verificationPassed).toBe(false);
  store.db.query("UPDATE sources SET value=json_set(value,'$.payload','Changed synthetic original') WHERE seq=0").run();
  audit = auditProjectionCapacity(reader, normalized);
  expect(audit.originals.exact).toBe(false); expect(audit.verificationPassed).toBe(false);
});

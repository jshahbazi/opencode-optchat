import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Engine, Store, FakeSummarizer, Retrieval, key, sessionTree, type Publication, type Summarizer, type Turn } from "../src/index.ts";

const stores = new Set<Store>(), directories: string[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function open(path = ":memory:", summarizer?: Summarizer, options = {}): Engine {
  const store = new Store(path); stores.add(store);
  return new Engine(store, summarizer, options);
}
function close(engine: Engine) { stores.delete(engine.store); engine.store.close(); }
function databasePath() {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "optchat-publication-test-"));
  directories.push(directory); return join(directory, "memory.sqlite");
}
function register(engine: Engine, ...sessions: string[]) { for (const id of sessions) engine.register(id, "scope", "project"); }
function begin(engine: Engine, sessionId: string, turnId: string, count: number) {
  engine.admit(sessionId, turnId);
  for (let i = 0; i < count; i++) engine.append({ sessionId, turnId, generation: engine.session(sessionId).generation, eventKey: `${turnId}-${i}`,
    projectId: "project", kind: "user", timestamp: "2026-10-12T00:00:00Z", payload: `Synthetic evidence ${sessionId} ${turnId} ${i}` });
}
const publications = (engine: Engine) => engine.store.all<Publication>("publications").sort((a, b) => a.publicationSeq - b.publicationSeq);
function pending(engine: Engine, table: "publication_candidates" | "publication_dependencies") {
  return (engine.store.db.query(`SELECT count(*) count FROM ${table}`).get() as { count: number }).count;
}

test("node commits wake exact dependencies across interleaved turns and restart", async () => {
  const path = databasePath(), first = open(path);
  register(first, "a", "b", "reader");
  const snapshot = first.admit("reader", "pinned").snapshot;
  begin(first, "a", "first", 1); begin(first, "b", "second", 1);
  first.finish("b", "second", "failed"); first.finish("a", "first", "interrupted");
  expect(pending(first, "publication_dependencies")).toBe(2);
  await first.workOne();
  expect(first.store.db.query("SELECT tree FROM publication_dependencies").all()).toEqual([{ tree: sessionTree("b", 0) }]);
  expect(first.store.db.query("SELECT queued FROM publication_candidates WHERE turnKey=?").get(key("a", 0, "first"))).toEqual({ queued: 1 });
  close(first);

  const next = open(path);
  expect(next.admit("reader", "pinned").snapshot).toEqual(snapshot);
  expect(() => next.admit("reader", "another")).toThrow("TURN_ACTIVE");
  await next.drain();
  expect(publications(next).map(p => [p.sessionId, p.publicationSeq, p.outcome])).toEqual([["a", 1, "interrupted"], ["b", 2, "failed"]]);
  expect(new Retrieval(next).search(snapshot, "Synthetic").hits).toEqual([]);
  expect(pending(next, "publication_candidates")).toBe(0);
  expect(pending(next, "publication_dependencies")).toBe(0);
  next.finish("a", "first", "interrupted"); next.finish("b", "second", "failed"); await next.drain();
  expect(publications(next)).toHaveLength(2);
});

test("version 2 migration reconstructs unresolved covers without repeating accepted publications", async () => {
  const path = databasePath(), first = open(path);
  register(first, "a", "b", "reader");
  begin(first, "a", "accepted", 1); first.finish("a", "accepted", "completed"); await first.drain();
  const accepted = publications(first)[0]!;
  const snapshot = first.admit("reader", "pinned").snapshot;
  begin(first, "a", "waiting", 3); first.finish("a", "waiting", "failed");
  begin(first, "b", "empty", 0); first.finish("b", "empty", "interrupted");
  close(first);
  const legacy = new Database(path);
  legacy.exec(`
    DROP TRIGGER publication_candidate_insert;
    DROP TRIGGER publication_candidate_update;
    DROP TRIGGER publication_candidate_turn_delete;
    DROP TRIGGER publication_candidate_published;
    DROP TABLE publication_dependencies;
    DROP TABLE publication_candidates;
    PRAGMA user_version=2;
  `);
  legacy.close();

  const migrated = open(path);
  expect(migrated.store.db.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
  expect(migrated.admit("reader", "pinned").snapshot).toEqual(snapshot);
  expect(pending(migrated, "publication_candidates")).toBe(2);
  expect(pending(migrated, "publication_dependencies")).toBe(2);
  await migrated.drain();
  expect(publications(migrated)).toHaveLength(3);
  expect(publications(migrated)[0]).toEqual(accepted);
  expect(publications(migrated).map(p => [p.turnId, p.publicationSeq])).toEqual([["accepted", 1], ["empty", 2], ["waiting", 3]]);
  expect(pending(migrated, "publication_candidates")).toBe(0);
});

test("failed publication claims remain failed through restart until explicit retry", async () => {
  const path = databasePath(), fixture = new FakeSummarizer(); let fail = true;
  const summarizer: Summarizer = { summarize: async text => {
    let input: any; try { input = JSON.parse(text); } catch {}
    if (fail && input?.historicalEvidence) throw new Error("fixture publication unavailable");
    return fixture.summarize(text);
  } };
  const first = open(path, summarizer); register(first, "a");
  begin(first, "a", "failed", 1); first.finish("a", "failed", "completed");
  await first.workOne();
  await expect(first.workOne()).rejects.toThrow("fixture publication unavailable");
  const failed = first.store.db.query("SELECT id,status,fence,attempts FROM jobs WHERE status='failed'").get();
  expect(pending(first, "publication_candidates")).toBe(1);
  close(first);

  const next = open(path, summarizer); await next.drain();
  expect(next.store.db.query("SELECT id,status,fence,attempts FROM jobs WHERE status='failed'").get()).toEqual(failed);
  expect(publications(next)).toHaveLength(0);
  fail = false; next.retryFailed(); await next.drain();
  expect(publications(next)).toHaveLength(1);
  expect(pending(next, "publication_candidates")).toBe(0);
  await next.drain(); expect(publications(next)).toHaveLength(1);
});

test("retention removes old generation waits and retains another session's pending publication", async () => {
  const engine = open(); register(engine, "a", "b", "reader");
  begin(engine, "a", "accepted", 2); engine.finish("a", "accepted", "completed"); await engine.drain();
  const accepted = publications(engine)[0]!, snapshot = engine.admit("reader", "pinned").snapshot;
  begin(engine, "a", "removed", 3); engine.finish("a", "removed", "completed");
  begin(engine, "b", "retained", 3); engine.finish("b", "retained", "failed");
  engine.retire("a", "edit", 2);
  expect(engine.store.db.query("SELECT 1 FROM publication_dependencies WHERE tree=?").get(sessionTree("a", 0))).toBeNull();
  expect(engine.store.db.query("SELECT 1 FROM publication_candidates WHERE turnKey=?").get(key("a", 0, "removed"))).toBeNull();
  expect(() => engine.validateSnapshot(snapshot)).toThrow("SNAPSHOT_REVOKED");
  await engine.drain();
  expect(publications(engine).map(p => [p.sessionId, p.turnId, p.publicationSeq, p.generation])).toEqual([["a", "accepted", accepted.publicationSeq, 1], ["b", "retained", 2, 0]]);
  begin(engine, "a", "new", 1); engine.finish("a", "new", "interrupted"); await engine.drain();
  expect(publications(engine).map(p => p.publicationSeq)).toEqual([1, 2, 3]);
  expect(pending(engine, "publication_candidates")).toBe(0);
  expect(pending(engine, "publication_dependencies")).toBe(0);
});

test("two stores consume shared publication dependencies without duplicates", async () => {
  const path = databasePath(), first = open(path); register(first, "a", "b");
  begin(first, "a", "first", 5); first.finish("a", "first", "completed");
  begin(first, "b", "second", 3); first.finish("b", "second", "completed");
  const peer = open(path);
  await Promise.all([first.drain(1000, undefined, 2), peer.drain(1000, undefined, 2)]);
  expect(publications(first)).toHaveLength(2);
  expect(new Set(publications(first).map(p => p.publicationSeq)).size).toBe(2);
  expect(pending(first, "publication_candidates")).toBe(0);
  expect(pending(first, "publication_dependencies")).toBe(0);
  expect(first.store.db.query("SELECT 1 FROM jobs WHERE status IN ('pending','running','failed') LIMIT 1").get()).toBeNull();
});

test("bounded turn lookup rejects cross-turn parents and selects nonempty turns at tied starts", async () => {
  const engine = open(); register(engine, "a");
  for (const [id, count] of [["first", 2], ["empty", 0], ["second", 2]] as const) {
    begin(engine, "a", id, count); engine.finish("a", id, "completed"); await engine.drain();
  }
  expect(engine.store.completedTurnForRange("a", 0, 2, 3)?.id).toBe("second");
  expect(engine.store.completedTurnForRange("a", 0, 1, 3)).toBeUndefined();
  expect(engine.store.completedTurnForRange("a", 1, 2, 3)).toBeUndefined();
});

test("hot scheduler queries use coordinate, active-turn, completed-turn, and pending-job indexes", () => {
  const { store } = open();
  const plans = [
    ["SELECT 1 FROM entities WHERE bucket='turns' AND json_extract(value,'$.outcome') IS NULL AND json_extract(value,'$.sessionId')='a' AND json_extract(value,'$.generation')=0 LIMIT 1", "turns_active"],
    ["SELECT value FROM entities WHERE bucket='turns' AND json_extract(value,'$.outcome') IS NOT NULL AND json_extract(value,'$.end') IS NOT NULL AND json_extract(value,'$.sessionId')='a' AND json_extract(value,'$.generation')=0 AND json_extract(value,'$.start')<=100 ORDER BY json_extract(value,'$.start') DESC,json_extract(value,'$.end') DESC LIMIT 1", "turns_completed_range"],
    ["SELECT turnKey FROM publication_dependencies WHERE tree='tree' AND start=100 AND count=4 ORDER BY turnKey", "publication_dependencies_coordinate"],
    ["SELECT min(rowid) FROM jobs WHERE status='pending'", "jobs_status"],
  ];
  for (const [sql, index] of plans) {
    const plan = store.db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
    expect(plan.some(row => row.detail.includes(`USING INDEX ${index}`) || row.detail.includes(`USING COVERING INDEX ${index}`))).toBe(true);
    expect(plan.some(row => row.detail.startsWith("SCAN "))).toBe(false);
  }
});

test("publication discovery counters grow with turns instead of complete-history scans", async () => {
  async function measure(turns: number) {
    const fixture = new FakeSummarizer();
    const engine = open(undefined, { summarize: text => fixture.summarize(text), summarizeBatch: inputs => Promise.all(inputs.map(text => fixture.summarize(text))) }, { parentBatchSize: 4, leafBatchSize: 4 });
    const store = engine.store; register(engine, "archive");
    let activeLookups = 0, dependencyLookups = 0, dependencyMatches = 0, turnReads = 0, rangeLookups = 0;
    const originalActive = store.hasActiveTurn.bind(store), originalDependents = store.publicationDependents.bind(store);
    const originalGet = store.get.bind(store), originalAll = store.all.bind(store), originalRange = store.completedTurnForRange.bind(store);
    store.hasActiveTurn = (...args) => { activeLookups++; return originalActive(...args); };
    store.publicationDependents = (...args) => { dependencyLookups++; const matches = originalDependents(...args); dependencyMatches += matches.length; return matches; };
    store.get = <T>(bucket: string, id: string): T | undefined => { if (bucket === "turns") turnReads++; return originalGet<T>(bucket, id); };
    store.all = <T>(bucket: string): T[] => { if (bucket === "turns") throw new Error("Full turn history scan reached the hot scheduler"); return originalAll<T>(bucket); };
    store.completedTurnForRange = (...args) => { rangeLookups++; return originalRange(...args); };
    for (let i = 0; i < turns; i++) {
      const id = `turn-${i}`; begin(engine, "archive", id, 1); engine.finish("archive", id, "completed"); await engine.drain();
    }
    expect(publications(engine)).toHaveLength(turns);
    expect(activeLookups).toBe(turns); expect(dependencyMatches).toBe(turns);
    expect(dependencyLookups).toBeLessThanOrEqual(2 * turns);
    expect(rangeLookups).toBeLessThanOrEqual(2 * turns);
    expect(turnReads).toBeLessThanOrEqual(8 * turns);
    return { turns, work: activeLookups + dependencyLookups + dependencyMatches + turnReads + rangeLookups };
  }
  const small = await measure(128), medium = await measure(256), large = await measure(512);
  expect(medium.work / small.work).toBeLessThan(2.1);
  expect(large.work / medium.work).toBeLessThan(2.1);
}, 10000);

import { Engine, Store, insist } from "../src/index.ts";

const selected = process.argv.slice(2).map(Number);
const sizes = selected.length ? selected : [128, 256, 512, 1024, 2048, 4096];
insist(sizes.length <= 8 && sizes.every(n => Number.isSafeInteger(n) && n > 0 && n <= 16384), "PROBE_CONFIG", "Use up to eight turn counts between 1 and 16384");

const results: Record<string, unknown>[] = [];
for (const turns of sizes) {
  const store = new Store();
  const originalAll = store.all;
  let turnScans = 0, turnRowsParsed = 0;
  const indexedCalls: Record<string, number> = {};
  let matchedDependencies = 0;
  for (const method of ["hasActiveTurn", "hasStagedRecords", "completedTurnForRange", "unpreparedPublicationKeys", "readyPublicationKeys", "publicationDependents"] as const) {
    const original = store[method].bind(store);
    (store as any)[method] = (...args: any[]) => {
      indexedCalls[method] = (indexedCalls[method] ?? 0) + 1;
      const result = (original as any)(...args);
      if (method === "publicationDependents") matchedDependencies += result.length;
      return result;
    };
  }
  store.all = function<T>(bucket: string): T[] {
    const rows = originalAll.call(this, bucket) as T[];
    if (bucket === "turns") { turnScans++; turnRowsParsed += rows.length; }
    return rows;
  };
  try {
    const engine = new Engine(store);
    engine.register("probe", "probe-scope", "probe-project");
    const started = performance.now();
    for (let i = 0; i < turns; i++) {
      const id = `turn-${i}`;
      engine.admit("probe", id);
      engine.append({ sessionId: "probe", generation: 0, turnId: id, eventKey: id, kind: "user", payload: `Synthetic evidence ${i}`, timestamp: "2026-10-11T00:00:00Z", projectId: "probe-project" });
      engine.finish("probe", id, "completed");
      await engine.drain();
    }
    results.push({ turns, turnScans, turnRowsParsed, indexedCalls, matchedDependencies, elapsedMs: Math.round(performance.now() - started) });
  } finally { store.close(); }
}
console.log(JSON.stringify({ note: "Counts measure publication discovery. Timings include ingestion with a drained frontier. Other frontier and backlog costs remain. Each timing is one local sample.", summarizer: "deterministic-fixture", results }, null, 2));

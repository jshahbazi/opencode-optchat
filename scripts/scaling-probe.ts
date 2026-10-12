import { Engine, Store, insist } from "../src/index.ts";

const selected = process.argv.slice(2).map(Number);
const sizes = selected.length ? selected : [128, 256, 512];
insist(sizes.length <= 6 && sizes.every(n => Number.isSafeInteger(n) && n > 0 && n <= 2048), "PROBE_CONFIG", "Use up to six turn counts between 1 and 2048");

const results: { turns: number; turnScans: number; turnRowsParsed: number; elapsedMs: number }[] = [];
for (const turns of sizes) {
  const store = new Store();
  const originalAll = store.all;
  let turnScans = 0, turnRowsParsed = 0;
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
    results.push({ turns, turnScans, turnRowsParsed, elapsedMs: Math.round(performance.now() - started) });
  } finally { store.close(); }
}
console.log(JSON.stringify({ note: "Turn rows count parsing work. Timings are one local sample, not a provider or production benchmark.", summarizer: "deterministic-fixture", results }, null, 2));

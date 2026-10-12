import { expect, test } from "bun:test";
import { Engine, Store, assembleContext, bytes, type Node } from "../src/index.ts";
import { mergeView, renderedBytes } from "../src/core/views.ts";

test("proposal comparison records the current exclusive-end merge order", () => {
  const node = (start: number, count: number, text = "x".repeat(200)): Node => ({ id: `${start}:${count}`, tree: "proposal-fixture", start, count, text, children: [], inputs: [], bytes: bytes(text), model: "fixture", promptVersion: "1", fallback: false });
  const nodes = [node(0, 4), node(4, 4), node(8, 1), node(9, 1), node(0, 8, "old-parent"), node(8, 2, "new-parent")];
  const get = (id: string) => nodes.find(n => n.id === id)!;
  const find = (start: number, count: number) => nodes.find(n => n.start === start && n.count === count);
  const view = { tree: "proposal-fixture", revision: 1, prefix: 10, nodes: nodes.slice(0, 4).map(n => n.id), shrinking: false };
  const size = renderedBytes(view.nodes.map(get));
  const implementation = mergeView(view, get, find, size - 1, size - 100).nodes;
  const proposal = ["0:4", "4:4", "8:2"];
  expect(implementation).toEqual(["0:8", "8:1", "9:1"]);
  expect(implementation).not.toEqual(proposal);
});

test("proposal comparison detects changing metadata before unchanged historical nodes", () => {
  const store = new Store();
  try {
    const engine = new Engine(store);
    engine.register("child", "probe-scope", "probe-project", "parent");
    const budget = { contextTokens: 8000, outputTokens: 1000, safetyTokens: 1000, memoryBytes: 16000 };
    const first = engine.admit("child", "one").snapshot;
    const left = assembleContext(engine, { system: [], tools: {}, live: [], snapshot: first, budget }).memory;
    engine.finish("child", "one", "completed");
    const second = engine.admit("child", "two").snapshot;
    const right = assembleContext(engine, { system: [], tools: {}, live: [], snapshot: second, budget }).memory;
    let common = 0;
    while (common < Math.min(left.length, right.length) && left[common] === right[common]) common++;
    expect(first.view).toEqual(second.view);
    expect(first.ownBoundary).toBe(second.ownBoundary);
    expect(first.id).not.toBe(second.id);
    expect(common).toBeLessThan(left.indexOf("<optchat-shared-data>"));
    expect(left.slice(left.indexOf("<optchat-shared-data>"))).toBe(right.slice(right.indexOf("<optchat-shared-data>")));
  } finally { store.close(); }
});

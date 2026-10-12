import { afterEach, expect, test } from "bun:test";
import { Engine, Store, hash, key, sessionTree, sharedTree, type JobInput, type Publication } from "../src/index.ts";
import { EvalFailure, type Backend } from "../scripts/local-memory-eval.ts";
import { longCaseHashes, longCompactorSystem, prepareLongCase, type NormalizedLongCase } from "../scripts/long-history-eval.ts";
import { classifyParentFailure, drainOptionalParents, prepareOptionalParentCase } from "../scripts/optional-parent-preparation.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function memory() { const store = new Store(); stores.push(store); return store; }
function data(count = 8): NormalizedLongCase {
  return { version: 1, source: { repoRevision: "fixture", scaleLabel: "fixture", conversationId: "fixture", rawChatHash: hash("chat"), rawProbeHash: hash("probe"), license: "fixture" },
    messages: Array.from({ length: count }, (_, seq) => ({ seq, role: seq % 2 ? "assistant" : "user", text: `Original ${seq} ` + "synthetic evidence ".repeat(120), originalId: seq + 1, timeAnchor: null })),
    questions: [{ id: "fixture", category: "fixture", question: "QUESTION_ONLY_SENTINEL", referenceAnswer: "GOLD_ONLY_SENTINEL", rubric: "RUBRIC_ONLY_SENTINEL", sourceReferences: [1], resolvedMessageSeqs: [0], unresolvedReferences: [] }] };
}
function backend(options: { failShared?: boolean; failLeaf?: boolean; failTurnParent?: boolean; failPublication?: boolean; globalLimit?: boolean } = {}): Backend & { calls: number; prompts: string[] } {
  return { calls: 0, prompts: [], async complete(messages, tools, stage, tokens) {
    this.calls++; this.prompts.push(JSON.stringify(messages));
    expect(messages[0]).toEqual({ role: "system", content: longCompactorSystem }); expect(tools).toEqual([]);
    expect(stage).toBe("summary:optchat"); expect(tokens).toBe(1024);
    if (options.globalLimit) throw new EvalFailure("CALL_LIMIT");
    const prompt = messages.find(message => message.role === "user")!.content!;
    const input: unknown = JSON.parse(prompt.split("UNTRUSTED_JSON_DATA:\n").at(-1)!);
    const rejected = "x".repeat(2048), leaf = "Leaf fixture evidence. ".repeat(14), parent = "Session fixture evidence. ".repeat(options.failPublication ? 22 : 10);
    let text: string;
    if (Array.isArray(input)) text = JSON.stringify(input.map((item: { id: number }) => ({ id: item.id, text: options.failLeaf ? rejected : leaf })));
    else {
      const body = String(input); let parsed: any; try { parsed = JSON.parse(body); } catch {}
      if (parsed?.historicalEvidence) text = options.failPublication ? rejected : "Publication fixture evidence. ".repeat(11);
      else if (body.includes("Publication fixture") || body.split('"historicalEvidence"').length > 2) text = options.failShared ? rejected : "Shared fixture evidence. ".repeat(10);
      else if (body.includes("Leaf fixture")) text = options.failTurnParent ? rejected : parent;
      else text = options.failLeaf ? rejected : leaf;
    }
    return { message: { role: "assistant", content: text }, inputTokens: 1, outputTokens: 1 };
  } };
}

test("optional shared failures preserve accepted originals and publications through complete preparation", async () => {
  const fixture = data(), store = memory(), model = backend({ failShared: true });
  await expect(prepareLongCase(model, store, fixture)).rejects.toThrow("SUMMARY_SIZE");
  const retainedSources = store.db.query("SELECT id,value FROM sources ORDER BY id").all();
  const retainedPublications = store.all("publications"), retainedFailures = store.db.query("SELECT * FROM jobs WHERE status='failed' ORDER BY id").all();
  expect(retainedSources).toHaveLength(4); expect(retainedPublications).toHaveLength(2); expect(retainedFailures).toHaveLength(1);
  const prepared = await prepareOptionalParentCase(model, store, fixture);
  expect(prepared.sources.map(source => source.payload)).toEqual(fixture.messages.map(message => message.text));
  expect(prepared.sources.map(source => source.kind)).toEqual(fixture.messages.map(message => message.role));
  expect(prepared.metrics.publications).toBe(4); expect(prepared.snapshot.view.prefix).toBe(4);
  expect(prepared.metrics.projectionBytes).toBeLessThanOrEqual(16000); expect(prepared.continuation.status).toBe("prepared");
  expect(prepared.continuation.optionalFailureCount).toBeGreaterThanOrEqual(1); expect(prepared.continuation.mandatoryFailureCount).toBe(0);
  expect(prepared.continuation.failures.every(failure => failure.coveredByChildren)).toBe(true);
  for (const row of retainedSources as { id: string; value: string }[]) expect(store.db.query("SELECT id,value FROM sources WHERE id=?").get(row.id)).toEqual(row);
  for (const publication of retainedPublications as Publication[]) expect(store.get<Publication>("publications", publication.id)).toEqual(publication);
  for (const row of retainedFailures as { id: string }[]) expect(store.db.query("SELECT * FROM jobs WHERE id=?").get(row.id)).toEqual(row);
  for (const marker of ["QUESTION_ONLY_SENTINEL", "GOLD_ONLY_SENTINEL", "RUBRIC_ONLY_SENTINEL"]) expect(model.prompts.some(prompt => prompt.includes(marker))).toBe(false);
  const calls = model.calls;
  const resumed = await prepareOptionalParentCase(model, store, fixture);
  expect(model.calls).toBe(calls); expect(resumed.snapshot).toEqual(prepared.snapshot);
  expect(resumed.continuation.initialOriginalCount).toBe(4); expect(resumed.continuation.initialPublicationCount).toBe(2);
});

test("new mandatory leaves and turn parents halt continuation", async () => {
  for (const options of [{ failLeaf: true }, { failTurnParent: true }, { failPublication: true }]) {
    const store = memory();
    await expect(prepareOptionalParentCase(backend(options), store, data(2))).rejects.toThrow();
    const report = store.get<{ status: string; mandatoryFailureCount: number; terminalError: string }>("optionalParentPreparation", "report")!;
    expect(report.status).toBe("halted"); expect(report.mandatoryFailureCount).toBeGreaterThan(0);
    expect(store.all("publications")).toHaveLength(0);
    const types = (store.db.query("SELECT json_extract(input,'$.type') type FROM jobs WHERE status='failed'").all() as { type: string }[]).map(row => row.type);
    expect(types).toContain("failLeaf" in options ? "leaf" : "failTurnParent" in options ? "parent" : "publication");
  }
});

test("classification rejects publication dependencies and never retries mandatory failed jobs", async () => {
  const store = memory(), engine = new Engine(store); engine.register("a", "scope", "project");
  const inputs: JobInput[] = [
    { type: "leaf", tree: sessionTree("a", 0), start: 0, source: "fixture" },
    { type: "parent", tree: sessionTree("a", 0), start: 0, count: 2, children: [] },
    { type: "publication", turnKey: key("a", 0, "turn"), scopeId: "scope", cover: [] },
    { type: "parent", tree: key("chunk", "fixture", 0, 0), start: 0, count: 4, children: [] },
  ];
  for (const input of inputs) {
    const id = store.enqueue(input); store.db.query("UPDATE jobs SET status='failed',error='MemoryError: SUMMARY_SIZE: fixture' WHERE id=?").run(id);
  }
  const initial = store.db.query("SELECT * FROM jobs ORDER BY id").all();
  await expect(drainOptionalParents(engine, "a", "scope")).rejects.toThrow("MANDATORY_PREPARATION_FAILURE");
  expect(store.db.query("SELECT * FROM jobs ORDER BY id").all()).toEqual(initial);
  const input = { type: "parent" as const, tree: sessionTree("a", 0), start: 0, count: 4, children: ["child-a", "child-b"] };
  for (const [index, id] of input.children.entries()) store.db.query("INSERT INTO nodes VALUES(?,?,?,?,?)").run(id, input.tree, index * 2, 2, JSON.stringify({ text: "Synthetic child." }));
  const row = { id: store.enqueue(input), input: JSON.stringify(input), attempts: 1, fence: 1, error: "MemoryError: SUMMARY_SIZE: fixture" };
  expect(classifyParentFailure(store, row, "a", "scope").optional).toBe(true);
  store.db.query("INSERT INTO publication_candidates(turnKey,tree,prepared) VALUES('fixture',?,1)").run(input.tree);
  store.db.query("INSERT INTO publication_dependencies VALUES('fixture',?,0,4)").run(input.tree);
  expect(classifyParentFailure(store, row, "a", "scope").optional).toBe(false);
  const shared = { ...input, tree: sharedTree("scope", 0), count: 2 };
  expect(classifyParentFailure(store, { ...row, input: JSON.stringify(shared), error: "Error: CALL_LIMIT" }, "a", "scope").optional).toBe(false);
});

test("optional failures cannot bypass the complete projection budget", async () => {
  const fixture = data(128), store = memory();
  await expect(prepareOptionalParentCase(backend({ failShared: true }), store, fixture)).rejects.toThrow("MEMORY_NOT_READY");
  const report = store.get<{ status: string; originalCount: number; publicationCount: number; terminalError: string }>("optionalParentPreparation", "report")!;
  expect(report).toMatchObject({ status: "halted", originalCount: 128, publicationCount: 64, terminalError: "MEMORY_NOT_READY" });
});

test("global request limits halt before optional continuation can conceal them", async () => {
  const store = memory(), model = backend({ globalLimit: true });
  await expect(prepareOptionalParentCase(model, store, data())).rejects.toThrow("CALL_LIMIT");
  expect(model.calls).toBe(1);
  expect(store.get<{ terminalError: string }>("optionalParentPreparation", "report")!.terminalError).toBe("CALL_LIMIT");
});

test("unknown and provider errors remain terminal on optional coordinates", async () => {
  const store = memory(), engine = new Engine(store); engine.register("a", "scope", "project");
  const tree = sharedTree("scope", 0), children = ["child-0", "child-1"];
  for (const [index, id] of children.entries()) store.db.query("INSERT INTO nodes VALUES(?,?,?,?,?)").run(id, tree, index, 1, JSON.stringify({ text: "Synthetic child." }));
  const input = { type: "parent" as const, tree, start: 0, count: 2, children }, id = store.enqueue(input);
  for (const error of ["Error: unexpected fixture failure", "Error: HTTP_503", "MemoryError: SUMMARY_INPUT_TOO_LARGE: fixture"]) {
    store.db.query("UPDATE jobs SET status='failed',error=? WHERE id=?").run(error, id);
    const row = { id, input: JSON.stringify(input), attempts: 1, fence: 1, error };
    expect(classifyParentFailure(store, row, "a", "scope").coveredByChildren).toBe(true);
    expect(classifyParentFailure(store, row, "a", "scope").optional).toBe(false);
    await expect(drainOptionalParents(engine, "a", "scope")).rejects.toThrow("MANDATORY_PREPARATION_FAILURE");
  }
});

test("changed questions cannot resume an existing case identity", async () => {
  const fixture = data(), store = memory(), model = backend();
  await prepareOptionalParentCase(model, store, fixture);
  const changed = structuredClone(fixture); changed.questions[0]!.referenceAnswer = "CHANGED_GOLD";
  await expect(prepareOptionalParentCase(model, store, changed)).rejects.toThrow("PREPARATION_RESUME_MISMATCH");
  const sessionId = `archive-${longCaseHashes(fixture).caseHash.slice(0, 16)}`;
  expect(store.get<{ generation: number }>("sessions", sessionId)!.generation).toBe(0);
});

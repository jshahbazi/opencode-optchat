import { expect, test } from "bun:test";
import { nativeBorosInput, assertNativeParity, sourceCoverage, type ComparisonAnswer } from "../scripts/compare-long-history.ts";
import { type NormalizedLongCase } from "../scripts/long-history-eval.ts";
import { type BorosEnvelope } from "../scripts/boros-context-driver.ts";
import { hash } from "../src/index.ts";

const fixture: NormalizedLongCase = { version: 1, source: { repoRevision: "fixture", scaleLabel: "fixture", conversationId: "fixture", rawChatHash: hash("fixture"), rawProbeHash: hash("probe"), license: "fixture" },
  messages: [{ seq: 0, role: "user", text: "Original public fixture text.", originalId: 1, timeAnchor: null }, { seq: 1, role: "assistant", text: "Original assistant fixture.", originalId: 2, timeAnchor: null }],
  questions: [{ id: "opaque", category: "fixture", question: "What is established?", referenceAnswer: "GOLD_SENTINEL", rubric: "RUBRIC_SENTINEL", sourceReferences: [1], resolvedMessageSeqs: [0], unresolvedReferences: [] }] };

test("native comparison ingestion preserves originals and excludes every grader field", () => {
  const input = nativeBorosInput(fixture, fixture.questions[0]!);
  expect(input.events.map(event => event.text)).toEqual(fixture.messages.map(message => message.text));
  expect(input.events.map(event => event.role)).toEqual(["user", "assistant"]);
  expect(input.question.prompt).toBe(fixture.questions[0]!.question);
  expect(JSON.stringify(input)).not.toContain("GOLD_SENTINEL");
  expect(JSON.stringify(input)).not.toContain("RUBRIC_SENTINEL");
  expect(JSON.stringify(input)).not.toContain("resolvedMessageSeqs");
  expect(input.configuration.thinking).toBe(false);
  expect(input.arms).toEqual(["ordinary_send"]);
});

test("ordinary-send parity fails on message changes and enabled semantic indexing", () => {
  const attempt = { preparation_completed: true, semantic_index_received: false, messages: [{ role: "user", content: "Fixture" }], sources: [] };
  const envelope: BorosEnvelope = { version: "boros-public-context-v1", corpus_sha256: "fixture", cache_reused: true, process_milliseconds: 1,
    attempts: [{ ...attempt, arm: "ordinary_send" }, { ...attempt, arm: "lexical" }] };
  assertNativeParity(envelope);
  envelope.attempts[1]!.messages = [{ role: "user", content: "Different fixture" }];
  expect(() => assertNativeParity(envelope)).toThrow("BOROS_NATIVE_PARITY");
  envelope.attempts[1]!.messages = attempt.messages;
  envelope.attempts[0]!.semantic_index_received = true;
  expect(() => assertNativeParity(envelope)).toThrow("BOROS_NATIVE_PARITY");
});

test("source coverage distinguishes partial original delivery from complete original delivery", () => {
  const input = nativeBorosInput(fixture, fixture.questions[0]!);
  const answer: ComparisonAnswer = { public: {}, private: { finalText: "Fixture", deliveredEvidence: [{ sourceId: input.events[0]!.id, text: "Original", complete: false }] } };
  expect(sourceCoverage(fixture.questions[0]!, answer, fixture)).toEqual({ resolvableGoldSources: 1, deliveredGoldSources: 1, fullyDeliveredGoldSources: 0 });
  answer.private.deliveredEvidence[0]!.complete = true;
  expect(sourceCoverage(fixture.questions[0]!, answer, fixture).fullyDeliveredGoldSources).toBe(1);
  answer.private.deliveredEvidence[0]!.sourceId = input.events[1]!.id;
  expect(sourceCoverage(fixture.questions[0]!, answer, fixture).deliveredGoldSources).toBe(0);
});

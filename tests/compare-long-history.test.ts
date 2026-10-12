import { expect, test } from "bun:test";
import { nativeBorosInput, assertNativeParity, sourceCoverage, answerBoros, type ComparisonAnswer } from "../scripts/compare-long-history.ts";
import { EvalFailure } from "../scripts/local-memory-eval.ts";
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

function frozenEnvelope() {
  const input = nativeBorosInput(fixture, fixture.questions[0]!);
  const messages = [{ role: "system", content: "Native fixture instruction." }, { role: "user", content: fixture.questions[0]!.question }];
  const body = JSON.stringify({ messages, model: "native-model", seed: 0, stream: true }), selection = JSON.stringify({ citation_labels: [] });
  const event = input.events[0]!, source = { event_id: event.id, project_id: event.project_id, conversation_key: event.conversation_key, role: event.role,
    kind: "historical" as const, offset: 0, bytes: new TextEncoder().encode(event.text).length, source_bytes: new TextEncoder().encode(event.text).length,
    source_sha256: hash(event.text), excerpt_sha256: hash(event.text), text: event.text };
  const envelope: BorosEnvelope = { version: "boros-public-context-v1", corpus_sha256: hash(JSON.stringify(input.events)), cache_reused: true, process_milliseconds: 1,
    attempts: [{ arm: "ordinary_send", preparation_completed: true, runner_started: false, semantic_index_received: false, messages, sources: [source, source], prompt_tokens: 30,
      body_sha256: hash(body), selection_sha256: hash(selection), request_body_base64: Buffer.from(body).toString("base64"), selection_receipt_base64: Buffer.from(selection).toString("base64"),
      selection_receipt: JSON.parse(selection), context_audit: {} }] };
  return { input, envelope, messages, body };
}

test("Boros generation preserves native messages and distinguishes prepared request identity", async () => {
  const { input, envelope, messages, body } = frozenEnvelope();
  const answer = await answerBoros({ async complete(received, tools, _stage, maxTokens) {
    expect(received).toEqual(messages); expect(tools).toEqual([]); expect(maxTokens).toBe(2048);
    return { message: { role: "assistant", content: "A fixture answer." }, inputTokens: 30, outputTokens: 4 };
  } }, envelope, input, fixture.questions[0]!);
  expect(answer.public.nativePreparedBodyHash).toBe(hash(body));
  expect(answer.public.submittedMessagesHash).toBe(hash(JSON.stringify(messages)));
  expect(answer.public.bodyHash).toBeUndefined();
  expect(answer.public.exactSourceReceipts).toBe(1);
  expect(answer.public.verifiedOriginalExcerpts).toBe(2);
});

test("Boros transport failure becomes a preserved failed cell without a fabricated answer", async () => {
  const { input, envelope } = frozenEnvelope();
  const answer = await answerBoros({ async complete() { throw new EvalFailure("HTTP_503"); } }, envelope, input, fixture.questions[0]!);
  expect(answer.public.failure).toBe("HTTP_503");
  expect(answer.private.finalText).toBe("");
  expect(answer.public.steps).toBe(1);
});

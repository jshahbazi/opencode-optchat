import { expect, test } from "bun:test";
import { Store } from "../src/index.ts";
import { answerLongQuestion, prepareLongCase, type NormalizedLongCase } from "../scripts/long-history-eval.ts";
import { beamGradingProtocol, createBeamCalibrationControls, gradeBeamCandidate, parseBeamVerdict, requireBeamCalibration, runBeamCalibration, type BeamCalibrationPublic, type BeamGradeQuestion } from "../scripts/beam-grader.ts";
import { type Backend, type ModelResult } from "../scripts/local-memory-eval.ts";

const question: BeamGradeQuestion = { id: "fixture-question", category: "information_extraction", question: "What tea does the user prefer?", referenceAnswer: "The user prefers jasmine tea.", rubric: ["Names jasmine tea."],
  nativeAuthorReference: { answer: "The user prefers jasmine tea.", rubric: ["Names jasmine tea."], source_chat_ids: [1], tests_for: "NATIVE_ORACLE_SENTINEL" } };
const response = (content: string): ModelResult => ({ message: { role: "assistant", content }, inputTokens: 1, outputTokens: 1 });
const valid = (correct: boolean, grounded: boolean | null = null, confidence = "high") => JSON.stringify({ correct, grounded, confidence });
const accepted: BeamCalibrationPublic = { accepted: 1, questionCount: 1, positiveCount: 1, negativeCount: 1, skippedPositiveCount: 0, positivesAccepted: 1, negativesRejected: 1, invalidCount: 0, lowConfidenceCount: 0 };

test("native verdict parser tolerates one fenced object and rejects ambiguous or malformed output", () => {
  expect(parseBeamVerdict(valid(true))).toEqual({ correct: true, grounded: null, confidence: "high" });
  expect(parseBeamVerdict(`Result:\n\n\`\`\`json\n${valid(false, false, "low")}\n\`\`\``)).toEqual({ correct: false, grounded: false, confidence: "low" });
  for (const output of [
    `${valid(true)} ${valid(false)}`, `\`\`\`json\n${valid(true)}\n\`\`\`\n\`\`\`json\n${valid(false)}\n\`\`\``,
    `Another object: {"correct":false}\n\`\`\`json\n${valid(true)}\n\`\`\``,
    '{"correct":false,"correct":true,"grounded":null,"confidence":"high"}',
    '{"correct":"true","grounded":null,"confidence":"high"}',
    '{"correct":true,"grounded":null,"confidence":"certain"}',
    '{"correct":true,"grounded":null,"confidence":"high","rationale":"extra"}',
    '[{"correct":true,"grounded":null,"confidence":"high"}]', "No verdict.",
  ]) expect(parseBeamVerdict(output)).toBeNull();
});

test("grading is blind to arm metadata and exposes only numeric public fields", async () => {
  let stage = "";
  const extended = { ...question, arm: "OPTCHAT_ARM_SENTINEL", pipeline: "BOROS_PIPELINE_SENTINEL" };
  const backend: Backend = { async complete(messages, tools, requestedStage) {
    stage = requestedStage; const prompt = JSON.stringify(messages);
    expect(prompt).toContain("NATIVE_ORACLE_SENTINEL"); expect(prompt).toContain("The user prefers jasmine tea.");
    expect(prompt).not.toContain("OPTCHAT_ARM_SENTINEL"); expect(prompt).not.toContain("BOROS_PIPELINE_SENTINEL");
    expect(tools).toEqual([]); return response(valid(true));
  } };
  const result = await gradeBeamCandidate(backend, extended, "Jasmine tea is preferred.", { calibration: accepted });
  expect(stage).toMatch(/^grade:[a-f0-9]{24}$/); expect(stage).not.toContain("optchat");
  expect(result.public).toEqual({ valid: 1, correct: 1, grounded: null, confidenceHigh: 1, groundingRequested: 0, acceptedScore: 1 });
  expect(Object.values(result.public).every(value => value === null || typeof value === "number")).toBe(true);
  expect(JSON.stringify(result.public)).not.toContain("jasmine");
});

test("correctness and delivered-evidence grounding stay separate", async () => {
  const backend: Backend = { async complete(messages) {
    const input = JSON.parse(messages[1]!.content!);
    expect(input.deliveredEvidence).toEqual([{ sourceId: "opaque-source", text: "The user prefers coffee." }]);
    return response(valid(true, false));
  } };
  const result = await gradeBeamCandidate(backend, question, "The user prefers jasmine tea.", { deliveredEvidence: [{ sourceId: "opaque-source", text: "The user prefers coffee." }] });
  expect(result.public.correct).toBe(1); expect(result.public.grounded).toBe(0); expect(result.public.acceptedScore).toBe(0);
  const missing: Backend = { async complete() { return response(valid(true)); } };
  const invalid = await gradeBeamCandidate(missing, question, "Jasmine tea.", { deliveredEvidence: [] });
  expect(invalid.public.valid).toBe(0); expect(invalid.private.failure).toBe("MISSING_GROUNDING_SCORE");
  const unsolicited: Backend = { async complete() { return response(valid(true, true)); } };
  expect((await gradeBeamCandidate(unsolicited, question, "Jasmine tea.")).private.failure).toBe("UNEXPECTED_GROUNDING_SCORE");
});

test("calibration uses unchanged authored positives, ideal summaries, and fabricated abstention negatives", () => {
  const abstention: BeamGradeQuestion = { ...question, id: "abstention", category: "abstention", referenceAnswer: "The conversation does not establish the requested detail." };
  const summary: BeamGradeQuestion = { ...question, id: "summary", category: "summarization", referenceAnswer: null, nativeAuthorReference: { ideal_summary: "An unchanged authored ideal summary." } };
  const noPositive: BeamGradeQuestion = { ...question, id: "preference", category: "preference_following", referenceAnswer: null, nativeAuthorReference: { expected_compliance: "Use the recorded preference." } };
  const selected = createBeamCalibrationControls([question, abstention, summary, noPositive]);
  expect(selected.public).toEqual({ questionCount: 4, positiveCount: 3, negativeCount: 4, skippedPositiveCount: 1 });
  expect(selected.controls.filter(control => control.kind === "positive").map(control => control.candidate)).toEqual([question.referenceAnswer as string, abstention.referenceAnswer as string, "An unchanged authored ideal summary."]);
  const negative = selected.controls.find(control => control.question.id === "abstention" && control.kind === "negative")!;
  expect(negative.candidate).toContain("BEAM_FALSE_"); expect(negative.candidate).toContain("invented details");
  expect(negative.candidate).not.toContain("cannot answer"); expect(negative.candidate).not.toContain("does not establish");
  expect(createBeamCalibrationControls([{ ...summary, idealSummary: "An explicit authored summary." }]).controls[0]!.candidate).toBe("An explicit authored summary.");
});

test("all calibration controls must pass before candidate scores can be accepted", async () => {
  const backend: Backend = { async complete(messages) {
    const input = JSON.parse(messages[1]!.content!);
    return response(valid(!input.candidate.includes("BEAM_FALSE_")));
  } };
  const calibrated = await runBeamCalibration(backend, [question]);
  expect(calibrated.public).toEqual(accepted); expect(() => requireBeamCalibration(calibrated.public)).not.toThrow();
  const bad: Backend = { async complete() { return response(valid(true)); } };
  const failed = await runBeamCalibration(bad, [question]);
  expect(failed.public.accepted).toBe(0); expect(failed.public.negativesRejected).toBe(0);
  expect(() => requireBeamCalibration(failed.public)).toThrow("GRADER_CALIBRATION_FAILED");
  await expect(gradeBeamCandidate(backend, question, "Jasmine tea.", { calibration: failed.public })).rejects.toThrow("GRADER_CALIBRATION_FAILED");
  expect((await gradeBeamCandidate(backend, question, "Jasmine tea.")).public.acceptedScore).toBe(0);
});

test("invalid outputs and absent usable positives prevent calibration acceptance", async () => {
  const malformed: Backend = { async complete() { return response("Malformed private rationale."); } };
  const result = await runBeamCalibration(malformed, [question]);
  expect(result.public.accepted).toBe(0); expect(result.public.invalidCount).toBe(2);
  expect(JSON.stringify(result.public)).not.toContain("rationale");
  const backend: Backend = { async complete() { return response(valid(false)); } };
  const noPositive = await runBeamCalibration(backend, [{ ...question, referenceAnswer: null, nativeAuthorReference: undefined }]);
  expect(noPositive.public.positiveCount).toBe(0); expect(noPositive.public.accepted).toBe(0);
});

test("calibration retains low-confidence counts while requiring every control's correct verdict", async () => {
  const backend: Backend = { async complete(messages) {
    const input = JSON.parse(messages[1]!.content!);
    return response(valid(!input.candidate.includes("BEAM_FALSE_"), null, "low"));
  } };
  const result = await runBeamCalibration(backend, [question]);
  expect(result.public.accepted).toBe(1); expect(result.public.lowConfidenceCount).toBe(2);
  expect(() => requireBeamCalibration(result.public)).not.toThrow();
});

test("grading accepts full delivered evidence above answer capacity and enforces its separate cap", async () => {
  let calls = 0;
  const backend: Backend = { async complete(messages) {
    calls++; const input = JSON.parse(messages[1]!.content!);
    expect(input.deliveredEvidence[0].text.length).toBe(80000);
    return response(valid(true, true));
  } };
  const within = await gradeBeamCandidate(backend, question, "Jasmine tea.", { deliveredEvidence: [{ sourceId: "opaque-source", text: "x".repeat(80000) }] });
  expect(within.public.valid).toBe(1); expect(within.public.grounded).toBe(1); expect(calls).toBe(1);
  const over = await gradeBeamCandidate(backend, question, "Jasmine tea.", { deliveredEvidence: [{ sourceId: "opaque-source", text: "x".repeat(beamGradingProtocol.graderContextTokens) }] });
  expect(over.public.valid).toBe(0); expect(over.private.failure).toBe("GRADER_CONTEXT_BUDGET"); expect(calls).toBe(1);
});

test("author oracle appears only in grading and stays absent from preparation and answering", async () => {
  const fixture: NormalizedLongCase = { version: 1, source: { repoRevision: "fixture", scaleLabel: "fixture", conversationId: "fixture", rawChatHash: "fixture-chat-hash", rawProbeHash: "fixture-probe-hash", license: "fixture" },
    messages: [{ seq: 0, role: "user", text: "The user prefers jasmine tea.", originalId: 1, timeAnchor: null }, { seq: 1, role: "assistant", text: "The preference is retained.", originalId: 2, timeAnchor: null }],
    questions: [{ ...question, referenceAnswer: "ANSWER_ORACLE_SENTINEL jasmine tea", sourceReferences: [1], resolvedMessageSeqs: [0], unresolvedReferences: [] }] };
  const memory = new Store();
  try {
    const answerer: Backend = { async complete(messages, _tools, stage) {
      expect(JSON.stringify(messages)).not.toContain("ANSWER_ORACLE_SENTINEL"); expect(JSON.stringify(messages)).not.toContain("NATIVE_ORACLE_SENTINEL");
      return response(stage.startsWith("summary") ? "A retained fixture preference." : "The user prefers jasmine tea.");
    } };
    const prepared = await prepareLongCase(answerer, memory, fixture);
    const candidate = await answerLongQuestion(answerer, prepared, fixture.questions[0]!);
    const grader: Backend = { async complete(messages) { expect(JSON.stringify(messages)).toContain("ANSWER_ORACLE_SENTINEL"); return response(valid(true)); } };
    expect((await gradeBeamCandidate(grader, fixture.questions[0]!, candidate.private.finalText)).public.correct).toBe(1);
  } finally { memory.close(); }
});

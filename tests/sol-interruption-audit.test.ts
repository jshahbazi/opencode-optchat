import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { hash } from "../src/index.ts";
import { prepareSolInterruption, settledSolInterruptionState, solInterruptionProtocol, validateSolInterruptionPrefix, type SolInterruptionManifest } from "../scripts/sol-interruption-audit.ts";

const digest = (value: unknown) => hash(JSON.stringify(value));
function fixture() {
  const metrics = Array.from({ length: 36 }, (_, index) => ({ call: index + 1, status: "complete", success: true, inputTokens: 100,
    outputTokens: 50, totalTokens: 150, costUsd: 0.01, reservedCostUsd: 0.08195, requestHash: hash(`synthetic request ${index}`), countHash: hash(`synthetic count ${index}`) }));
  const failed = { call: 37, status: "complete", success: false, code: "SOL_TRANSPORT_FAILURE", inputTokens: null, outputTokens: null,
    totalTokens: null, costUsd: null, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningTokens: null,
    reservedCostUsd: 0.1257525, requestHash: hash("synthetic failed request"), countHash: hash("synthetic failed count") };
  const allMetrics = [...metrics, failed], countMetrics = Array.from({ length: 67 }, (_, index) => ({ call: index + 1, status: "complete", success: true, inputTokens: 100, requestHash: hash(`synthetic counted request ${index}`) }));
  const counts = Object.fromEntries(countMetrics.map(metric => [metric.requestHash, { inputTokens: metric.inputTokens, countCall: metric.call, requestHash: metric.requestHash }]));
  const state: any = { version: 1, profile: "synthetic-profile", revision: 210, startedAt: 123456789, calls: 37, countCalls: 67,
    costUsd: 0.36, reservedCostUsd: 0.1257525, haltedCode: "SOL_USAGE_UNRESOLVED", metrics: allMetrics, countMetrics, counts };
  const manifest: SolInterruptionManifest = { protocol: solInterruptionProtocol, originalIdentityHash: hash("synthetic identity"),
    originalStateHash: digest(state), originalStateSnapshotPath: "/synthetic/state.json", sourceBindings: {}, profile: state.profile,
    startedAt: state.startedAt, deadlineAt: state.startedAt + 120 * 60000, revisionBefore: state.revision, prefixCalls: 37,
    prefixCountCalls: 67, metricsPrefixHash: digest(state.metrics), countMetricsPrefixHash: digest(state.countMetrics),
    countsPrefixHash: digest(state.counts), costBeforeUsd: state.costUsd, ceilingChargeUsd: 0.1257525,
    settledCostUsd: state.costUsd + 0.1257525, failedCall: 37, questionId: "synthetic-question",
    failedRequestHash: failed.requestHash, failedCountHash: failed.countHash };
  return { state, manifest };
}
test("a ceiling settlement preserves all provider usage, counters, cache, and original metadata", () => {
  const { state, manifest } = fixture(), original = structuredClone(state), settled = settledSolInterruptionState(state, manifest);
  expect(state).toEqual(original);
  expect(settled.metrics).toEqual(original.metrics); expect(settled.countMetrics).toEqual(original.countMetrics); expect(settled.counts).toEqual(original.counts);
  expect(settled).toMatchObject({ calls: 37, countCalls: 67, startedAt: state.startedAt, profile: state.profile, revision: 211,
    reservedCostUsd: 0, haltedCode: null, costUsd: 0.4857525 });
  expect(settled.metrics[36]).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, success: false, code: "SOL_TRANSPORT_FAILURE" });
  expect(settled.unknownCostSettlements).toEqual([{ version: "sol-unknown-cost-ceiling-1", amendmentIdentityHash: digest(manifest),
    failedCall: 37, originalStateHash: manifest.originalStateHash, chargeUsd: 0.1257525, authoritative: false,
    providerInputTokens: null, providerOutputTokens: null, retried: false }]);
  expect(() => validateSolInterruptionPrefix(settled, manifest)).not.toThrow();
});
test("later generation charges append to the permanent full ceiling", () => {
  const { state, manifest } = fixture(), settled = settledSolInterruptionState(state, manifest);
  settled.calls++; settled.countCalls++; settled.revision += 4;
  settled.metrics.push({ call: 38, costUsd: 0.05, success: true, status: "complete" });
  settled.countMetrics.push({ call: 68, inputTokens: 200, requestHash: "synthetic-new-count", success: true, status: "complete" });
  settled.counts["synthetic-new-count"] = { countCall: 68, inputTokens: 200, requestHash: "synthetic-new-count" };
  settled.costUsd += 0.05;
  expect(() => validateSolInterruptionPrefix(settled, manifest)).not.toThrow();
  settled.costUsd -= 0.1257525;
  expect(() => validateSolInterruptionPrefix(settled, manifest)).toThrow("SOL_INTERRUPTION_COST_MISMATCH");
});
test("settlement rejects changed reservations, counters, pending results, and existing settlement markers", () => {
  const { state, manifest } = fixture();
  for (const change of [
    (value: any) => { value.reservedCostUsd = 0; }, (value: any) => { value.calls = 38; },
    (value: any) => { value.countCalls = 68; }, (value: any) => { value.haltedCode = null; },
    (value: any) => { value.unknownCostSettlements = []; }, (value: any) => { value.metrics[36].status = "pending"; },
  ]) {
    const modified = structuredClone(state); change(modified);
    expect(() => settledSolInterruptionState(modified, manifest)).toThrow();
  }
});
test("prefix verification rejects changed generation and count metrics or historical token cache entries", () => {
  const { state, manifest } = fixture();
  for (const change of [
    (value: any) => { value.metrics[0].inputTokens++; }, (value: any) => { value.countMetrics[0].inputTokens++; },
    (value: any) => { value.counts[Object.keys(value.counts)[0]].inputTokens++; },
    (value: any) => { delete value.counts[Object.keys(value.counts)[0]]; },
  ]) {
    const settled = settledSolInterruptionState(state, manifest); change(settled);
    expect(() => validateSolInterruptionPrefix(settled, manifest)).toThrow();
  }
});
test("unknown usage cannot become fabricated authoritative usage", () => {
  const { state, manifest } = fixture(), altered = structuredClone(state);
  altered.metrics[36].inputTokens = 17533; altered.metrics[36].outputTokens = 8192;
  altered.metrics[36].totalTokens = 25725; altered.metrics[36].costUsd = 0.1257525;
  const alteredManifest = { ...manifest, metricsPrefixHash: digest(altered.metrics) };
  expect(() => settledSolInterruptionState(altered, alteredManifest)).toThrow("SOL_INTERRUPTION_USAGE_CHANGED");
});
test("deadline, provider profile, original budget, and settlement identity cannot drift", () => {
  const { state, manifest } = fixture();
  for (const change of [
    (value: any) => { value.startedAt++; }, (value: any) => { value.profile = "replacement"; },
    (value: any) => { value.calls = 421; }, (value: any) => { value.countCalls = 3001; },
    (value: any) => { value.reservedCostUsd = 60; }, (value: any) => { value.unknownCostSettlements[0].chargeUsd = 0; },
    (value: any) => { value.unknownCostSettlements[0].authoritative = true; },
  ]) {
    const settled = settledSolInterruptionState(state, manifest); change(settled);
    expect(() => validateSolInterruptionPrefix(settled, manifest)).toThrow();
  }
  const settled = settledSolInterruptionState(state, manifest);
  expect(() => validateSolInterruptionPrefix(settled, { ...manifest, deadlineAt: manifest.deadlineAt + 1 })).toThrow("SOL_INTERRUPTION_MANIFEST_MISMATCH");
  expect(() => validateSolInterruptionPrefix(settled, { ...manifest, protocol: { ...solInterruptionProtocol, maxCalls: 500 } as any })).toThrow("SOL_INTERRUPTION_MANIFEST_MISMATCH");
});
test("a synthetic phase cannot pass the production mutation entry point", () => {
  const repository = mkdtempSync(resolve(tmpdir(), "sol-interruption-fixture-")), root = resolve(repository, ".optchat/beam-sol-02");
  mkdirSync(resolve(root, "independent-private"), { recursive: true, mode: 0o700 });
  const { state } = fixture(), original = JSON.stringify(state, null, 2) + "\n";
  try {
    writeFileSync(resolve(root, "sol-backend-state.json"), original, { mode: 0o600 });
    writeFileSync(resolve(root, "sol-comparison-freeze.json"), "{}", { mode: 0o600 });
    writeFileSync(resolve(root, "independent-private/unresolved-call37-audit.json"), "{}", { mode: 0o600 });
    expect(() => prepareSolInterruption(root, repository)).toThrow("SOL_INTERRUPTION_KNOWN_PHASE_REQUIRED");
    expect(readFileSync(resolve(root, "sol-backend-state.json"), "utf8")).toBe(original);
    expect(readdirSync(root).sort()).toEqual(["independent-private", "sol-backend-state.json", "sol-comparison-freeze.json"]);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});
test("a stop marker rejects continuation before any ledger or amendment writes", () => {
  const repository = mkdtempSync(resolve(tmpdir(), "sol-interruption-stop-fixture-")), root = resolve(repository, ".optchat/beam-sol-02");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(resolve(root, "user-requested-stop.json"), "{}", { mode: 0o600 });
    expect(() => prepareSolInterruption(root, repository)).toThrow("SOL_USER_STOPPED");
    expect(readdirSync(root)).toEqual(["user-requested-stop.json"]);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

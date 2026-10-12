import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { hash } from "../src/index.ts";
import { appendSavedOverview, confirmationBackendCopy, extractSavedOverview } from "../scripts/boros-diagnostic-confirmation.ts";

test("overview extraction preserves the complete saved envelope and rejects a changed shared projection", () => {
  const shared = "x".repeat(35577), envelope = "<optchat-shared-data>\n" + shared + "</optchat-shared-data>\n<optchat-own-data>\n</optchat-own-data>", overview = "e".repeat(35941 - envelope.length) + envelope, answer = { public: { questionHash: "synthetic" }, private: { expandedIdentityHash: "synthetic", requestReceipts: [{ messages: [{ role: "system", content: "Synthetic instruction.\nHISTORICAL_DATA:\n" + overview }] }] } };
  expect(extractSavedOverview(answer, "synthetic")).toEqual({ fullPayload: overview, sharedNodes: shared });
  expect(() => extractSavedOverview(answer, "changed")).toThrow("CONFIRMATION_OVERVIEW_MISMATCH");
  answer.private.requestReceipts[0]!.messages[0]!.content += "changed";
  expect(() => extractSavedOverview(answer, "synthetic")).toThrow("CONFIRMATION_OVERVIEW_MISMATCH");
});
test("overview addition changes only first-system content and preserves every source message", () => {
  const messages = [{ role: "system", content: "Synthetic system." }, { role: "user", content: "Synthetic recent." }, { role: "user", content: "Synthetic evidence." }, { role: "user", content: "Synthetic question?" }], original = JSON.stringify(messages), result = appendSavedOverview(messages, "Synthetic overview.");
  expect(result[0]!.content).toBe("Synthetic system.\n<untrusted-historical-overview>\nSynthetic overview.</untrusted-historical-overview>");
  expect(result.slice(1)).toEqual(messages.slice(1)); expect(result.map(message => message.role)).toEqual(messages.map(message => message.role)); expect(JSON.stringify(messages)).toBe(original);
});
test("physical backend copy inherits counter, metrics, start, and fixed deadline without a reset", () => {
  const root = mkdtempSync(resolve(tmpdir(), "boros-confirmation-fixture-")), source = resolve(root, "source"), destination = resolve(root, "destination"); mkdirSync(source);
  try {
    const state = { version: 1, startedAt: 1000, calls: 79, metrics: [{ call: 1, invocation: "synthetic", success: true }] }, path = resolve(source, "backend-state.json"); writeFileSync(path, JSON.stringify(state));
    const sourceHash = hash(readFileSync(path, "utf8")), resources = { startedAt: 1000, deadlineAt: 1801000, maxCalls: 120, inheritedCalls: 2628, sourceStartedAt: 100 };
    const first = confirmationBackendCopy(source, destination, sourceHash, resources), copied = JSON.parse(readFileSync(resolve(destination, "backend-state.json"), "utf8"));
    expect(copied).toEqual(state); expect(first.inheritedCalls).toBe(79); expect(first.deadlineAt).toBe(1801000);
    copied.calls = 81; copied.metrics.push({ call: 80, invocation: "synthetic-new", success: true }); writeFileSync(resolve(destination, "backend-state.json"), JSON.stringify(copied));
    expect(confirmationBackendCopy(source, destination, sourceHash, resources)).toEqual(first);
    expect(() => confirmationBackendCopy(source, destination, sourceHash, { ...resources, deadlineAt: 1801001 })).toThrow("CONFIRMATION_RESOURCE_MISMATCH");
    const changed = JSON.parse(readFileSync(resolve(destination, "backend-state.json"), "utf8")); changed.startedAt = 2000; writeFileSync(resolve(destination, "backend-state.json"), JSON.stringify(changed));
    expect(() => confirmationBackendCopy(source, destination, sourceHash, resources)).toThrow("CONFIRMATION_RESOURCE_MISMATCH");
    expect(hash(readFileSync(path, "utf8"))).toBe(sourceHash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

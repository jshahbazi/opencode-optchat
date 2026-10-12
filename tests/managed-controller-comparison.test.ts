import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { managedResources, verifyManagedMessageProtocol } from "../scripts/managed-controller-comparison.ts";

test("managed rerun resumes its own fixed resource phase without extending the deadline", () => {
  const root = mkdtempSync(resolve(tmpdir(), "managed-resource-fixture-"));
  try {
    const first = managedResources(root, 2628, 95), statePath = resolve(root, "backend-state.json"), state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(first.deadlineAt - first.startedAt).toBe(3600000);
    expect(state.calls).toBe(0); state.calls = 7; writeFileSync(statePath, JSON.stringify(state));
    expect(managedResources(root, 2628, 95)).toEqual(first);
    expect(JSON.parse(readFileSync(statePath, "utf8")).calls).toBe(7);
    expect(() => managedResources(root, 2629, 95)).toThrow("MANAGED_RESOURCE_MISMATCH");
    const resourcesPath = resolve(root, "managed-resources.json"), resources = JSON.parse(readFileSync(resourcesPath, "utf8"));
    resources.deadlineAt++; writeFileSync(resourcesPath, JSON.stringify(resources));
    expect(() => managedResources(root, 2628, 95)).toThrow("MANAGED_RESOURCE_MISMATCH");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bounded histories reject orphaned or duplicate tool results in mixed batches", () => {
  const first = [{ role: "system", content: "Synthetic system." }, { role: "user", content: "Synthetic question?" }];
  const assistant = { role: "assistant", tool_calls: [{ id: "a", type: "function", function: { name: "synthetic", arguments: "{}" } }, { id: "b", type: "function", function: { name: "synthetic", arguments: "{}" } }] };
  const results = [{ role: "tool", tool_call_id: "a", content: "{}" }, { role: "tool", tool_call_id: "b", content: "{}" }];
  expect(() => verifyManagedMessageProtocol([...first, assistant, ...results], false)).not.toThrow();
  expect(() => verifyManagedMessageProtocol([...first, ...results], false)).toThrow("MANAGED_TOOL_PROTOCOL_MISMATCH");
  expect(() => verifyManagedMessageProtocol([...first, assistant, results[0]], false)).toThrow("MANAGED_TOOL_PROTOCOL_MISMATCH");
  expect(() => verifyManagedMessageProtocol([...first, assistant, results[0], results[0]], false)).toThrow("MANAGED_TOOL_PROTOCOL_MISMATCH");
});

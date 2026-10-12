import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { highOutputBackendProtocol, LocalBackend, ResumableLocalBackend } from "../scripts/high-output-local-backend.ts";

const messages = [{ role: "user", content: "Synthetic question." }];
const reply = (finishReason = "stop", tokens = 5000) => Response.json({ choices: [{ finish_reason: finishReason, message: { role: "assistant", content: "Synthetic visible answer.", reasoning_content: "HIDDEN_REASONING_SENTINEL" } }], usage: { prompt_tokens: 1000, completion_tokens: tokens, total_tokens: 1000 + tokens }, private_provider_object: "PRIVATE_PROVIDER_SENTINEL" });
function temporary() { return mkdtempSync(resolve(tmpdir(), "high-output-backend-fixture-")); }

test("the output transport permits ten minutes and captures only visible response data", async () => {
  const root = temporary(), timeouts: number[] = [];
  const timer = spyOn(AbortSignal, "timeout").mockImplementation(ms => { timeouts.push(ms); return new AbortController().signal; });
  let requested: any;
  try {
    const backend = new LocalBackend("http://127.0.0.1:11234/v1/chat/completions", "synthetic-model", root, 1, 3600000, "mlx", highOutputBackendProtocol.requestTimeoutMs, async (_url, init) => { requested = JSON.parse(init.body as string); expect(init.headers).toEqual({ "content-type": "application/json" }); return reply(); });
    const result = await backend.complete(messages, [], "synthetic", 8192);
    expect(timeouts).toEqual([600000]); expect(requested.max_tokens).toBe(8192);
    expect(result.outputTokens).toBe(5000); expect(backend.metrics[0]!.success).toBe(true);
    const captured = readFileSync(resolve(root, "call-000-output.json"), "utf8");
    expect(captured).not.toContain("HIDDEN_REASONING_SENTINEL"); expect(captured).not.toContain("PRIVATE_PROVIDER_SENTINEL");
    for (const file of readdirSync(root)) expect(statSync(resolve(root, file)).mode & 0o777).toBe(0o600);
  } finally { timer.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("the individual request timeout never exceeds the remaining phase deadline", async () => {
  const root = temporary(), timeouts: number[] = [];
  const timer = spyOn(AbortSignal, "timeout").mockImplementation(ms => { timeouts.push(ms); return new AbortController().signal; });
  try {
    const backend = new LocalBackend("http://127.0.0.1:11234/v1/chat/completions", "synthetic-model", root, 1, 30000, "mlx", 600000, async () => reply());
    await backend.complete(messages, [], "synthetic", 8192);
    expect(timeouts).toHaveLength(1); expect(timeouts[0]!).toBeGreaterThan(0); expect(timeouts[0]!).toBeLessThanOrEqual(30000);
  } finally { timer.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("resumable requests retain the deadline, counts, serial dispatch, and output settings", async () => {
  const root = temporary(), requests: number[] = [];
  let active = 0, maximumActive = 0;
  const fetchRequest = async (_url: URL, init: RequestInit) => {
    active++; maximumActive = Math.max(maximumActive, active);
    requests.push(JSON.parse(init.body as string).max_tokens);
    await Promise.resolve(); active--; return reply("stop", 1);
  };
  try {
    const backend = new ResumableLocalBackend({ url: "http://127.0.0.1:11234/v1/chat/completions", model: "synthetic-model", directory: root, maxCalls: 2, maxMinutes: 60, fetchRequest });
    const start = backend.startedAt;
    await Promise.all([backend.complete(messages, [], "synthetic-answer", 8192), backend.complete(messages, [], "synthetic-grade", 384)]);
    expect(requests).toEqual([8192, 384]); expect(maximumActive).toBe(1);
    expect(backend.calls).toBe(2); expect(backend.metrics).toHaveLength(2);
    const reopened = new ResumableLocalBackend({ url: "http://127.0.0.1:11234/v1/chat/completions", model: "synthetic-model", directory: root, maxCalls: 2, maxMinutes: 60, fetchRequest });
    expect(reopened.startedAt).toBe(start); expect(reopened.calls).toBe(2);
    await expect(reopened.complete(messages, [], "synthetic", 8192)).rejects.toThrow("CALL_LIMIT");
    expect(requests).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stop markers refuse backend creation and prevent queued requests from dispatching", async () => {
  const root = temporary();
  try {
    writeFileSync(resolve(root, "user-requested-stop.json"), "{}", { mode: 0o600 });
    expect(() => new ResumableLocalBackend({ url: "http://127.0.0.1:11234/v1/chat/completions", model: "synthetic-model", directory: root })).toThrow("MANAGED_USER_STOPPED");
    expect(readdirSync(root)).toEqual(["user-requested-stop.json"]);
    rmSync(resolve(root, "user-requested-stop.json"));
    let calls = 0;
    const backend = new ResumableLocalBackend({ url: "http://127.0.0.1:11234/v1/chat/completions", model: "synthetic-model", directory: root, fetchRequest: async () => { calls++; writeFileSync(resolve(root, "user-requested-stop.json"), "{}", { mode: 0o600 }); return reply(); } });
    const outcomes = await Promise.allSettled([backend.complete(messages, [], "first", 8192), backend.complete(messages, [], "queued", 8192)]);
    expect(outcomes[0]!.status).toBe("fulfilled"); expect(outcomes[1]!.status).toBe("rejected");
    if (outcomes[1]!.status === "rejected") expect(outcomes[1]!.reason.code).toBe("MANAGED_USER_STOPPED");
    expect(calls).toBe(1); expect(backend.calls).toBe(1); expect(backend.metrics).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a length failure retains its authoritative usage and consumes one call without retry", async () => {
  const root = temporary();
  try {
    let calls = 0;
    const backend = new ResumableLocalBackend({ url: "http://127.0.0.1:11234/v1/chat/completions", model: "synthetic-model", directory: root, fetchRequest: async () => { calls++; return reply("length", 8192); } });
    await expect(backend.complete(messages, [], "synthetic", 8192)).rejects.toThrow("MODEL_OUTPUT_INCOMPLETE");
    expect(calls).toBe(1); expect(backend.calls).toBe(1);
    expect(backend.metrics[0]).toMatchObject({ inputTokens: 1000, outputTokens: 8192, success: false, code: "MODEL_OUTPUT_INCOMPLETE" });
    const state = JSON.parse(readFileSync(resolve(root, "backend-state.json"), "utf8"));
    expect(state.calls).toBe(1); expect(state.metrics).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an expired phase rejects dispatch even with the longer request timeout", async () => {
  const root = temporary();
  try {
    writeFileSync(resolve(root, "backend-state.json"), JSON.stringify({ version: 1, endpoint: "http://127.0.0.1:11234/v1/chat/completions", model: "synthetic-model", provider: "mlx", startedAt: Date.now() - 61000, calls: 0, metrics: [] }), { mode: 0o600 });
    let calls = 0;
    const backend = new ResumableLocalBackend({ url: "http://127.0.0.1:11234/v1/chat/completions", model: "synthetic-model", directory: root, maxMinutes: 1, fetchRequest: async () => { calls++; return reply(); } });
    await expect(backend.complete(messages, [], "synthetic", 8192)).rejects.toThrow("RUN_DEADLINE");
    expect(calls).toBe(0); expect(backend.calls).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid timeouts fail before new backend data is written", () => {
  const root = temporary();
  try {
    for (const requestTimeoutMs of [0, NaN, Infinity, 600001]) expect(() => new ResumableLocalBackend({ url: "http://127.0.0.1:11234/v1/chat/completions", model: "synthetic-model", directory: root, requestTimeoutMs })).toThrow("INVALID_REQUEST_TIMEOUT");
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRawQwenRequestTokenizer, createQwenRequestTokenizer, qwenTokenizerFixtures, renderQwenRequest, validateQwenRequestTokenizer, requireQwenTokenizerValidation } from "../scripts/qwen-request-tokenizer.ts";
import type { Backend } from "../scripts/local-memory-eval.ts";

const config = { chat_template: "{% for message in messages %}{{ message.role }}:{{ message.content }}{% if message.tool_calls %}{{ message.tool_calls | tojson }}{% endif %}\n{% endfor %}{{ tools | tojson }}|{{ enable_thinking }}|{{ add_generation_prompt }}" };
function fixture() { const directory = mkdtempSync(join(tmpdir(), "qwen-token-budget-")), path = join(directory, "tokenizer_config.json"); writeFileSync(path, JSON.stringify(config)); return { directory, path, close: () => rmSync(directory, { recursive: true, force: true }) }; }

test("rendering includes tool definitions, assistant calls, results, Unicode, and generation flags", () => {
  const sample = qwenTokenizerFixtures()[2]!;
  const text = renderQwenRequest(config, [...sample.messages, { role: "user", content: "雪" }], sample.tools);
  expect(text).toContain("synthetic_lookup"); expect(text).toContain("synthetic-call"); expect(text).toContain('"synthetic"');
  expect(text).toContain("tool:"); expect(text).toContain("雪"); expect(text).toContain("false|true");
});

test("loopback token counts are cached by the complete rendered request", async () => {
  const files = fixture(); let requests = 0;
  try {
    const counter = createRawQwenRequestTokenizer({ configPath: files.path, fetcher: async (_url, init) => { requests++; const input = JSON.parse(init!.body as string); expect(input.add_special_tokens).toBe(false); return Response.json({ tokens: Array.from({ length: Array.from(input.content).length }, (_, index) => index) }); } });
    const plain = qwenTokenizerFixtures()[0]!, tool = qwenTokenizerFixtures()[2]!;
    expect(await counter.countRequestTokens(plain.messages, plain.tools, 1)).toBe(Array.from(counter.render(plain.messages, plain.tools)).length);
    await counter.countRequestTokens(plain.messages, plain.tools, 2048); expect(requests).toBe(1);
    await counter.countRequestTokens(tool.messages, tool.tools, 2048); expect(requests).toBe(2);
  } finally { files.close(); }
});

test("invalid endpoints, message payloads, and tokenizer responses fail without content diagnostics", async () => {
  const files = fixture();
  try {
    expect(() => createRawQwenRequestTokenizer({ configPath: files.path, endpoint: "https://example.com/tokenize" })).toThrow("TOKENIZER_LOOPBACK_REQUIRED");
    expect(() => renderQwenRequest(config, [{ role: "user", content: [] } as any], [])).toThrow("TOKENIZER_UNSUPPORTED_MESSAGE");
    const bad = createRawQwenRequestTokenizer({ configPath: files.path, fetcher: async () => Response.json({ tokens: ["invalid"] }) });
    await expect(bad.countRequestTokens([{ role: "user", content: "fixture" }], [], 1)).rejects.toThrow("TOKENIZER_INVALID_RESPONSE");
  } finally { files.close(); }
});

test("server validation binds exact counts, source identity, and every request class", async () => {
  const files = fixture(); let calls = 0;
  try {
    const raw = createRawQwenRequestTokenizer({ configPath: files.path, fetcher: async (_url, init) => Response.json({ tokens: Array.from({ length: (JSON.parse(init!.body as string).content as string).length }, (_, index) => index) }) });
    const backend: Backend = { async complete(messages, tools) { calls++; return { message: { role: "assistant", content: "fixture" }, inputTokens: await raw.countRequestTokens(messages, tools, 1), outputTokens: 1 }; } };
    const artifact = await validateQwenRequestTokenizer(raw, backend, files.directory); expect(artifact.accepted).toBe(true); expect(calls).toBe(5);
    await validateQwenRequestTokenizer(raw, backend, files.directory); expect(calls).toBe(5);
    const ready = await createQwenRequestTokenizer({ directory: files.directory, configPath: files.path }); expect(ready.identity.validationHash).toBeDefined();
    const changed = structuredClone(artifact); changed.receipts[0]!.reported = 0;
    expect(() => requireQwenTokenizerValidation(raw.identity, changed)).toThrow("TOKENIZER_VALIDATION_FAILED");
    expect(JSON.parse(readFileSync(join(files.directory, "qwen-tokenizer-validation.json"), "utf8")).receipts).toHaveLength(5);
  } finally { files.close(); }
});

test("mismatched validation remains immutable and blocks use", async () => {
  const files = fixture();
  try {
    const raw = createRawQwenRequestTokenizer({ configPath: files.path, fetcher: async () => Response.json({ tokens: [1] }) });
    const backend: Backend = { async complete() { return { message: { role: "assistant", content: "fixture" }, inputTokens: 2, outputTokens: 1 }; } };
    await expect(validateQwenRequestTokenizer(raw, backend, files.directory)).rejects.toThrow("TOKENIZER_VALIDATION_FAILED");
    await expect(createQwenRequestTokenizer({ directory: files.directory, configPath: files.path })).rejects.toThrow("TOKENIZER_VALIDATION_FAILED");
  } finally { files.close(); }
});

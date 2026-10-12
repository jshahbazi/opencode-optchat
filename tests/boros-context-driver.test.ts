import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BOROS_REVISION, QWEN_MODEL, createBorosTokenizerFixture, ensureBorosDriver,
  localBorosTokenizer, renderBorosQwenBody, runBorosContext, verifyBorosEnvelope, type BorosInput } from "../scripts/boros-context-driver.ts";

test("Boros restricted renderer matches the retained Qwen text framing", () => {
  const rendered = renderBorosQwenBody({ enable_thinking: false, messages: [
    { role: "system", content: " system " }, { role: "user", content: " first " },
    { role: "assistant", content: " answer " }, { role: "user", content: " question " },
  ] });
  expect(rendered).toBe("<|im_start|>system\nsystem<|im_end|>\n<|im_start|>user\nfirst<|im_end|>\n" +
    "<|im_start|>assistant\n<think>\n\n</think>\n\nanswer<|im_end|>\n<|im_start|>user\nquestion<|im_end|>\n" +
    "<|im_start|>assistant\n<think>\n\n</think>\n\n");
  expect(() => renderBorosQwenBody({ enable_thinking: true, messages: [] })).toThrow("BOROS_UNSUPPORTED_RENDER_INPUT");
  expect(() => renderBorosQwenBody({ enable_thinking: false, messages: [{ role: "tool", content: "fixture" }] })).toThrow("BOROS_UNSUPPORTED_RENDER_INPUT");
});

test("Boros tokenizer fixture refuses generation and proxy rejects remote hosts", async () => {
  expect(() => localBorosTokenizer("https://example.com/v1/")).toThrow("BOROS_LOOPBACK_TOKENIZER_REQUIRED");
  const fixture = createBorosTokenizerFixture({ template: "fixture", contextLimit: 32768,
    tokenize: async text => Array(new TextEncoder().encode(text).length).fill(1) });
  try {
    const generated = await fetch(new URL("chat/completions", fixture.endpoint), {
      method: "POST", body: JSON.stringify({ model: QWEN_MODEL, messages: [{ role: "user", content: "fixture" }], stream: true, max_tokens: 10 }),
    });
    expect(generated.status).toBe(503);
    expect(fixture.counters.refusedGeneration).toBe(1);
  } finally { fixture.stop(); }
});

test.skipIf(process.env.OPTCHAT_BOROS_DRIVER_TEST !== "1")("Boros ordinary Send and lexical retain identical hash-bound originals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "optchat-boros-driver-"));
  const cacheRoot = process.env.OPTCHAT_BOROS_DRIVER_CACHE ?? join(import.meta.dir, "../.optchat/boros-driver-test-cache");
  const repository = process.env.OPTCHAT_BOROS_REPOSITORY ?? "/Users/johnshahbazian/development/boros";
  const driver = await ensureBorosDriver({ borosRepository: repository, cacheRoot });
  expect(driver.manifest.revision).toBe(BOROS_REVISION);
  const fixture = createBorosTokenizerFixture({ template: await readFile(driver.template, "utf8"), contextLimit: 32768,
    tokenize: async text => Array(new TextEncoder().encode(text).length).fill(1) });
  const events = Array.from({ length: 64 }, (_, index) => ({ id: `public-${index}`, project_id: "fixture-project", conversation_key: "fixture-conversation",
    role: (index % 2 ? "assistant" : "user") as "user" | "assistant", status: "complete" as const,
    text: index === 0 ? "Aster archive key: quartz-blue-7391. " + "é😀 Original scalar boundaries remain exact. ".repeat(110) :
      index === 62 ? "Recent original paging fixture. " + "é😀 Original scalar boundaries remain exact. ".repeat(110) :
      `Unrelated topic ${index}. ` + "Synthetic background text has no requested archive value. ".repeat(20) }));
  const input: BorosInput = { version: 1, events,
    question: { project_id: "fixture-project", conversation_key: "fixture-conversation", prompt: "What is the Aster archive key?" },
    arms: ["ordinary_send", "lexical"], configuration: { model: QWEN_MODEL, system: "Answer from the quoted original history.",
      temperature: 0, seed: 0, thinking: false, maximum_output: 512, context_limit: 32768, safety_tokens: 1024 } };
  try {
    const result = await runBorosContext(driver, input, { outputDirectory: join(directory, "first"), cacheRoot, endpoint: fixture.endpoint });
    expect(result.attempts).toHaveLength(2);
    const ordinary = result.attempts[0]!, lexical = result.attempts[1]!;
    expect(ordinary.preparation_completed).toBe(true);
    expect(lexical.preparation_completed).toBe(true);
    expect(ordinary.messages).toEqual(lexical.messages);
    expect(ordinary.sources).toEqual(lexical.sources);
    expect(ordinary.semantic_index_received).toBe(false);
    expect(ordinary.sources!.some(source => source.event_id === "public-0" && source.kind === "historical")).toBe(true);
    expect(ordinary.sources!.some(source => source.kind === "recent" && source.bytes > 4096)).toBe(true);
    expect(ordinary.context_audit!.components.recentCap).toBe(8000);
    expect(ordinary.context_audit!.components.evidenceCap).toBe(12000);
    expect(ordinary.context_audit!.selection.maximumEvidenceSpans).toBe(16);
    expect(fixture.counters.refusedGeneration).toBe(0);
    expect(fixture.counters.rejected).toBe(0);
    expect((await stat(join(directory, "first/boros-context.json"))).mode & 0o777).toBe(0o600);
    const repeated = await runBorosContext(driver, input, { outputDirectory: join(directory, "second"), cacheRoot, endpoint: fixture.endpoint });
    expect(repeated.cache_reused).toBe(true);
    expect(repeated.attempts[0]!.messages).toEqual(ordinary.messages);
    expect(repeated.attempts[0]!.sources).toEqual(ordinary.sources);
    const tampered = structuredClone(result);
    tampered.attempts[0]!.sources![0]!.text += "tampered";
    expect(() => verifyBorosEnvelope(tampered, input)).toThrow("BOROS_SOURCE_RECEIPT_INVALID");
    const bodyTampered = structuredClone(result);
    bodyTampered.attempts[0]!.messages![0]!.content += "tampered";
    expect(() => verifyBorosEnvelope(bodyTampered, input)).toThrow("BOROS_ENVELOPE_INVALID");
    const oracleInput: any = { ...input, oracle: "rejected fixture label" };
    await expect(runBorosContext(driver, oracleInput, { outputDirectory: join(directory, "unknown-field"), cacheRoot, endpoint: fixture.endpoint })).rejects.toThrow("BOROS_CONTEXT_FAILED");
  } finally {
    fixture.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 600000);

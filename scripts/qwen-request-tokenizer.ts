import { Template } from "@huggingface/jinja";
import { readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { hash } from "../src/index.ts";
import { EvalFailure, type Backend } from "./local-memory-eval.ts";
import { QWEN_MODEL } from "./boros-context-driver.ts";

type Messages = Parameters<Backend["complete"]>[0];
type Config = { chat_template: string; [key: string]: unknown };
export const qwenTokenizerProtocol = { version: "qwen-tool-request-tokenizer-1", model: QWEN_MODEL,
  renderer: "@huggingface/jinja", rendererVersion: "0.5.10", addGenerationPrompt: true, enableThinking: false,
  preserveThinking: false,
  validation: "exact-server-prompt-token-match", calibrationOutputTokens: 32, tokenEndpoint: "loopback-tokenize-rendered-content" } as const;
export interface QwenRequestTokenizer {
  identity: Record<string, unknown>;
  countRequestTokens(messages: Messages, tools: unknown[], outputTokens: number): Promise<number>;
  render(messages: Messages, tools: unknown[]): string;
}
const defaultConfigPath = resolve(homedir(), ".mlx-serve", "models", QWEN_MODEL, "tokenizer_config.json");
const validationFilename = "qwen-tokenizer-validation.json";

export function renderQwenRequest(config: Config, messages: Messages, tools: unknown[]) {
  if (typeof config.chat_template !== "string" || !config.chat_template) throw new EvalFailure("TOKENIZER_TEMPLATE_REQUIRED");
  const normalized = messages.map(message => {
    if (!["system", "user", "assistant", "tool"].includes(message.role) || message.content !== undefined && message.content !== null && typeof message.content !== "string") throw new EvalFailure("TOKENIZER_UNSUPPORTED_MESSAGE");
    const value: Record<string, unknown> = { role: message.role, content: message.content ?? "" };
    if (message.tool_call_id) value.tool_call_id = message.tool_call_id;
    if (message.tool_calls?.length) value.tool_calls = message.tool_calls.map(call => {
      if (typeof call.id !== "string" || typeof call.function?.name !== "string" || typeof call.function?.arguments !== "string") throw new EvalFailure("TOKENIZER_UNSUPPORTED_TOOL_CALL");
      let args: unknown; try { args = JSON.parse(call.function.arguments); } catch { throw new EvalFailure("TOKENIZER_INVALID_TOOL_ARGUMENTS"); }
      return { id: call.id, type: "function", function: { name: call.function.name, arguments: args } };
    });
    return value;
  });
  const specialTokens: Record<string, string> = {};
  for (const [name, value] of Object.entries(config)) if (name.endsWith("_token")) {
    if (typeof value === "string") specialTokens[name] = value;
    else if (value && typeof value === "object" && typeof (value as { content?: unknown }).content === "string") specialTokens[name] = (value as { content: string }).content;
  }
  try { return new Template(config.chat_template).render({ ...specialTokens, messages: normalized, tools, add_generation_prompt: true, enable_thinking: false, preserve_thinking: false }); }
  catch { throw new EvalFailure("TOKENIZER_RENDER_FAILURE"); }
}

export function createRawQwenRequestTokenizer(options: { configPath?: string; endpoint?: string; fetcher?: (input: string, init: RequestInit) => Promise<Response> } = {}): QwenRequestTokenizer {
  const configText = readFileSync(options.configPath ?? defaultConfigPath, "utf8"), config = JSON.parse(configText) as Config;
  const endpoint = new URL(options.endpoint ?? "http://127.0.0.1:11234/tokenize");
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password || endpoint.pathname !== "/tokenize") throw new EvalFailure("TOKENIZER_LOOPBACK_REQUIRED");
  const identity = { protocol: qwenTokenizerProtocol, configHash: hash(configText), templateHash: hash(config.chat_template), sourceHash: hash(readFileSync(import.meta.path, "utf8")) };
  const cache = new Map<string, number>(), fetcher = options.fetcher ?? fetch;
  const render = (messages: Messages, tools: unknown[]) => renderQwenRequest(config, messages, tools);
  return { identity, render, async countRequestTokens(messages, tools, outputTokens) {
    if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) throw new EvalFailure("TOKENIZER_INVALID_OUTPUT_BUDGET");
    const rendered = render(messages, tools), key = hash(rendered);
    if (cache.has(key)) return cache.get(key)!;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetcher(endpoint.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: rendered, add_special_tokens: false }), signal: controller.signal });
      if (!response.ok) throw new EvalFailure("TOKENIZER_HTTP_FAILURE");
      const value = await response.json() as { tokens?: unknown };
      if (!Array.isArray(value.tokens) || !value.tokens.every(token => Number.isSafeInteger(token) && token >= 0)) throw new EvalFailure("TOKENIZER_INVALID_RESPONSE");
      cache.set(key, value.tokens.length); return value.tokens.length;
    } catch (error) { if (error instanceof EvalFailure) throw error; throw new EvalFailure("TOKENIZER_TRANSPORT_FAILURE"); }
    finally { clearTimeout(timeout); }
  } };
}

export function qwenTokenizerFixtures(): { name: string; messages: Messages; tools: unknown[] }[] {
  const tools = [{ type: "function", function: { name: "synthetic_lookup", description: "Synthetic budget calibration only.", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false } } }];
  const base: Messages = [{ role: "system", content: "Return one word. This is synthetic tokenizer calibration." }, { role: "user", content: "Ready?" }];
  const continuation: Messages = [...base, { role: "assistant", content: null, tool_calls: [{ id: "synthetic-call", type: "function", function: { name: "synthetic_lookup", arguments: JSON.stringify({ key: "synthetic" }) } }] }, { role: "tool", tool_call_id: "synthetic-call", content: JSON.stringify({ value: "synthetic" }) }];
  return [
    { name: "plain", messages: base, tools: [] },
    { name: "tool-definitions", messages: base, tools },
    { name: "tool-continuation", messages: continuation, tools },
    { name: "finalization", messages: [...continuation, { role: "user", content: "Return one word now." }], tools: [] },
    { name: "multi-tool-continuation", messages: [...base, { role: "assistant", content: null, tool_calls: [
      { id: "synthetic-one", type: "function", function: { name: "synthetic_lookup", arguments: JSON.stringify({ key: "synthetic" }) } },
      { id: "synthetic-two", type: "function", function: { name: "synthetic_lookup", arguments: JSON.stringify({ key: "synthetic quote \" slash \\ 雪" }) } }
    ] }, { role: "tool", tool_call_id: "synthetic-one", content: JSON.stringify({ value: "synthetic" }) }, { role: "tool", tool_call_id: "synthetic-two", content: JSON.stringify({ value: "synthetic 雪" }) }], tools }
  ];
}

export async function validateQwenRequestTokenizer(tokenizer: QwenRequestTokenizer, backend: Backend, directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const path = resolve(directory, validationFilename);
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    requireQwenTokenizerValidation(tokenizer.identity, saved); return saved;
  }
  const receipts: Record<string, unknown>[] = [];
  for (const fixture of qwenTokenizerFixtures()) {
    const predicted = await tokenizer.countRequestTokens(fixture.messages, fixture.tools, qwenTokenizerProtocol.calibrationOutputTokens);
    const result = await backend.complete(fixture.messages, fixture.tools, `tokenizer-calibration:${fixture.name}`, qwenTokenizerProtocol.calibrationOutputTokens);
    const reported = result.inputTokens;
    receipts.push({ name: fixture.name, requestHash: hash(JSON.stringify({ messages: fixture.messages, tools: fixture.tools, outputTokens: qwenTokenizerProtocol.calibrationOutputTokens })), renderedHash: hash(tokenizer.render(fixture.messages, fixture.tools)), predicted, reported: reported ?? null, exact: predicted === reported });
  }
  const artifact = { version: qwenTokenizerProtocol.version, identity: tokenizer.identity, receipts, accepted: receipts.length === qwenTokenizerFixtures().length && receipts.every(receipt => receipt.exact) };
  writeFileSync(path, JSON.stringify(artifact, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  requireQwenTokenizerValidation(tokenizer.identity, artifact); return artifact;
}

export function requireQwenTokenizerValidation(identity: Record<string, unknown>, artifact: any) {
  const fixtures = qwenTokenizerFixtures();
  if (JSON.stringify(artifact?.identity) !== JSON.stringify(identity) || artifact?.accepted !== true || artifact?.receipts?.length !== fixtures.length || !artifact.receipts.every((receipt: any, index: number) => {
    const fixture = fixtures[index]!;
    return receipt.name === fixture.name && receipt.requestHash === hash(JSON.stringify({ messages: fixture.messages, tools: fixture.tools, outputTokens: qwenTokenizerProtocol.calibrationOutputTokens })) && receipt.exact === true && Number.isSafeInteger(receipt.predicted) && receipt.predicted >= 0 && receipt.predicted === receipt.reported;
  })) throw new EvalFailure("TOKENIZER_VALIDATION_FAILED");
}
export async function createQwenRequestTokenizer(options: { directory: string; configPath?: string; endpoint?: string } ) {
  const tokenizer = createRawQwenRequestTokenizer(options);
  const path = resolve(options.directory, validationFilename);
  if (!existsSync(path)) throw new EvalFailure("TOKENIZER_VALIDATION_REQUIRED");
  const text = readFileSync(path, "utf8"), artifact = JSON.parse(text);
  requireQwenTokenizerValidation(tokenizer.identity, artifact);
  return { countRequestTokens: tokenizer.countRequestTokens, identity: { ...tokenizer.identity, validationHash: hash(text) } };
}

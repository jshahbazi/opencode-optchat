import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const BOROS_REVISION = "f28584bb621e0900563f57b768846d9f06f875fd";
export const QWEN_MODEL = "ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit";
export class BorosDriverFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
export interface BorosEvent {
  id: string; project_id: string; conversation_key: string; role: "user" | "assistant"; status: "complete"; text: string;
  source_time?: Record<string, string>;
}
export interface BorosInput {
  version: 1;
  events: BorosEvent[];
  question: { project_id: string; conversation_key: string; prompt: string; question_time?: Record<string, string> };
  arms: ("ordinary_send" | "lexical" | "recent_only")[];
  configuration: {
    model: string; system: string; temperature: number; seed: number; thinking: false;
    maximum_output: number; context_limit: number; safety_tokens: number;
  };
}
export interface BorosSource {
  event_id: string; project_id: string; conversation_key: string; role: "user" | "assistant";
  kind: "recent" | "historical"; offset: number; bytes: number; source_bytes: number;
  source_sha256: string; excerpt_sha256: string; text: string;
}
export interface BorosAttempt {
  arm: BorosInput["arms"][number]; preparation_completed: boolean; runner_started?: boolean;
  failure?: string; failure_code?: string; preparation_milliseconds?: number;
  messages?: { role: string; content: string }[]; sources?: BorosSource[]; prompt_tokens?: number;
  body_sha256?: string; selection_sha256?: string; recent_source_ids?: string[];
  request_body_base64?: string; selection_receipt_base64?: string;
  selection_receipt?: Record<string, unknown>; context_audit?: Record<string, any>;
  semantic_index_received?: boolean;
}
export interface BorosEnvelope {
  version: string; corpus_sha256: string; cache_reused: boolean;
  attempts: BorosAttempt[]; process_milliseconds: number;
}
export interface BorosDriver {
  binary: string; template: string; manifestPath: string; manifest: Record<string, unknown>; closureDigest: string;
}
const sha = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value);
async function privateWrite(path: string, value: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}
async function command(args: string[], cwd: string, failurePath?: string) {
  const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) {
    if (failurePath) await writeFile(failurePath, stderr, { mode: 0o600 });
    throw new BorosDriverFailure("BOROS_TOOL_FAILURE");
  }
  return { stdout, stderr };
}

// Compile only immutable copied source files. Cache identity includes the new helper.
export async function ensureBorosDriver(options: { borosRepository: string; cacheRoot: string }): Promise<BorosDriver> {
  const repository = resolve(options.borosRepository), cacheRoot = resolve(options.cacheRoot);
  const current = (await command(["git", "rev-parse", "HEAD"], repository)).stdout.trim();
  if (current !== BOROS_REVISION) throw new BorosDriverFailure("BOROS_REVISION_MISMATCH");
  const tracked = (await command(["git", "ls-tree", "-r", "--name-only", BOROS_REVISION], repository)).stdout.trim().split("\n");
  const sources = tracked.filter(path => path.startsWith("Sources/Boros/") && path.endsWith(".swift") && basename(path) !== "BonsaiPlayground.swift").sort();
  const assets = ["Sources/CSQLite/module.modulemap", "Sources/CSQLite/shim.h", "Tests/qwen38-chat-template.jinja"];
  const files = [...sources, ...assets];
  const captured: { path: string; bytes: number; sha256: string }[] = [];
  for (const path of files) {
    const original = await readFile(join(repository, path));
    const pinned = (await command(["git", "show", `${BOROS_REVISION}:${path}`], repository)).stdout;
    if (sha(original) !== sha(pinned)) throw new BorosDriverFailure("BOROS_SOURCE_MISMATCH");
    captured.push({ path, bytes: original.byteLength, sha256: sha(original) });
  }
  const helperPath = new URL("./boros-context-driver.swift", import.meta.url).pathname;
  const helper = await readFile(helperPath);
  const compiler = (await command(["xcrun", "swiftc", "--version"], repository)).stdout.trim();
  const closureDigest = sha(json({ revision: BOROS_REVISION, files: captured, helper: sha(helper), compiler }));
  const closure = join(cacheRoot, "boros-source", closureDigest), binary = join(closure, "BorosContextDriver");
  const template = join(closure, "Tests/qwen38-chat-template.jinja"), manifestPath = join(closure, "manifest.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.closure_sha256 !== closureDigest || manifest.binary_sha256 !== sha(await readFile(binary))) throw new BorosDriverFailure("BOROS_CACHE_MISMATCH");
    for (const file of captured) {
      if (sha(await readFile(join(closure, file.path))) !== file.sha256) throw new BorosDriverFailure("BOROS_CACHE_MISMATCH");
    }
    if (sha(await readFile(join(closure, "boros-context-driver.swift"))) !== sha(helper)) throw new BorosDriverFailure("BOROS_CACHE_MISMATCH");
    return { binary, template, manifestPath, manifest, closureDigest };
  } catch (error) {
    if (error instanceof BorosDriverFailure) throw error;
    try { await stat(manifestPath); throw new BorosDriverFailure("BOROS_CACHE_MISMATCH"); }
    catch (failure) { if (failure instanceof BorosDriverFailure) throw failure; }
  }
  await mkdir(closure, { recursive: true, mode: 0o700 });
  for (const file of captured) {
    const destination = join(closure, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(join(repository, file.path), destination);
    await chmod(destination, 0o600);
    if (sha(await readFile(destination)) !== file.sha256) throw new BorosDriverFailure("BOROS_SOURCE_COPY_MISMATCH");
  }
  await writeFile(join(closure, "boros-context-driver.swift"), helper, { mode: 0o600 });
  const include = join(closure, "Sources/CSQLite");
  const args = ["xcrun", "swiftc", "-swift-version", "5", "-O", "-parse-as-library", "-I", include,
    ...sources.map(path => join(closure, path)), join(closure, "boros-context-driver.swift"), "-o", binary];
  const result = await command(args, closure, join(closure, "compiler-failure-stderr.txt"));
  await privateWrite(join(closure, "compiler-stderr.txt"), result.stderr);
  await chmod(binary, 0o700);
  const manifest = { version: "boros-public-context-closure-v1", revision: BOROS_REVISION, closure_sha256: closureDigest,
    helper_sha256: sha(helper), binary_sha256: sha(await readFile(binary)), compiler, files: captured,
    tokenizer_mode: "injected-tokenizer-with-generation-refusal", native_generation: false };
  await privateWrite(manifestPath, json(manifest));
  return { binary, template, manifestPath, manifest, closureDigest };
}

// Match the pinned Boros endpoint fixture for the restricted text-only request.
export function renderBorosQwenBody(body: any): string {
  if (!Array.isArray(body.messages) || body.enable_thinking !== false || body.response_format !== undefined || body.tools !== undefined) {
    throw new BorosDriverFailure("BOROS_UNSUPPORTED_RENDER_INPUT");
  }
  const messages = body.messages.filter((message: any) => message.content !== "");
  if (!messages.length || messages.some((message: any) => !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string")) {
    throw new BorosDriverFailure("BOROS_UNSUPPORTED_RENDER_INPUT");
  }
  const trim = (text: string) => text.replace(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/g, "");
  const system = messages[0].role === "system" ? trim(messages[0].content) : "";
  let text = system ? `<|im_start|>system\n${system}<|im_end|>\n` : "";
  for (const message of messages) {
    if (message.role === "system") continue;
    text += `<|im_start|>${message.role}\n${message.role === "assistant" ? "<think>\n\n</think>\n\n" : ""}${trim(message.content)}<|im_end|>\n`;
  }
  text += "<|im_start|>assistant\n<think>\n\n</think>\n\n";
  while (text.includes("</think></think>")) text = text.replaceAll("</think></think>", "</think>");
  return text;
}

export function createBorosTokenizerFixture(options: {
  template: string; contextLimit: number; tokenize: (text: string) => Promise<number[]>;
}) {
  const counters = { metadata: 0, tokenize: 0, calibration: 0, refusedGeneration: 0, rejected: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(request) {
    const path = new URL(request.url).pathname;
    const response = (value: unknown, status = 200) => Response.json(value, { status });
    try {
      if (request.method === "GET") {
        counters.metadata++;
        if (path === "/v1/models") return response({ data: [{ id: QWEN_MODEL, owned_by: "mlx-serve", loaded: true, state: "ready", created: 1791463722,
          context_length: options.contextLimit, max_model_len: options.contextLimit, capabilities: ["chat", "streaming", "json_schema"],
          input_modalities: ["text"], meta: { engine: "mlx", architecture: "qwen4_exp" } }] });
        if (path === "/props") return response({ settings: { version: "26.10.1", engine: "mlx" },
          default_generation_settings: { n_ctx: options.contextLimit }, memory: { max_safe_context: options.contextLimit } });
        return response({}, 404);
      }
      if (request.method !== "POST") return response({}, 405);
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > 16 * 1024 * 1024) return response({}, 413);
      const body = JSON.parse(raw);
      if (path === "/api/show") {
        counters.metadata++;
        return response({ model_info: { "general.basename": QWEN_MODEL }, template: options.template });
      }
      if (path === "/tokenize") {
        counters.tokenize++;
        if (typeof body.content !== "string") throw new BorosDriverFailure("BOROS_INVALID_TOKEN_INPUT");
        return response({ tokens: await options.tokenize(body.content) });
      }
      if (path === "/v1/chat/completions" && body.stream === false && body.max_tokens === 1 && body.model === QWEN_MODEL) {
        counters.calibration++;
        const promptTokens = (await options.tokenize(renderBorosQwenBody(body))).length;
        return response({ model: QWEN_MODEL, usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 } });
      }
      counters.refusedGeneration++;
      return response({}, 503);
    } catch {
      counters.rejected++;
      return response({}, 400);
    }
  } });
  return { endpoint: `http://127.0.0.1:${server.port}/v1/`, counters, stop: () => server.stop(true) };
}

// This proxy sends text only to the local tokenizer endpoint. It cannot generate.
export function localBorosTokenizer(endpoint: string) {
  const url = new URL("/tokenize", endpoint);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new BorosDriverFailure("BOROS_LOOPBACK_TOKENIZER_REQUIRED");
  }
  return async (text: string): Promise<number[]> => {
    const result = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" },
      body: json({ content: text }), signal: AbortSignal.timeout(60000) });
    if (!result.ok) throw new BorosDriverFailure("BOROS_TOKENIZER_FAILED");
    const body: any = await result.json();
    if (!Array.isArray(body.tokens) || body.tokens.some((token: unknown) => !Number.isSafeInteger(token) || (token as number) < 0)) {
      throw new BorosDriverFailure("BOROS_TOKENIZER_INVALID");
    }
    return body.tokens;
  };
}

export function verifyBorosEnvelope(envelope: BorosEnvelope, input: BorosInput) {
  if (envelope.version !== "boros-public-context-v1" || envelope.corpus_sha256 !== sha(json(input.events)) ||
      envelope.attempts.length !== input.arms.length || envelope.attempts.some((attempt, index) => attempt.arm !== input.arms[index])) {
    throw new BorosDriverFailure("BOROS_ENVELOPE_INVALID");
  }
  const originals = new Map(input.events.map(event => [event.id, event]));
  for (const attempt of envelope.attempts) {
    if (!attempt.preparation_completed) continue;
    if (attempt.runner_started !== false || !Array.isArray(attempt.messages) || !Array.isArray(attempt.sources) ||
        !attempt.selection_receipt || !attempt.context_audit || !Number.isSafeInteger(attempt.prompt_tokens) ||
        typeof attempt.request_body_base64 !== "string" || typeof attempt.selection_receipt_base64 !== "string") {
      throw new BorosDriverFailure("BOROS_ENVELOPE_INVALID");
    }
    const bodyBytes = Buffer.from(attempt.request_body_base64, "base64"), selectionBytes = Buffer.from(attempt.selection_receipt_base64, "base64");
    const body = JSON.parse(bodyBytes.toString("utf8")), selection = JSON.parse(selectionBytes.toString("utf8"));
    if (sha(bodyBytes) !== attempt.body_sha256 || sha(selectionBytes) !== attempt.selection_sha256 ||
        json(body.messages) !== json(attempt.messages) || json(selection) !== json(attempt.selection_receipt)) {
      throw new BorosDriverFailure("BOROS_ENVELOPE_INVALID");
    }
    for (const source of attempt.sources) {
      const original = originals.get(source.event_id);
      if (!original) throw new BorosDriverFailure("BOROS_SOURCE_RECEIPT_INVALID");
      const complete = new TextEncoder().encode(original.text), returned = new TextEncoder().encode(source.text);
      const exact = complete.slice(source.offset, source.offset + source.bytes);
      if (!Number.isSafeInteger(source.offset) || !Number.isSafeInteger(source.bytes) || source.offset < 0 || source.bytes < 0 ||
          source.offset + source.bytes > complete.byteLength || source.source_bytes !== complete.byteLength ||
          source.source_sha256 !== sha(complete) || source.excerpt_sha256 !== sha(returned) || source.excerpt_sha256 !== sha(exact) ||
          returned.byteLength !== source.bytes || source.role !== original.role || source.project_id !== original.project_id || source.conversation_key !== original.conversation_key) {
        throw new BorosDriverFailure("BOROS_SOURCE_RECEIPT_INVALID");
      }
    }
  }
}

export async function runBorosContext(driver: BorosDriver, input: BorosInput, options: { outputDirectory: string; cacheRoot: string; endpoint: string }): Promise<BorosEnvelope> {
  const directory = resolve(options.outputDirectory), cacheRoot = resolve(options.cacheRoot);
  const corpus = sha(json(input.events));
  const frozen = { ...input, corpus_sha256: corpus, cache_directory: join(cacheRoot, "boros-stores", driver.closureDigest, corpus),
    work_directory: join(directory, "attempt-work"), configuration: { ...input.configuration, endpoint: options.endpoint } };
  const inputPath = join(directory, "boros-input.json"), outputPath = join(directory, "boros-context.json");
  await privateWrite(inputPath, json(frozen));
  const child = Bun.spawn([driver.binary, inputPath, outputPath], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60 * 1000);
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  await privateWrite(join(directory, "boros-process.json"), json({ exit_code: code, stdout, stderr }));
  if (code !== 0) throw new BorosDriverFailure("BOROS_CONTEXT_FAILED");
  const envelope: BorosEnvelope = JSON.parse(await readFile(outputPath, "utf8"));
  verifyBorosEnvelope(envelope, input);
  return envelope;
}

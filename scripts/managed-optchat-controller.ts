import { Retrieval, bytes, hash, sourceKey } from "../src/index.ts";
import { EvalFailure, type Backend, type Receipt } from "./local-memory-eval.ts";
import { longTools, type PreparedLongCase } from "./long-history-eval.ts";
import { expandedInitialMessages, expandedMemoryProtocol, type RequestTokenCounter } from "./expanded-memory-comparison.ts";
import { optionalDeliveredEvidence } from "./optional-parent-comparison.ts";
import type { DeliveredEvidence } from "./compare-long-history.ts";

type Messages = Parameters<Backend["complete"]>[0];
type Message = Messages[number];
type ToolCall = NonNullable<Message["tool_calls"]>[number];
export type ManagedRequestReceipt = { messages: Messages; tools: unknown[]; outputTokens: number; inputTokens: number; requestHash: string; providerInputTokens?: number | null };
type ToolName = "optchat_search" | "optchat_zoom" | "optchat_source";
type ToolExecution = { callId: string; name: string; requestKey: string; input: Record<string, any> | null; result: any; cacheHit: boolean; pageReductions: number };
type ToolGroup = { index: number; messages: Messages; sourceBearing: boolean; resultHashes: string[]; requestResultHashes: string[]; groupHash: string };
export const managedControllerProtocol = {
  version: "bounded-optchat-controller-1", contextTokens: 32768, outputTokens: 2048, safetyTokens: 1024,
  continuationMarginTokens: 256, maxAnswerSteps: 12, maxToolCallsPerRound: 64,
  initialMessages: "Unchanged expanded initial messages.", tools: "Unchanged literal search, zoom, and source APIs.",
  eviction: "Remove complete duplicated groups. At capacity, remove older navigation groups before source groups.",
  reduction: "Reduce complete API pages. Do not cut original text or summaries.",
  finalization: "Use the existing final instruction without tools after capacity or step exhaustion.",
  evidence: "Compute delivered evidence from the final submitted request. Keep cumulative retrieval receipts separately.",
} as const;
export const managedFinalInstruction = "Answer the question now from the evidence already delivered. State any uncertainty. Cite original sourceId values. No further retrieval is available.";
const fatalCodes = new Set(["CALL_LIMIT", "RUN_DEADLINE", "CONCURRENT_EVALUATION", "SNAPSHOT_REVOKED"]);
const safeCode = (error: unknown) => { const code = (error as { code?: unknown })?.code; return typeof code === "string" && /^[A-Z_0-9]{1,64}$/.test(code) ? code : "INTERNAL_FAILURE"; };
function failFatal(error: unknown) { const code = safeCode(error); if (fatalCodes.has(code)) throw error instanceof EvalFailure ? error : new EvalFailure(code); }
const finalMessage: Message = { role: "user", content: managedFinalInstruction };
const digest = (value: unknown) => hash(JSON.stringify(value));

function normalizedInput(call: ToolCall): { name: ToolName; input: Record<string, any>; requestKey: string } {
  let raw: any;
  try { raw = JSON.parse(call.function.arguments); } catch { throw new EvalFailure("INVALID_TOOL_INPUT"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new EvalFailure("INVALID_TOOL_INPUT");
  const name = call.function.name as ToolName;
  let input: Record<string, any>;
  if (name === "optchat_search") {
    if (typeof raw.query !== "string") throw new EvalFailure("INVALID_TOOL_INPUT");
    input = { query: raw.query, offset: raw.offset ?? 0, limit: raw.limit ?? 12 };
    if (!raw.query.trim() || raw.query.length > 1024 || !Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new EvalFailure("INVALID_QUERY");
  } else if (name === "optchat_zoom") {
    if (typeof raw.id !== "string") throw new EvalFailure("INVALID_TOOL_INPUT");
    input = { id: raw.id, offset: raw.offset ?? 0, limit: raw.limit ?? 16 };
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 128) throw new EvalFailure("INVALID_PAGE");
  } else if (name === "optchat_source") {
    if (typeof raw.id !== "string") throw new EvalFailure("INVALID_TOOL_INPUT");
    input = { id: raw.id, offset: raw.offset ?? 0, maxBytes: raw.maxBytes ?? 8192 };
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 4 || input.maxBytes > 32768) throw new EvalFailure("INVALID_PAGE");
  } else throw new EvalFailure("UNKNOWN_TOOL");
  return { name, input, requestKey: digest({ name, input }) };
}

function validateResponse(message: Message) {
  if (!message || message.role !== "assistant" || message.content !== null && typeof message.content !== "string") throw new EvalFailure("INVALID_ASSISTANT_RESPONSE");
  if (message.tool_calls === undefined) return;
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length > managedControllerProtocol.maxToolCallsPerRound) throw new EvalFailure("INVALID_TOOL_CALLS");
  const ids = new Set<string>();
  for (const call of message.tool_calls) {
    if (!call || call.type !== "function" || typeof call.id !== "string" || !call.id || ids.has(call.id) || !call.function || typeof call.function.name !== "string" || typeof call.function.arguments !== "string") throw new EvalFailure("INVALID_TOOL_CALLS");
    ids.add(call.id);
  }
}

export function assertManagedToolProtocol(messages: Messages) {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id)) throw new EvalFailure("UNPAIRED_TOOL_PROTOCOL");
      continue;
    }
    if (pending.size) throw new EvalFailure("UNPAIRED_TOOL_PROTOCOL");
    if (message.role === "assistant") { validateResponse(message); for (const call of message.tool_calls ?? []) pending.add(call.id); }
  }
  if (pending.size) throw new EvalFailure("UNPAIRED_TOOL_PROTOCOL");
}

export function managedDeliveredEvidence(answer: Parameters<typeof optionalDeliveredEvidence>[0], prepared: PreparedLongCase, submittedMessages: Messages): DeliveredEvidence[] {
  const checked = optionalDeliveredEvidence(answer, prepared as Parameters<typeof optionalDeliveredEvidence>[1], submittedMessages);
  const originals = new Map(prepared.sources.map(source => [sourceKey(source), source]));
  const calls = new Map<string, { name: string; input: any }>(), intervals = new Map<string, [number, number][]>();
  const add = (id: string, offset: number, text: string) => { const values = intervals.get(id) ?? []; values.push([offset, offset + Array.from(text).length]); intervals.set(id, values); };
  for (const message of submittedMessages) {
    if (message.role === "assistant") for (const call of message.tool_calls ?? []) {
      try { calls.set(call.id, { name: call.function.name, input: JSON.parse(call.function.arguments) }); } catch { calls.delete(call.id); }
    }
    if (message.role !== "tool" || !message.tool_call_id || !message.content) continue;
    const call = calls.get(message.tool_call_id); if (!call) continue;
    const value = JSON.parse(message.content); if (value.error) continue;
    if (call.name === "optchat_source") add(value.sourceId, call.input.offset ?? 0, value.text);
    if (call.name === "optchat_search") for (const hit of value.hits) if (hit.type === "source") add(hit.id, 0, hit.text);
  }
  const complete = new Map(checked.filter(item => item.complete).map(item => [item.sourceId, item]));
  const partial: DeliveredEvidence[] = checked.filter(item => !item.complete && !intervals.has(item.sourceId));
  for (const [id, values] of intervals) {
    const original = originals.get(id); if (!original) throw new EvalFailure("SOURCE_PAGE_RECEIPT_MISMATCH");
    const points = Array.from(original.payload), merged: [number, number][] = [];
    for (const span of values.sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
      const previous = merged.at(-1);
      if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]); else merged.push([...span]);
    }
    if (merged.length === 1 && merged[0]![0] === 0 && merged[0]![1] === points.length) complete.set(id, { sourceId: id, text: original.payload, complete: true });
    else if (!complete.has(id)) for (const [start, end] of merged) partial.push({ sourceId: id, text: points.slice(start, end).join(""), complete: false });
  }
  return [...partial.filter(item => !complete.has(item.sourceId)), ...complete.values()];
}

export async function answerManagedQuestion(backend: Backend, prepared: PreparedLongCase, question: { id: string; category: string; question: string }, options: { countRequestTokens: RequestTokenCounter; maxSteps?: number }) {
  const maxSteps = options.maxSteps ?? managedControllerProtocol.maxAnswerSteps;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 12) throw new EvalFailure("INVALID_ANSWER_STEPS");
  const initial = expandedInitialMessages(prepared, question), initialMessages = structuredClone(initial.messages), fullTranscript = structuredClone(initialMessages);
  const retrieval = new Retrieval(prepared.engine), available = managedControllerProtocol.contextTokens - managedControllerProtocol.outputTokens - managedControllerProtocol.safetyTokens;
  const requestReceipts: ManagedRequestReceipt[] = [], toolExecutions: ToolExecution[] = [], groups: ToolGroup[] = [], bufferLedger: { requestIndex: number; groupIndices: number[]; groupHashes: string[]; finalizing: boolean; messagesHash: string }[] = [];
  const evictions: { groupIndex: number; groupHash: string; reason: "duplicate" | "navigation_budget" | "source_budget" | "pending_budget"; beforeRequest: number }[] = [];
  const cache = new Map<string, { result: any; input: Record<string, any> }>(), countCache = new Map<string, number>();
  let active: ToolGroup[] = [], finalText = "", failure: string | null = null, steps = 0, finalizationCalls = 0, responseBytes = 0, submittedMessages: Messages = [], forceFinal = false;
  const controllerMetrics = { cacheHits: 0, duplicateGroupEvictions: 0, navigationGroupEvictions: 0, sourceGroupEvictions: 0, pendingGroupEvictions: 0, pageReductions: 0, budgetFinalizations: 0, maxBufferedGroups: 0, maxBufferedToolBytes: 0 };
  const toolCounts = { search: 0, source: 0, zoom: 0, errors: 0 }, receipts: Receipt[] = [], pages = new Map<string, Map<number, { text: string; next: number | null }>>();
  const started = Date.now();
  const render = (selected = active, finalizing = false) => [...structuredClone(initialMessages), ...selected.flatMap(group => structuredClone(group.messages)), ...(finalizing ? [structuredClone(finalMessage)] : [])];
  const count = async (candidate: Messages, tools: unknown[]) => {
    const identity = digest({ messages: candidate, tools, outputTokens: managedControllerProtocol.outputTokens }), existing = countCache.get(identity);
    if (existing !== undefined) return existing;
    const tokens = await options.countRequestTokens(candidate, tools, managedControllerProtocol.outputTokens);
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new EvalFailure("INVALID_TOKEN_COUNT");
    countCache.set(identity, tokens); return tokens;
  };
  const fits = async (selected: ToolGroup[]) => await count(render(selected), longTools) <= available - managedControllerProtocol.continuationMarginTokens && await count(render(selected, true), []) <= available;
  const fitsFinal = async (selected: ToolGroup[]) => await count(render(selected, true), []) <= available;
  const evict = (group: ToolGroup, reason: typeof evictions[number]["reason"]) => {
    active = active.filter(item => item.index !== group.index); evictions.push({ groupIndex: group.index, groupHash: group.groupHash, reason, beforeRequest: requestReceipts.length });
    if (reason === "duplicate") controllerMetrics.duplicateGroupEvictions++;
    if (reason === "navigation_budget") controllerMetrics.navigationGroupEvictions++;
    if (reason === "source_budget") controllerMetrics.sourceGroupEvictions++;
    if (reason === "pending_budget") controllerMetrics.pendingGroupEvictions++;
  };
  const complete = async (finalizing: boolean) => {
    prepared.engine.validateSnapshot(prepared.snapshot);
    const messages = render(active, finalizing), tools = finalizing ? [] : longTools;
    assertManagedToolProtocol(messages);
    if (JSON.stringify(messages.slice(0, 2)) !== JSON.stringify(initialMessages)) throw new EvalFailure("INITIAL_MESSAGES_MISMATCH");
    const inputTokens = await count(messages, tools);
    if (inputTokens > available) throw new EvalFailure("ANSWER_CONTEXT_BUDGET");
    submittedMessages = structuredClone(messages);
    const request = { messages: submittedMessages, tools: structuredClone(tools), outputTokens: managedControllerProtocol.outputTokens, inputTokens };
    const receipt: ManagedRequestReceipt = { ...request, requestHash: digest(request) }; requestReceipts.push(receipt); steps++;
    bufferLedger.push({ requestIndex: requestReceipts.length - 1, groupIndices: active.map(group => group.index), groupHashes: active.map(group => group.groupHash), finalizing, messagesHash: digest(messages) });
    const result = await backend.complete(structuredClone(messages), structuredClone(tools), `answer:optchat:${question.id}${finalizing ? ":final" : ""}`, managedControllerProtocol.outputTokens);
    receipt.providerInputTokens = result.inputTokens;
    if (result.inputTokens === null) throw new EvalFailure("TOKENIZER_COUNT_MISSING");
    if (result.inputTokens !== inputTokens) throw new EvalFailure("TOKENIZER_COUNT_MISMATCH");
    validateResponse(result.message); return result;
  };
  const invoke = (name: ToolName, input: Record<string, any>) => name === "optchat_search" ? retrieval.search(prepared.snapshot, input.query, input.offset, input.limit) : name === "optchat_zoom" ? retrieval.zoom(prepared.snapshot, input.id, input.offset, input.limit) : retrieval.source(prepared.snapshot, input.id, input.offset, input.maxBytes);
  const refreshGroup = (group: ToolGroup, assistant: Message, executions: ToolExecution[]) => {
    group.messages = [structuredClone(assistant), ...executions.map(execution => ({ role: "tool", tool_call_id: execution.callId, content: JSON.stringify(execution.result) }))];
    group.resultHashes = executions.map(execution => digest(execution.result));
    group.requestResultHashes = executions.map(execution => digest({ requestKey: execution.requestKey, resultHash: digest(execution.result) }));
    group.sourceBearing = executions.some(execution => execution.name === "optchat_source" && !execution.result.error);
    group.groupHash = digest(group.messages);
  };
  const recordPage = (execution: ToolExecution) => {
    if (execution.name !== "optchat_source" || execution.result.error || !execution.input) return;
    const value = execution.result, original = prepared.engine.source(execution.input.id), received = pages.get(value.sourceId) ?? new Map<number, { text: string; next: number | null }>();
    received.set(execution.input.offset, { text: value.text, next: value.next }); pages.set(value.sourceId, received);
    let cursor: number | null = 0, combined = ""; const visited = new Set<number>();
    while (cursor !== null && received.has(cursor) && !visited.has(cursor)) { visited.add(cursor); const page: { text: string; next: number | null } = received.get(cursor)!; combined += page.text; cursor = page.next; }
    receipts.push({ sourceId: value.sourceId, payloadHash: original.payloadHash, returnedHash: hash(combined), bytes: bytes(combined), complete: cursor === null, exact: cursor === null && combined === original.payload });
  };
  try {
    if (await count(initialMessages, longTools) > available || await count([...initialMessages, finalMessage], []) > available) throw new EvalFailure("ANSWER_CONTEXT_BUDGET");
    for (let round = 0; round < maxSteps; round++) {
      const result = await complete(false), assistant = structuredClone(result.message);
      if (!assistant.tool_calls?.length) { fullTranscript.push(assistant); finalText = assistant.content ?? ""; break; }
      const executions: ToolExecution[] = [];
      for (const call of assistant.tool_calls) {
        const execution: ToolExecution = { callId: call.id, name: call.function.name, requestKey: digest(call.function), input: null, result: null, cacheHit: false, pageReductions: 0 };
        try {
          const normalized = normalizedInput(call); execution.input = normalized.input; execution.requestKey = normalized.requestKey;
          toolCounts[normalized.name === "optchat_search" ? "search" : normalized.name === "optchat_source" ? "source" : "zoom"]++;
          const cached = cache.get(normalized.requestKey);
          if (cached) { prepared.engine.validateSnapshot(prepared.snapshot); execution.result = structuredClone(cached.result); execution.input = structuredClone(cached.input); execution.cacheHit = true; controllerMetrics.cacheHits++; }
          else { execution.result = invoke(normalized.name, normalized.input); cache.set(normalized.requestKey, { result: structuredClone(execution.result), input: structuredClone(normalized.input) }); }
        } catch (error) { failFatal(error); toolCounts.errors++; execution.result = { error: safeCode(error) }; }
        executions.push(execution);
      }
      const group: ToolGroup = { index: groups.length, messages: [], sourceBearing: false, resultHashes: [], requestResultHashes: [], groupHash: "" };
      refreshGroup(group, assistant, executions);
      const newResults = new Set(group.requestResultHashes), duplicates = active.filter(old => old.requestResultHashes.length && old.requestResultHashes.every(value => newResults.has(value)));
      if (duplicates.length && await fits([...active.filter(old => !duplicates.includes(old)), group])) for (const old of duplicates) evict(old, "duplicate");
      while (!await fits([...active, group])) {
        const navigation = active.find(item => !item.sourceBearing);
        if (!navigation) break; evict(navigation, "navigation_budget");
      }
      const reducePage = async (execution: ToolExecution) => {
        while (!await fits([...active, group]) && execution.input && !execution.result.error) {
          const name = execution.name as ToolName, field = name === "optchat_source" ? "maxBytes" : "limit", minimum = name === "optchat_source" ? 4 : 1;
          if (execution.input[field] <= minimum) break;
          if (name === "optchat_source" && await fitsFinal([...active, group])) break;
          execution.input = { ...execution.input, [field]: Math.max(minimum, name === "optchat_source" ? Math.floor(execution.input[field] / 2) : Math.floor(execution.input[field] / 2)) };
          execution.result = invoke(name, execution.input); execution.pageReductions++; controllerMetrics.pageReductions++; refreshGroup(group, assistant, executions);
        }
      };
      for (const execution of executions.filter(item => item.name !== "optchat_source")) await reducePage(execution);
      while (!await fits([...active, group]) && active.length) evict(active[0]!, "source_budget");
      for (const execution of executions.filter(item => item.name === "optchat_source")) await reducePage(execution);
      if (!await fits([...active, group]) && await fitsFinal([...active, group])) forceFinal = true;
      if (!await fitsFinal([...active, group])) {
        for (const execution of executions) { execution.result = { error: "TOOL_CONTEXT_BUDGET" }; toolCounts.errors++; }
        refreshGroup(group, assistant, executions); forceFinal = true;
      }
      groups.push(group); active.push(group);
      if (!await fitsFinal(active)) { evict(group, "pending_budget"); forceFinal = true; }
      for (const execution of executions) {
        responseBytes += bytes(JSON.stringify(execution.result)); recordPage(execution); toolExecutions.push(structuredClone(execution));
        if (execution.input && !execution.result.error) {
          const effectiveKey = digest({ name: execution.name, input: execution.input });
          if (!cache.has(effectiveKey)) cache.set(effectiveKey, { result: structuredClone(execution.result), input: structuredClone(execution.input) });
        }
      }
      fullTranscript.push(...structuredClone(group.messages));
      controllerMetrics.maxBufferedGroups = Math.max(controllerMetrics.maxBufferedGroups, active.length);
      controllerMetrics.maxBufferedToolBytes = Math.max(controllerMetrics.maxBufferedToolBytes, active.flatMap(item => item.messages).filter(message => message.role === "tool").reduce((total, message) => total + bytes(message.content ?? ""), 0));
      if (forceFinal) { controllerMetrics.budgetFinalizations++; break; }
    }
    if (!finalText) {
      finalizationCalls++; fullTranscript.push(structuredClone(finalMessage));
      const result = await complete(true); fullTranscript.push(structuredClone(result.message));
      if (result.message.tool_calls?.length) throw new EvalFailure("FINALIZATION_TOOL_CALL"); finalText = result.message.content ?? "";
    }
    if (!finalText.trim()) failure = "EMPTY_ANSWER";
  } catch (error) { failFatal(error); failure = safeCode(error); }
  const exactSources = [...new Set(receipts.filter(receipt => receipt.complete && receipt.exact && receipt.payloadHash === receipt.returnedHash).map(receipt => receipt.sourceId))], citations = prepared.sources.map(sourceKey).filter(id => finalText.includes(id));
  const answer = { public: { questionId: question.id, questionHash: hash(question.question), category: question.category, arm: "optchat" as const, failure, steps, finalizationCalls, latencyMs: Date.now() - started, contextBytes: bytes(initial.memory), toolResponseBytes: responseBytes, toolCounts, exactSourceReceipts: exactSources.length, citedOriginalCount: citations.length, maxRequestTokenBound: Math.max(0, ...requestReceipts.map(receipt => receipt.inputTokens)), caseHash: prepared.metrics.caseHash, protocolHash: digest(managedControllerProtocol), controller: controllerMetrics }, private: { finalText, messages: fullTranscript, fullTranscript, submittedMessages, receipts, exactSources, citations, requestTokenBounds: requestReceipts.map(receipt => receipt.inputTokens), requestReceipts, toolExecutions, groups, bufferLedger, evictions } };
  const deliveredEvidence = managedDeliveredEvidence(answer, prepared, submittedMessages);
  const everFetchedEvidence = managedDeliveredEvidence(answer, prepared, fullTranscript);
  return { public: { ...answer.public, finalDeliveredOriginalCount: new Set(deliveredEvidence.map(item => item.sourceId)).size, finalCompleteOriginalCount: deliveredEvidence.filter(item => item.complete).length, everFetchedOriginalCount: new Set(everFetchedEvidence.map(item => item.sourceId)).size }, private: { ...answer.private, deliveredEvidence, everFetchedEvidence } };
}

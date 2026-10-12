# BEAM long-history comparison

## Frozen preparation

This protocol was recorded before new long-history model calls.
The selected corpus is conversation 1 in BEAM's 500K directory.
Selection used directory order before candidate answers existed.
All 796 messages retain their original order, roles, and complete text.
Original date anchors remain labelled in the text.

The normalized file SHA-256 is `cc239ed1f08efd95b55172d77877c40dc011a1f97b7eb976c0fcf2b8dc47fa49`.
The BEAM revision is `b2da22eac88bb0874c64665f13457eb99835774a`.
See [BEAM](https://github.com/mohammadtavakoli78/BEAM) for the source and native evaluation categories.
Dataset attribution uses CC BY-SA 4.0.
The private normalized case retains raw chat and question hashes.

The local tokenizer measures 455,226 tokens across individual messages.
This count excludes request framing.
The history exceeds the local server's reported 262,144-token context window.
The comparison will not substitute a truncated history for a full-history control.

## Model and preparation limits

The model is `ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit` at `http://127.0.0.1:11234`.
Requests use temperature zero and top-level `enable_thinking: false`.
Requests run serially.
Private captures retain only visible messages and usage metadata.

OptChat groups consecutive message pairs into terminal turns.
Preparation receives original messages without questions, references, or rubrics.
Preparation uses complete-input chunking, 10,000-byte leaf inputs, and batches of at most eight summaries.
Summary output permits 1,024 tokens, five correction retries, and 640 UTF-8 bytes per accepted summary.
The stored view uses 16,000-byte and 12,000-byte hysteresis limits.

The cumulative budget permits 6,000 calls and 180 minutes from the first preparation invocation.
Resume preserves those limits and immutable call captures.
Failed jobs require an explicit retry invocation.
Original hashes must match before scoring starts.

## Paired answers

The primary comparison uses all 20 native questions across ten categories.
The arms are OptChat, Boros ordinary-send retrieval, and a recent-original suffix control.
Every arm uses the same local Qwen model and 2,048 output tokens.
Answers use natural text.
Answer correctness does not require a particular JSON field or Markdown format.

OptChat receives a 16,000-byte projection and the implemented search, source, and zoom tools.
It permits 12 navigation rounds and one answer-only finalization request.
Its request limit is 32,768 tokens with a conservative UTF-8 upper bound.
The recent control receives a contiguous 16,000-byte suffix of complete originals.

Boros uses the exact source closure from revision `f28584bb621e0900563f57b768846d9f06f875fd`.
An isolated adapter exports the production ordinary-send context through the native coordinator.
It uses 8,000 recent tokens, 12,000 evidence tokens, and at most 16 evidence spans.
Semantic retrieval remains disabled by current policy.
The adapter must verify exact request and source receipt hashes before generation.
This measures retrieval followed by local answering, rather than the complete Boros application delivery path.

## Scoring and interpretation

A blinded local Qwen grader receives native references and rubrics without arm names.
Calibration uses authored positive references and deliberately incorrect controls before accepting comparative scores.
Malformed grades or failed calibration invalidate aggregate quality claims.
Correctness and support from delivered originals are separate measures.
Source coverage counts only resolvable native message pointers.

Six questions have structured criteria instead of a scalar reference answer.
They remain in the primary cohort.
Native unresolved prose references remain unresolved.
The report will include failures, call counts, latency, preparation cost, and per-category counts.

This is a descriptive comparison on one public synthetic history.
The answer model and grader share model biases.
The result cannot establish representative quality across private histories or all BEAM conversations.
Existing Boros experiments remain outside this run.

## Publication scheduling

Schema 3 stores unresolved publication dependencies by exact tree coordinates.
Node commits wake only matching candidates inside the existing transaction.
Terminal turns register their own candidate instead of scanning every historical turn.
Restart, retention, and schema migration reconstruct unresolved candidates without changing immutable originals.

Deterministic tests cover migration, interrupted work, failed-job retry, retention, concurrent stores, and indexed query plans.
The scaling probe counts full-turn scans, indexed queries, and matched dependencies.
Its timing includes ordinary ingestion with a drained frontier.
The change does not establish linear complexity for backlogged frontier traversal or every engine operation.

# Design comparison and independent probes

## Reviewed versions

Review date: 11 October 2026.

The upstream implementation commit is `e4da6fba55d4212f7031300c3bd71f0d1e2dfa61`.
The proposal revision is `3c190e06f34aba0c69f49042c526093269604935`.
The public source is [Victor Taelin's proposal](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449/3c190e06f34aba0c69f49042c526093269604935#file-optchat-md).

This review examines design fidelity, retrieval, evaluation limits, and archive scaling.
All probes use synthetic records and the deterministic summarizer.
The probes make no model calls and retain no user history.

## Assessment

The repository implements a durable multi-session memory engine with an OpenCode adapter.
Its own paper deliberately extends and changes the linked proposal.
Passing structural tests establishes specific storage and protocol behavior.
General answer quality, faithful summaries, and the proposal's cache savings require separate measurements.

The implementation's [compatibility matrix](../compatibility.md) limits support to the checked OpenCode V2 boundaries.
Its repeated real-model baseline benchmark remains unmeasured.

## Material design differences

| Property | Linked proposal | Reviewed implementation |
| --- | --- | --- |
| Conversation model | One continuous log | Independent session trees and a shared completed-turn tree |
| Merge priority | Age from the inclusive last message | Age from the exclusive range end |
| Main view thresholds | 128,000 bytes down to 64,000 bytes | Engine defaults of 16,000 bytes down to 12,000 bytes |
| Compactor context | A preceding historical view resolves references | Leaf input, child texts, or publication evidence only |
| Compactor prompt | Shares the primary prompt and tools | A separate summary instruction sent through `ctx.generate.text` |
| New-turn readiness | Wait for complete historical summaries | Native mode preserves own messages when memory is unavailable |
| Retrieval | Zoom through the tree | Zoom, exact-phrase search, and paginated source reads |
| Retention | Append-only originals kept indefinitely | Explicit authorization, deletion, edits, and generation migration |

Source locations support these comparisons:

- [Engine defaults](../../src/core/engine.ts), line 30.
- [Summary input construction](../../src/core/engine.ts), lines 297-315 and 361-373.
- [Compactor prompt](../../src/compactor/summarizer.ts), lines 34 and 48.
- [Auxiliary model request](../../src/adapters/opencode/plugin.ts), lines 87-114.
- [Native admission policy](../design.md), lines 208-217.
- [Retrieval operations](../../src/core/retrieval.ts), lines 36-95.
- [Retention and generations](../design.md), lines 248-258.

### Merge priority changes the chosen pair

The proposal uses `(T - last) / span`, where `last` is the inclusive final message index.
The implementation uses `(T - exclusiveEnd) / span`.
These expressions differ by `1 / span`.
That difference changes comparisons between levels.

The proposal gives the frontier `0+4, 4+4, 8+1, 9+1` at `T=10`.
The proposal merges `8+1` and `9+1`.
The reviewed code merges `0+4` and `4+4`.
The independent fixture reproduced that difference with both durable parents available.

| Candidate parent | Proposal priority | Implementation priority |
| --- | --- | --- |
| `0+8` | `0.75` | `0.5` |
| `8+2` | `1` | `0` |

The resulting implementation frontier is `0+8, 8+1, 9+1`.
The proposal frontier is `0+4, 4+4, 8+2`.
Both frontiers cover the complete prefix.
The difference changes historical detail and the position where a prompt prefix changes.

[Merge selection](../../src/core/views.ts), lines 16-23, contains the implementation formula.
The [local paper](../paper/OptChat-Multi-Session-Paper.md), lines 135-141, explicitly identifies this policy as an implementation choice.
This is a documented design deviation.

### Compactor context and cache claims need new evidence

Leaf summaries receive one original's projected evidence.
Parent summaries receive their child texts.
Publication summaries receive a turn's evidence and outcome.
The compactor receives no preceding historical view for unresolved references across those inputs.

For example, a correction containing only a pronoun can require an earlier record to identify its target.
Original retention keeps that record available, but retention alone does not ensure that the model retrieves it.
The [input construction](../../src/core/engine.ts), lines 297-315 and 361-373, defines this limitation.

Each admitted turn creates a new snapshot identifier.
The [context renderer](../../src/core/context.ts), line 22, places that identifier before the historical nodes.
The [snapshot constructor](../../src/core/engine.ts), line 151, includes the turn identity.
Thus unchanged historical nodes can still follow an early changed byte in the memory block.

A synthetic probe compared two turns with equal views and equal original boundaries.
The 364-byte memory blocks shared 216 initial UTF-8 bytes.
Their first difference occurred before the historical node tags.
This measures serialization behavior, not provider cache hits or costs.

The auxiliary compactor request also uses a different prompt from the primary request.
The proposal's shared compactor cache prefix and reported cache rates therefore require separate implementation and measurement.

## Actionable archive scaling defect

The hot path repeatedly materializes all historical turns.
[Admission](../../src/core/engine.ts), line 148, scans the complete turn collection for an active turn.
[Publication scheduling](../../src/core/engine.ts), lines 204-211, scans that collection again.
[Node insertion](../../src/core/engine.ts), line 236, calls publication scheduling after each durable node.
[Store enumeration](../../src/storage/store.ts), lines 56-57, parses every returned JSON row.

The independent probe counts these row materializations while adding one synthetic record per completed turn.
Each size uses a fresh in-memory store and the deterministic summarizer.
The following results came from the committed probe's default sizes.

| Completed turns | Full turn scans | Turn rows parsed | Elapsed milliseconds |
| --- | --- | --- | --- |
| 128 | 766 | 50,048 | 217 |
| 256 | 1,534 | 198,656 | 711 |
| 512 | 3,070 | 791,040 | 3,230 |

Doubling the archive approximately quadrupled row parsing work.
The counted work demonstrates quadratic archive growth for this fixture.
Timings are one local sample and include SQLite, summarization, and scheduling work.
The retained aggregate measurements are in [scaling-results.json](scaling-results.json).
They do not measure production latency or provider speed.

The proposal explicitly warns against scanning historical structures to discover summary work.
The implementation already has a durable job queue, but its publication discovery still scans finished history repeatedly.
This overhead can eventually delay ingestion even when every model response is immediate.

Recommended correction:

1. Query active turns by session and generation instead of enumerating all turns.
2. Track unpublished terminal turns through indexed state or durable publication jobs.
3. Reconsider only turns whose summary dependencies changed.
4. Repeat the bounded row-count probe after the correction.

## Existing evaluation blind spots

The [core archive test](../../tests/core.test.ts), lines 59-74, generates 64 long repetitive records.
It checks an exact sentinel query, bounded request size, source retention, and tree expansion.
Its deterministic summarizer replaces large inputs with hash references.
This establishes structural retrieval under a supplied exact query.
It does not test whether a model discovers relevant evidence from a natural question.

The [baseline evaluator](../../scripts/evaluate.ts), lines 11-14, contains two short cases.
Its checks count required words and identifiers in the final answer.
Those checks can pass when an answer reverses a proposal or outcome.
The evaluator explicitly requests human review at lines 64-67.

The evaluator also exposes only an `id` argument for its source tool at line 41.
Its dispatch at line 55 always calls `source(snapshot, id)` without a page offset.
The [retriever](../../src/core/retrieval.ts), line 49, returns at most 8,192 bytes by default.
Consequently, that evaluator cannot inspect original evidence beyond the first page.
The native adapter exposes pagination correctly at [plugin line 535](../../src/adapters/opencode/plugin.ts).

Add `offset` and `maxBytes` to the evaluator's source schema and dispatch before evaluating long originals.
The same evaluator should expose zoom and search pagination for large result sets.

## Six high-value semantic cases

These cases require authorized model calls and explicit outcome review.
Each case should use new synthetic identifiers that the model cannot know beforehand.

| Case | Fixture | Required outcome | Relevant implementation boundary |
| --- | --- | --- | --- |
| Natural question over long history | More than ten context windows, varied distractors, and a buried fact without a supplied search term | Recover the fact and cite its original source | `tests/core.test.ts:59-74`, `src/core/retrieval.ts:63-95` |
| Latest correction | More than 20 repeated older decisions, followed by one authoritative correction | Report the correction and identify the superseded decision | `src/core/retrieval.ts:76-95` orders source hits by insertion, with a default limit of 20 |
| Cross-record references | An earlier named decision, later pronoun-only corrections, and separate tool results | Resolve the target and preserve the correction's status | `src/core/engine.ts:297-315` gives the compactor only local evidence inputs |
| Outcome fidelity | Separate proposals, failed attempts, partial results, and one verified result | Distinguish all four states and give correct source citations | `src/compactor/summarizer.ts:17-24` checks selected patterns, not complete semantics |
| Dense omissions | Many unrelated facts in one oversized original, followed by questions about minor facts | Discover omitted details through original retrieval | `src/core/engine.ts:238-256` repeatedly compresses bounded chunks |
| Original pagination | Long Unicode evidence with essential facts in the middle and final pages | Read all required pages and preserve exact values | `src/core/retrieval.ts:49-61`, `scripts/evaluate.ts:41,55` |

Measure answer correctness, original-source use, unsupported assertions, retrieval steps, summary calls, preparation delay, and repeated-run variance.
Keep compactor and answer models fixed across the isolated, merged-transcript, and memory conditions.
Review negative outcomes and corrections by meaning instead of word presence.

## Reproduce the independent probes

Run the focused proposal comparisons:

```sh
bun test tests/proposal-comparison.test.ts
```

Both tests passed, with seven assertions.
They preserve the current merge divergence and metadata ordering for review.

Run the bounded scaling probe:

```sh
bun run scripts/scaling-probe.ts
```

The default sizes are 128, 256, and 512 completed turns.
Optional sizes must be positive integers at or below 2,048.
The script reports aggregate counts and elapsed time only.

```sh
bun run scripts/scaling-probe.ts 128 256 512
```

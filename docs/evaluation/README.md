# Independent local evaluation

Evaluation dates: October 11 and 12, 2026, America/New_York.

## Result

Qwen3.8 Flash Next recovered the requested facts from the compressed archive in this small synthetic screen.
The registered answer-and-source contract passed six of eight questions.
Independent review found correct facts and supporting originals in both rejected answers.
Their failures concerned Markdown fences and one incorrect field name.
The recorded strict scores remain unchanged.

| Evidence configuration | Strict contracts passed | Exact fields under the requested schema | Median answer time | Answer model calls |
| --- | --- | --- | --- | --- |
| Recent originals, 2,048-byte budget | 3/8 | 4/13 | 0.74 seconds | 8 |
| All originals | 8/8 | 13/13 | 1.22 seconds | 8 |
| OptChat, 2,048-byte initial projection and retrieval tools | 6/8 | 9/13 | 16.95 seconds | 50 |

A shape-invalid answer receives zero field credit under the registered checker.
Thus the field count does not imply four incorrect recalled values.
The recent-only configuration lacked four requested details and also failed the terminal field-name contract.
All three configurations answered the single missing-fact question correctly.

The [sanitized scored record](screen-04.json) contains all 24 checks, token counts, timings, and protocol settings.
The harness commit is `f492f03`.
This evaluation used one trial and eight questions.
Broader history quality and repeated-run variance remain unmeasured.

## Storage, compression, and work

All 32 original payloads remained exact after preparation.
Their hashes matched the frozen fixture.
The archive contained 9,359 original UTF-8 bytes across eight completed turns.
The temporary shared projection contained 1,918 bytes across four nodes, with a maximum tree depth of five.
One selected node covered four publications.
The original-to-projection byte ratio was 4.88.

Preparation made 45 real summary requests.
The complete attempt made 111 model requests and finished in 238 seconds.
No provider request failed.
Six answers required the final answer-only request after exhausting navigation rounds.
Five invalid tool identifiers caused retrieval errors.
These errors remained visible to the model and the report.

| Evidence configuration | Reported input tokens for answering | Reported output tokens for answering |
| --- | --- | --- |
| Recent originals | 4,333 | 344 |
| All originals | 20,141 | 602 |
| OptChat and its tool continuations | 259,600 | 2,933 |

The small initial projection did not reduce total offered input across tool continuations.
These totals include repeatedly submitted conversation prefixes.
They do not measure cache hits, provider charges, or physical computation.
The largest reported request input contained 11,021 tokens.
Every captured request fit 16,384 tokens with its output and safety reserves.
This is an observed usage check, without Boros's native admission and accounting contracts.

Every original was short enough for a lossless leaf.
Real summary calls exercised parents and publications.
Leaf summary quality and originals larger than a context window remain untested by this screen.

## Structural verification

| Check | Result |
| --- | --- |
| Upstream documentation, TypeScript, and deterministic tests | 128 passed |
| Final checks with independent harness and proposal tests | 147 passed, 12,285 assertions |
| Initial upstream coverage | 89.39% functions, 89.69% lines |
| Private OpenCode 2.0.26 lifecycle integration | Passed, 132 fixture requests |
| Persistent settings integration | Passed, 95 fixture requests |
| Packed exports, types, and private host lifecycle | Passed |
| Native terminal interface | Passed, zero model calls |
| Pinned public Git installation | First attempt timed out, repeat passed |

The host tests used Bun 1.4.2 and isolated OpenCode 2.0.26 services.
They covered snapshots, tool pairs, restarts, forks, compaction, rewinds, permissions, worktrees, and deletion.
Their loopback provider supplied predetermined answers.
Real-model quality used the standalone engine with the new controller.
Live OpenCode integration with Qwen3.8 remains unmeasured.

The first Git-installed lifecycle attempt timed out at the oversized-request outcome check.
Its installed module hash matched the passing local and packed modules.
The repeat passed with the same pinned upstream revision.
The captures suggest a lifecycle timing issue, without proving its cause.
Both outcomes remain part of the assessment.

## Design and scaling findings

The [design review](design-review.md) identifies four material implementation boundaries:

1. Publication discovery repeatedly scans all historical turns.
2. Merge priority differs from Taelin's current proposal.
3. Compactions lack the preceding historical view for resolving cross-record references.
4. A changing snapshot identifier appears before historical nodes in the serialized memory block.

The [scaling probe](scaling-results.json) parsed 50,048 turn rows at 128 turns and 791,040 at 512 turns.
This fixture demonstrates quadratic row materialization.
Its 512-turn run took 3.23 seconds with immediate deterministic summaries.
Large archives need a scheduling correction before a sustained ingestion test.

The merge and compactor differences are documented departures from the current proposal.
The implementation follows its own multi-session paper.
This evaluation establishes no prompt-cache savings.
The existing upstream quality evaluator also omits source pagination.
The new harness exposes pagination and tests complete Unicode source reconstruction.

## Recorded attempts

| Attempt | Model and settings | Outcome |
| --- | --- | --- |
| [screen-01](screen-01.json) | Qwen3.5 2B, batches, three correction attempts | Invalid batch, eight originals retained, no answers |
| [screen-02](screen-02.json) | Qwen3.5 2B, serial jobs, five correction attempts | Oversized summary, four originals retained, no answers |
| [screen-03](screen-03.json) | Qwen3.8, earlier request profile, 100-call cap | Partial diagnostic, excluded from the scored comparison |
| [screen-04](screen-04.json) | Qwen3.8, verified MLX profile, 160-call cap, finalization | Complete scored comparison |

The first failed batch returned incorrect item IDs and trailing syntax.
The serial attempt effectively echoed its input despite five size corrections.
The engine rejected these outputs and preserved accepted originals.
The available 2B model did not complete this preparation workload.

The third attempt revealed a controller problem.
The last retrieval could supply decisive facts without a subsequent answer generation.
The corrected attempt permits six navigation generations followed by one answer-only request.
That final request exposes no tools and performs no further retrieval.
The earlier attempt retains its original scores.

## Protocol and provenance

Upstream implementation: `e4da6fba55d4212f7031300c3bd71f0d1e2dfa61`, from [ahlner/opencode-optchat](https://github.com/ahlner/opencode-optchat).
The comparison source is [Taelin's proposal](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).
Its history revision is `3c190e06f34aba0c69f49042c526093269604935`.
The API supplied raw-file revision `4c09901baa3685852bf252cdb70ace81d01d6be5`.
The reviewed text hash is `12f300f760af82bc07bc5201051d1267824ded09c9def8186e4f8144368038d8`.

The archive and questions were frozen before answering.
Summary generation never received the questions or expected answers.
Opaque identifiers did not identify answer availability.
The cases covered corrections, outcomes, scattered facts, paraphrases, late details, missing facts, and distractors.
Exact source receipts required complete original content and matching hashes.
Two output-shape failures received an additional offline review without changing the registered scores.

The final model identifier was `ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit`.
The loopback server advertised a 262,144-token context.
The harness used a 16,384-token configuration, temperature zero, and top-level `enable_thinking: false`.
The server model identifier is metadata, without weight attestation.
The earlier 2B weight hash was `aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223`.

Canonical view thresholds were 3,072 and 2,560 bytes.
Recent originals and temporary memory each had a 2,048-byte initial evidence budget.
The final attempt permitted 160 requests, five summary correction attempts, and 20 minutes.
Each memory answer permitted six navigation generations and one optional final generation.
Fresh model transcripts shared one fixed, registered memory snapshot.

All runtime captures remained under private, ignored `.optchat/` paths.
Public reports contain no prompts or model answers.

This work used synthetic records and isolated test stores.
Boros experiments and application data remained untouched.
This screen does not provide a matched Boros comparison.

## Reproduce

Run the local contract checks:

```sh
bun run check
```

Register a dry run with a fresh run identifier:

```sh
bun run evaluate:local --dry-run --url http://127.0.0.1:11234/v1/chat/completions --model ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit --provider mlx --run new-dry-run --summary-retries 5 --max-calls 160 --finalize
```

Run the scored protocol with another fresh identifier:

```sh
bun run evaluate:local --url http://127.0.0.1:11234/v1/chat/completions --model ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit --provider mlx --run new-scored-run --summary-retries 5 --max-calls 160 --finalize
```

The runner refuses an existing run directory.
It retains partial preparation and completed answers after a failure.
Use an already running, authorized loopback model service.

Run the structural scaling diagnostic:

```sh
bun run probe:scaling
```

# Independent local evaluation

Evaluation date: October 11, 2026, America/New_York.

## Sources and scope

The evaluation pins upstream commit `e4da6fba55d4212f7031300c3bd71f0d1e2dfa61`.
It evaluates the [OpenCode plugin](https://github.com/ahlner/opencode-optchat) and compares it with [Taelin's current proposal](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).
The proposal history revision is `3c190e06f34aba0c69f49042c526093269604935`.
The API supplied raw-file revision `4c09901baa3685852bf252cdb70ace81d01d6be5`.
The reviewed text hash is `12f300f760af82bc07bc5201051d1267824ded09c9def8186e4f8144368038d8`.

The new harness evaluates the standalone engine.
Separate upstream tests evaluate the pinned OpenCode host adapter.
The evaluation uses synthetic history and isolated services.
It does not import Boros history or resume paused Boros experiments.

## Registered semantic protocol

The archive contains eight completed turns and 32 original records.
Preparation finishes before any test question becomes available to the compactor.
Opaque identifiers do not identify question categories or answer availability.
Eight questions cover corrections, outcomes, scattered evidence, late details, paraphrases, missing facts, and distractors.

Each question runs with three evidence configurations:

1. Recent original records within a fixed byte limit.
2. All original records.
3. OptChat summaries with bounded search, zoom, and source tools.

The temporary memory projection budget is 2,048 bytes.
The recent-original evidence budget is also 2,048 bytes.
The view thresholds are 3,072 and 2,560 bytes.
The report records actual frontier sizes and tree depths.
These measurements determine whether the fixture exercises compression.
The harness requires a selected shared node covering multiple publications before it starts answering.

Answers use a fixed JSON schema.
Exact factual fields and complete supporting citations receive separate checks.
Missing facts require an explicit null value.
The checker rejects malformed output and unsupported evidence references.
These checks measure selected factual contracts, without a general semantic judge.

The local model is Qwen3.5 2B, with Q4_K_M weights.
The model file hash is `aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223`.
The server uses llama.cpp build 11146, a 16,384-token context, one slot, and disabled thinking.
Generation uses temperature zero.
One attempt permits at most 100 model calls and 20 minutes.
Each OptChat answer permits at most six generation steps.

The harness records partial progress before each model operation.
Original records and model outputs stay in private runtime files under `.optchat/`.
Public results contain identifiers, checks, hashes, counts, and timing.
Prompts and model answers do not enter the report.

## Initial verification

| Check | Result |
| --- | --- |
| Upstream documentation, TypeScript, and deterministic tests | 128 passed |
| Upstream coverage run | 128 passed |
| Private OpenCode 2.0.26 lifecycle integration | Passed, 132 fixture requests |
| Private terminal settings interface | Passed, zero model calls |
| Packed package and settings persistence | Passed |
| Pinned public Git installation lifecycle | First attempt timed out, second attempt passed |
| Independent synthetic semantic evaluation | Pending |

The lifecycle test covers snapshots, tool pairs, restarts, forks, compaction, rewinds, permissions, worktrees, and deletion.
Its loopback fixture produces predetermined answers.
Successful lifecycle checks do not establish retrieval quality.

## Interpretation limits

The available local model differs from Boros's documented primary model.
This evaluation does not provide a matched Boros comparison.
Eight synthetic questions cannot establish broad recall or production readiness.
Local inference does not measure provider prompt-cache hits or paid-model costs.
See [the design review](design-review.md) for proposal differences and reproducible diagnostics.

## Recorded preparation failure

The first local attempt stopped with `SUMMARY_BATCH_INVALID` after seven summary requests.
It sealed eight original records before stopping.
It answered no questions.
The [sanitized record](screen-01.json) retains the failure, token counts, and protocol identity.

The registered configuration used peer batches and three summary correction attempts.
The upstream summarizer normally permits five correction attempts.
This failure measures the registered configuration with the available 2B model.
It does not establish that every supported model fails.

The second attempt will use serial summary jobs and five correction attempts.
This configuration changes the standalone engine's batch options.
The original failed attempt remains part of the assessment.

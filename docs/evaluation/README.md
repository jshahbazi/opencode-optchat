# Independent local evaluation

Evaluation dates: October 11 and 12, 2026, America/New_York.

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

The second attempt used serial summary jobs and five correction attempts.
This configuration changes the standalone engine's batch options.
The original failed attempt remains part of the assessment.
The [second record](screen-02.json) stopped with `SUMMARY_SIZE` after seven summary requests.
It sealed four original records and answered no questions.
Five correction responses exceeded the 640-byte acceptance limit.

## Stronger local model follow-up

The user authorized additional models and identified the running Qwen3.8 Flash Next server.
The third attempt will use `ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit` for summaries and answers.
The loopback server advertises a 262,144-token model context.
The harness retains its smaller 16,384-token configuration.

The third attempt used peer batches and five summary correction attempts.
The archive, eight questions, three evidence configurations, projection budgets, and factual scoring rules remain fixed.
The original call and time limits applied.
The attempt must retain every original and complete preparation before answering.
It must select a node covering multiple publications.

The server model identifier comes from its model metadata response.
This evaluation does not attest the server's loaded weights.

The [third record](screen-03.json) retains all 32 originals with matching hashes.
It completed preparation and stopped at the 100-call limit after seven questions per evidence configuration.
Its MLX thinking flag used the earlier llama.cpp request grammar.
This attempt remains an operational diagnostic and is excluded from the final scored comparison.

The fourth attempt uses the verified MLX request profile with top-level `enable_thinking: false`.
The provider-specific request format has an offline fixture test.
It permits 160 calls and retains the 20-minute limit.
This bound permits eight questions with six memory-tool generation steps each, plus preparation and original-only controls.
The archive, questions, grading, and memory budgets remain fixed.

The partial run also exposed a driver limit.
The sixth tool request could retrieve decisive evidence without permitting a subsequent answer.
Two cases obtained all supporting facts only from those final tool results.
Three other cases already had the required originals before requesting another tool.
The captured responses contain valid tool-call pairs and complete returned originals.
The model also generated 13 invalid retrieval references among 50 tool requests.

The fourth attempt permits one final answer request after six tool rounds.
That request exposes no tools and permits no further retrieval.
This finalization measures answers from delivered evidence while preserving the navigation limit.
The maximum is seven model generations per memory answer.
The earlier six-generation results remain available without revised scores.

# Expanded-memory answer-quality comparison

## Purpose and prior result

The default-memory test retained every original and published every turn.
Its smallest available complete projection measured 35,577 bytes.
That projection exceeded the default 16,000-byte budget.
The test stopped before OptChat answering.
See [the preserved result](beam-long-history-results.md).

The user requested answer-quality evidence after that stopping point.
This continuation reuses the complete stored graph with a larger memory allowance.
It does not repeat preparation or retry any failed compactor job.
The original failure and held scores remain unchanged.

This is a development comparison on the same public BEAM conversation.
The corpus contains 796 messages and twenty native questions.
The local tokenizer measured 455,226 tokens across original messages.
Corpus selection preceded every candidate answer.
The normalized case and native reference supplement remain unchanged.

## Memory and request profile

OptChat uses a 65,536-byte memory allowance, with engine high/low limits of 65,536 and 49,152 bytes.
Summary acceptance remains 1,024 bytes.
The copied database retains all twenty-three failed parent jobs and their children.
The admitted reader must cover all 398 publications.
Originals, publications, nodes, failed jobs, and source receipts must match the preserved graph.
Any compactor model call is forbidden during reconstruction.

The actual answer context limit is 32,768 Qwen tokens.
Each request reserves 2,048 output tokens and 1,024 safety tokens.
The complete submitted prompt must therefore contain at most 29,696 input tokens.
This guard includes instructions, memory, tool definitions, assistant calls, tool results, and finalization messages.

Core assembly first uses a separate 131,072-byte conservative envelope.
That envelope permits constructing the larger projection without mixing token and byte units.
The authoritative actual-token guard runs before every generation request.
Retrieved source pages can shrink through the existing paging interface.
Complete originals remain unchanged in storage.

Answers use the existing search, source, and zoom tools.
Navigation permits twelve rounds and one final answer-only request.
The question, reference answer, rubric, and native author criteria remain separate inputs.
Only the question reaches answer generation.

## Tokenizer verification

The counter renders the loaded Qwen chat template through `@huggingface/jinja` version `0.5.10`.
It then submits the rendered request to the local `/tokenize` endpoint.
Rendering uses `enable_thinking: false`, `preserve_thinking: false`, and the generation prompt.
The server drops prior-turn reasoning by default.
See [Hugging Face's renderer documentation](https://github.com/huggingface/huggingface.js/tree/main/packages/jinja).

The template hash is `c3cf9e34abf4f9e36c2d72165aa9c132d3e2a725b6c2586aaa3a8af9d7a81041`.
Five synthetic request classes matched the server's reported prompt counts exactly.
Their counts were 29, 288, 339, 86, and 386 tokens.
The classes cover plain requests, tool definitions, tool-result continuations, finalization, and multiple Unicode tool results.
Each measured answer request must also match the provider's reported input count.

## Baselines and grading

The forty preserved Boros and recent-control answers remain unchanged.
Their question identities, generation messages, evidence receipts, and request hashes must pass validation before reuse.
All twenty OptChat answers must precede comparative grading.

All sixty candidates receive fresh blinded correctness grades.
The unchanged grader receives each native reference and author criteria.
The grading request omits delivered original evidence and does not request a grounding score.
Source delivery remains a separate receipt measurement.
The prior invalid grounding grade remains in the original report.

The accepted calibration has fourteen authored positive controls and twenty incorrect controls.
Their exact input hashes and candidate identities must match before reuse.
Six structured questions lack usable positive calibration candidates.
All twenty questions remain in answer scoring.
This calibration does not establish positive-control coverage for every category.

Grading requests reserve 384 output tokens and 1,024 safety tokens within the actual 32,768-token context.
Their maximum actual input is 31,360 tokens.
Invalid grades or token-integrity failures hold aggregate quality scores.
Low-confidence verdicts are reported separately.
The answerer and grader use the same local Qwen model.

## Resource and interpretation boundaries

The copied backend inherits 2,418 calls and its original start timestamp.
The new phase has one fixed deadline, 120 minutes after the private copy was created.
Resume must not extend that deadline.
The cumulative call ceiling remains 6,000.
Synthetic tokenizer checks and failed checks remain in cumulative accounting.

The old preparation cost remains separate from new answer and grading cost.
Boros uses its pinned ordinary-send profile and the recent control retains its original 16,000-byte suffix.
The expanded OptChat profile differs from its default memory configuration.
The results compare these explicit profiles rather than equal memory sizes.
They cannot establish representative quality across other histories or independent human grading.

All dataset text, candidates, references, and call captures remain in ignored private storage.
Published results contain hashes, counts, categories, flags, and timings.

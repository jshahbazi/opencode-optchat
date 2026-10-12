# BEAM answer-quality results with expanded memory

OptChat answered ten questions correctly, versus six for Boros and three for the recent control.
This result covers one 455,226-token BEAM history and all twenty native questions.
All sixty correctness grades were valid and had high confidence.
OptChat answered every question that Boros answered correctly, plus four additional questions.

| Measurement | OptChat | Boros ordinary send | Recent control |
| --- | ---: | ---: | ---: |
| Questions attempted | 20 | 20 | 20 |
| Nonempty answers | 16 | 20 | 20 |
| Correct answers | 10/20 | 6/20 | 3/20 |
| Accuracy | 50% | 30% | 15% |
| Answer failures | 4 | 0 | 0 |
| Invalid grades | 0 | 0 | 0 |
| Low-confidence grades | 0 | 0 | 0 |

The four OptChat failures receive zero credit in the twenty-question denominator.
The result compares correctness without a separate grounding-score requirement.
It does not establish general superiority across histories or independent human judgments.

See [complete metadata](beam-expanded-memory-result.json), [validation metadata](beam-expanded-memory-validation.json), and [the frozen protocol](expanded-memory-protocol.md).

## Preserved work and the size limit

The earlier test stopped before OptChat answering because its complete summary projection exceeded the default 16,000-byte memory allowance.
Its smallest available complete cover measured 35,577 bytes.
See [the preserved default-memory result](beam-long-history-results.md).

The 16,000-byte limit is a configurable OptChat policy.
It is separate from the model's token context window.
The continuation raises the memory allowance to 65,536 bytes and retains the 32,768-token answer window.
The user accepted the 32K profile.
No full-server-context comparison ran.

The continuation reuses all saved summaries and makes zero additional compactor calls.
It retains all 796 originals, all 398 publications, and all twenty-three optional failed parent jobs.
It preserves complete original text, roles, order, source hashes, and publication coverage.
The preserved default-memory database and backend state remain unchanged.

This continuation tests an expanded-memory evaluation profile.
It does not change the engine's production defaults or enable another Boros retrieval policy.
The publication scheduler fix remains implemented and tested.

## Comparison protocol

The history comes from conversation 1 in the pinned BEAM 500K directory.
Its complete original texts contain 1,862,256 UTF-8 bytes.
The local tokenizer measured 455,226 tokens across individual messages, excluding chat framing.
Corpus selection preceded every answer.
References and author criteria remained unavailable to preparation and answering.

The source is [BEAM](https://github.com/mohammadtavakoli78/BEAM/tree/b2da22eac88bb0874c64665f13457eb99835774a), under CC BY-SA 4.0.
All inference uses local `ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit`, with temperature zero and thinking disabled.
The answerer and blinded grader use the same model.
The grader receives no arm name or pipeline metadata.
Candidate citation style can still provide indirect clues about its origin.

The forty saved Boros and recent-control answers remain unchanged.
Their requests, candidate identities, source receipts, and hashes passed validation before reuse.
Boros uses its pinned ordinary-send context at revision `f28584bb621e0900563f57b768846d9f06f875fd`.
That profile uses lexical retrieval, 8,000 recent tokens, 12,000 evidence tokens, and sixteen evidence spans.
The recent control uses its original contiguous 16,000-byte suffix.

OptChat uses its complete summary projection and the unchanged search, source, and zoom tools.
It permits twelve tool rounds and one final answer request.
Each request reserves 2,048 output tokens and 1,024 safety tokens.
Complete submitted prompts must contain at most 29,696 actual Qwen tokens.
All twenty OptChat attempts preceded fresh grading of all sixty candidates.

The grader uses the complete authored references and native criteria.
It grades correctness without delivered original evidence.
Grounding scores remain unset.
Source delivery appears separately below.

Calibration accepted fourteen authored positive controls and rejected twenty incorrect controls.
Six structured questions lacked usable positive calibration candidates.
All twenty questions remain in the scoring denominator.
The calibration does not establish positive-control coverage for every category.

## Correctness by category

Each category contains two questions.

| Category | OptChat | Boros | Recent control |
| --- | ---: | ---: | ---: |
| Abstention | 1/2 | 1/2 | 2/2 |
| Contradiction resolution | 1/2 | 0/2 | 0/2 |
| Event ordering | 0/2 | 0/2 | 0/2 |
| Information extraction | 0/2 | 0/2 | 0/2 |
| Instruction following | 2/2 | 1/2 | 1/2 |
| Knowledge update | 2/2 | 1/2 | 0/2 |
| Multi-session reasoning | 1/2 | 0/2 | 0/2 |
| Preference following | 2/2 | 2/2 | 0/2 |
| Summarization | 0/2 | 0/2 | 0/2 |
| Temporal reasoning | 1/2 | 1/2 | 0/2 |

Sixteen pairs contain completed OptChat and Boros answers.
Both systems answered six correctly.
OptChat alone answered four correctly.
Boros alone answered none correctly.
Both systems answered six incorrectly.

The paired metadata excludes four OptChat failures.
Boros also answered those four questions incorrectly.
The full twenty-question scores retain those failures as zero-credit cells.

## Failures and source delivery

All four OptChat answer failures have code `TOOL_CONTEXT_BUDGET`.
Repeated retrieval exhausted the prompt allowance before final answering.
The affected categories are event ordering, multi-session reasoning, and both summarization questions.
No summary projection, tokenizer mismatch, provider request, or grading failure occurred during answering and grading.

The benchmark has eighty-three resolvable question/source pairs.
OptChat delivered thirty-four referenced sources, including twelve complete originals.
Boros delivered seventeen, including sixteen complete originals.
The recent control delivered none.
These counts measure source delivery rather than factual grounding or correctness.
Unresolved author references remain outside this receipt denominator.

## Cost and validation

| Answering measurement | OptChat | Boros | Recent control |
| --- | ---: | ---: | ---: |
| Model calls | 141 | 20 | 20 |
| Input tokens | 2,592,783 | 267,408 | 68,354 |
| Output tokens | 20,363 | 7,749 | 2,902 |
| Total answer-attempt time | 13.35 minutes | 7.19 minutes | 0.96 minutes |
| Median answer-attempt time | 39.331 seconds | 20.131 seconds | 2.289 seconds |

Times include all twenty attempts, including OptChat failures.
Medians use the mean of the two middle values.
The raw result's legacy `medianLatencyMs` field uses the upper middle value.
This report and the validation metadata recompute conventional medians from all twenty attempt times.
They exclude original preparation, dataset normalization, and cached native context construction.
These are single local measurements without repeated controlled timing trials.

Original OptChat preparation consumed 2,304 model calls and 119.2 minutes of summed request time.
This phase inherited 2,418 counted calls.
It added nine synthetic tokenizer-development calls, 141 OptChat answering calls, and sixty fresh correctness-grading calls.
The final cumulative count is 2,628.
Inherited calls are counted once.
The original start time and the continuation's fixed deadline remained unchanged.

All 141 answer prompt counts matched the provider exactly.
Their maximum was 29,429 tokens, within the 29,696-token input limit.
All sixty grading prompt counts also matched exactly.
Their maximum was 2,973 tokens, within the 31,360-token grading input limit.
Dataset text, answers, references, and request captures remain in ignored private storage.

The complete code check passed 237 tests, skipped one optional native integration fixture, and failed none.
TypeScript and documentation checks passed.
Compiled distribution and dependency-license checks passed.
An independent audit checked frozen identities, exact token receipts, scoring denominators, resource accounting, and preservation of the original run.

## Interpretation

OptChat leads this test by four correct answers and twenty percentage points.
It requires more answering calls and retains the earlier summary-preparation cost.
Both systems still miss half or more of the native questions.
This single history and shared model grader limit wider conclusions.
The next quality test should preserve this result and evaluate additional preselected histories.

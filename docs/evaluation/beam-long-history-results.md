# OptChat publication scheduling and BEAM evaluation

This report records the scheduler fix and a local long-history comparison.
Normal publication discovery no longer scans historical turns.
The much larger Qwen run retained every original and published every turn.
OptChat then failed its default 16,000-byte memory projection limit.
Boros completed all twenty answer requests under its pinned ordinary-send profile.
Answer accuracy cannot be ranked from this run.

| Measurement | OptChat | Boros ordinary send | Recent control |
| --- | ---: | ---: | ---: |
| Complete history available in the test store | 796 messages | 796 messages | 796 messages |
| Answer requests completed | Unattempted | 20/20 | 20/20 |
| Answer generation failures | Unattempted | 0 | 0 |
| Invalid candidate grades | Unattempted | 0 | 1 |
| Accepted aggregate accuracy | Unscored | Held | Held |

OptChat did worse on completion under the tested default memory budget.
Its summary acceptance tolerance was more permissive than the default.
This result does not establish an answer-quality ranking or a general winner across histories.

## Publication scheduling

Schema 3 stores publication candidates and unresolved dependencies by exact tree coordinates.
Terminal turns register one candidate.
Node commits wake matching dependencies within the existing transaction.
Migration and administrative repair reconstruct unresolved candidates.

The fixed probe performed zero full-turn scans at every measured size.
Matched dependencies equalled the number of terminal turns.

| Terminal turns | Previous time | Fixed time | Previous parsed turn rows | Fixed parsed turn rows |
| --- | ---: | ---: | ---: | ---: |
| 128 | 217 ms | 174 ms | 50,048 | 0 |
| 256 | 711 ms | 323 ms | 198,656 | 0 |
| 512 | 3,230 ms | 600 ms | 791,040 | 0 |
| 16,384 | Unmeasured | 22,893 ms | Unmeasured | 0 |

These timings are individual measurements, without controlled repeated timing trials.
The query counts establish the removal of historical turn scanning during normal publication discovery.
Pending-job counting and backlogged frontier traversal retain separate costs.
See [fixed probe metadata](publication-scaling-fixed.json) and [previous probe metadata](scaling-results.json).

## History and comparison

The test uses conversation 1 from the pinned BEAM 500K directory.
It contains 796 messages, 398 message pairs, and 1,862,256 UTF-8 text bytes.
The local tokenizer measured 455,226 tokens across individual messages, excluding request framing.
The history exceeds the server's reported 262,144-token context window.
All 20 native questions are included across ten categories.

Dataset selection preceded candidate answers.
Original order, roles, complete text, and source hashes are preserved.
References and rubrics are withheld from preparation and answering.
The native author-reference supplement is available only during scoring.
Dataset text, candidate answers, and call captures remain in ignored private storage.

The source is [BEAM](https://github.com/mohammadtavakoli78/BEAM), revision `b2da22eac88bb0874c64665f13457eb99835774a`, under CC BY-SA 4.0.
See [corpus measurements](beam-corpus-measurements.json) and [frozen protocol](beam-protocol.md) for identities and settings.

All inference uses local `ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit` with thinking disabled and temperature zero.
Calls are serial.
Answer requests permit 2,048 output tokens.
The model also serves as the blinded grader, which introduces shared model bias.

OptChat uses a 16,000-byte projection and its existing search, source, and zoom tools.
It permits twelve navigation rounds and one final answer request.
Its 32,768-token request bound uses the conservative UTF-8 upper bound.
The questions run in a new reader session over the archive's shared publications.

Boros uses native ordinary-send context assembly from revision `f28584bb621e0900563f57b768846d9f06f875fd`.
Its policy permits 8,000 recent tokens, 12,000 evidence tokens, and sixteen evidence spans.
Semantic retrieval is disabled by that policy.

The isolated adapter verifies source receipts and submits the exact native messages through the common evaluation generation profile.
Native streaming and seed fields are omitted from that profile.
This tests context selection followed by local answering.
The questions use the archive conversation's ordinary-send profile.

The recent control uses a contiguous 16,000-byte suffix of complete originals.
All arms receive the same history and questions.
Their context budgets and retrieval mechanisms differ.

## Preparation failures and continuation

The 640-byte summary configuration failed after 16 originals.
An explicit unchanged retry reproduced the output-size failure.
A fixed compactor system instruction reached 32 originals before another size failure.
The final configuration uses the supported 1,024-byte acceptance tolerance.

Its strict drain aborted after 96 originals, 48 published turns, and 282 preparation calls.
The rejected job was an optional shared parent covering publication leaves `[40,48)`.
Its five final outputs measured 1,292 bytes against the 1,024-byte bound.
The input measured 1,482 bytes and satisfied the separate input bound.

An isolated audit verified complete source and publication prefixes.
The shared projection measured 12,941 bytes within the 16,000-byte limit.
Reader and archive admission succeeded.
The strict evaluator's abort does not establish application memory unavailability at that prefix.
Native host behavior under this failure remains unmeasured.

A separate diagnostic continuation retains recognized optional parent failures and their durable child summaries.
It preserves compactor settings, originals, failed-job rows, and cumulative resource accounting.
Required failures remain terminal.
Scoring requires all 796 originals, all 398 publications, and a complete bounded reader projection.
This continuation is an evaluation policy, with separate implementation and tests.

The continuation retained all 796 originals and published all 398 turns.
Every original matched its complete payload, hash, role, order, and event key.
Every publication had the exact two-record source cover and contiguous sequence.
The database contained 2,293 completed jobs, 23 failed jobs, and no pending or running jobs.
All failures were `SUMMARY_SIZE`: eleven shared parents and twelve session parents.
No publication candidates or unresolved dependencies remained.

Reader admission succeeded without queuing work.
Projection failed with `MEMORY_NOT_READY` before context assembly.
A dynamic-programming audit considered every eligible durable shared node.
The smallest complete cover contained 46 nodes and measured 35,577 rendered bytes.
That cover cannot fit the 16,000-byte budget.
The audit preserved all failed jobs and used no additional model calls.

The tested memory high/low limits match the engine defaults and plugin memory default.
The 1,024-byte acceptance tolerance exceeds the default 640-byte tolerance.
The fixed compactor system instruction remains an evaluation variant.
Native host behavior under the final failure remains unmeasured.

## Baseline scoring

Both baselines completed twenty answers from the full 796-message history.
All candidate answers preceded scoring.
Calibration accepted fourteen authored positive controls and rejected twenty incorrect controls.
No calibration output was invalid or low confidence.
Six questions lacked usable positive calibration candidates.
Their structured native criteria remained available during candidate grading.

One recent-control grade in `preference_following` was invalid.
Its recorded error was `MISSING_GROUNDING_SCORE`.
The grader omitted the required non-null grounding verdict.
All twenty Boros grades were valid.

The frozen protocol holds aggregate accuracy when any candidate grade is invalid.
Both baseline aggregate scores therefore remain unset.
Unattempted OptChat questions receive no wrong-answer scores.

Boros delivered seventeen of eighty-three resolvable question/source pairs.
Sixteen delivered pairs contained complete originals.
The recent control delivered no resolvable question/source pairs.
These receipts measure source delivery rather than answer correctness.

## Cost and validation

| Phase | Model calls | Input tokens | Output tokens | Summed request time |
| --- | ---: | ---: | ---: | ---: |
| OptChat preparation | 2,304 | 1,763,801 | 355,983 | 119.2 minutes |
| Boros answers | 20 | 267,408 | 7,749 | 7.2 minutes |
| Recent answers | 20 | 68,354 | 2,902 | 1.0 minutes |
| Calibration and candidate grading | 74 | 346,774 | 1,168 | 3.4 minutes |

The cumulative lineage consumed 2,418 calls and about 149.3 minutes of wall time through baseline scoring.
Preparation included 431 correction retries and 285 batch requests.
Inherited calls from the preserved prefix are counted once.
The earlier 640-byte configurations consumed another 51 and 110 calls outside this lineage.
All measured compaction, answering, and grading ran locally.

Median answer latency was 20.952 seconds for Boros and 2.423 seconds for the recent control.
Those timings exclude dataset normalization and cached native context construction.
OptChat has no measured answer latency because its projection gate failed first.

The complete check passed 210 tests, skipped one opt-in native integration fixture, and failed none.
TypeScript and documentation checks passed.
Scheduler distribution, isolated native adapter, packaged exports, and private host fixture checks also passed.
See [verification metadata](beam-long-history-validation.json) for commands and measurement boundaries.

The capacity audit passed seven additional tests and reproduced identical metadata across repeated executions.
Its source reads SQLite through a read-only transaction.
Run it with `bun scripts/projection-capacity-audit.ts --case CASE --run RUN` against preserved private inputs.
See [full result metadata](beam-long-history-result.json) for the capacity proof, scoring hold, and cumulative accounting.

## Interpretation limits

This is one public synthetic conversation with twenty authored questions.
It does not establish representative quality across private histories or other BEAM conversations.
Calibration checks authored positive references and deliberately incorrect controls.
It cannot remove shared answerer and grader bias.

Correctness and support from delivered originals are separate measurements.
Source coverage counts resolvable message identifiers.
A partial source snippet does not establish that the required fact was delivered.
Summary text alone does not count as delivered original evidence.

Existing paused Boros experiments remain outside this evaluation.
The Boros checkout and runtime are unchanged.

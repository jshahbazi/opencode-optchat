# Sol paired memory results

Evaluation date: October 12, 2026.

The paired benchmark completed all forty answer cells and eighty blind grades.
Sol gave OptChat eight positive verdicts and Boros five positive verdicts across twenty questions each.
These counts remain provisional because Sol rejected one authored positive calibration control.
The registered quality gate failed.
Accepted aggregate scores remain null in the result artifact.

| Answer model and preparation | Provisional positive verdicts | Completed answers | Failed answers |
| --- | --- | --- | --- |
| Sol with OptChat | 8/20 | 19/20 | 1/20 |
| Sol with saved Boros contexts | 5/20 | 20/20 | 0/20 |
| Saved Qwen with OptChat | 2/20 | 18/20 | 2/20 |
| Saved Qwen with Boros | 6/20 | 20/20 | 0/20 |

Sol graded all four variants using the same unchanged blind instruction and complete authored criteria.
The saved Qwen candidates came from the previous repaired-controller and Boros comparison.
Their earlier Qwen-graded scores were 10/20 and 6/20.
That judge change prevents a direct comparison between those historical scores and the new Sol scores.

Under the same Sol judge, OptChat gained seven positive verdicts and lost one against its saved Qwen answers.
Boros gained one positive verdict and lost two.
Four new pairs received positive verdicts for both systems.
Four favored OptChat, one favored Boros, and eleven received negative verdicts for both systems.
All these comparisons remain provisional.

## Limits and failures

Both answer arms used `gpt-6.1-sol` with medium reasoning effort.
The blind grader used the same model with low reasoning effort.
Each request reserved 8,192 output tokens and 1,024 safety tokens within a 32,768-token context.
The permitted input was 23,552 tokens.
Output usage includes reasoning tokens.

The largest confirmed answer input contained 23,538 tokens.
The largest confirmed output contained 2,117 tokens.
No captured response failed because of the output limit.
One OptChat request failed after approximately 635 seconds without a captured provider response or usage receipt.
That question received an empty candidate and zero credit.
The [audited interruption amendment](sol-interruption-amendment.md) preserved its unknown usage and continued the remaining cells without retries.

The eight positive OptChat verdicts therefore include the full twenty-question denominator.
The failed answer remains visible as a failure.
No completed answer or failed request was repeated.

## Calibration

| Control | Required outcome | Observed outcome |
| --- | --- | --- |
| Authored positive candidates | 14 accepted | 13 accepted |
| Fabricated negative candidates | 20 rejected | 20 rejected |
| Invalid verdicts | 0 | 0 |
| Low-confidence verdicts | 0 | 0 |

Six questions lacked usable authored positive controls.
All eighty benchmark grades had valid, high-confidence verdicts.
High confidence does not resolve the calibration failure.
The original [protocol](sol-paired-protocol.md) requires every authored positive control to pass.
The result retains that failed requirement.

Independent review identified an incomplete authored positive for temporal reasoning, question label `fb212bbc70c855b1`.
The reference gives an interval but omits the dated operands required by a native criterion.
That omission can explain the calibration rejection.
It does not by itself prove an incorrect judge verdict.

The corresponding new OptChat answer supplied the interval and both required operands, with complete delivery of its gold source.
Sol still rejected it while accepting the three comparator candidates with those required facts.
Independent review classified this as a likely false rejection or unexplained grading inconsistency.
A correction could add one OptChat point, but the report does not override any verdict.
Both issues require attention before a new qualified grading phase.

## Retrieval evidence

The questions identify eighty-three original source references in total.
These counts measure delivered originals, independently of answer correctness.
They do not count support available only in summaries.

| New answer arm | Gold sources in final request | Complete gold sources in final request | Answer requests | Confirmed input tokens | Confirmed output tokens |
| --- | --- | --- | --- | --- | --- |
| OptChat | 27/83 | 23/83 | 96 | 1,437,762 | 20,027 |
| Boros | 17/83 | 16/83 | 20 | 237,989 | 7,247 |

OptChat saw forty-two gold sources across confirmed requests, including twenty-six complete sources.
Its controller retired some tool groups before the final request.
The failed question contributes no final delivered evidence.
OptChat used 4.8 times as many answer requests and approximately 6.0 times the confirmed input tokens.
Repeated input totals do not establish physical computation or actual billing.

Retrieval remains incomplete despite the larger output allowance.
The observed evidence supports further retrieval work.
It does not establish that missing originals caused every negative verdict.

## Scope and accounting

The run reused the same twenty development questions from BEAM's nominal 500K history.
The history contained 796 messages and 398 published pairs.
OptChat reused its Qwen-prepared summaries, graph, and twenty-three optional preparation failures.
The run performed no new compaction.
Boros reused its exact accepted source contexts from revision `f28584bb621e0900563f57b768846d9f06f875fd`.
Later Boros changes are outside this comparison.

This run compares Sol answerers and the OptChat retrieval controller using saved preparations.
The model, output allowance, and request tokenizer changed from the saved Qwen run.
It does not isolate model quality or qualify a complete Sol-prepared memory pipeline.
The questions were reused during development, and the same model answered and graded them.
The result does not establish held-out accuracy or native remote-processing support.

The run made 232 generation attempts and 642 token-count requests.
Generation included two synthetic preflight requests, 116 answer attempts, thirty-four calibration requests, and eighty benchmark grades.
One answer attempt has unknown provider usage.
The conservative generation cost estimate was 4.9009 dollars, including its permanent 0.1257525-dollar unknown-usage ceiling charge.
That charge does not fabricate observed tokens or an invoice cost.
The earlier stopped Qwen phase remained stopped at 196 calls.

The [sanitized result](sol-paired-result.json) preserves the failed quality gate and provisional verdicts.
The [validation record](sol-paired-validation.json) binds the result, receipts, frozen inputs, and independent audits.
Private candidates, references, source excerpts, credentials, headers, and hidden reasoning are excluded from public artifacts.

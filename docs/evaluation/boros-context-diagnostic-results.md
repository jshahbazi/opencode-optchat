# Why OptChat beat Boros in the long-history comparison

The original 20-question comparison remains OptChat 10/20, Boros 6/20, and recent history 3/20. The controlled follow-up separates several failure mechanisms. It does not establish a single cause for OptChat's four additional correct answers.

## Completed diagnostic

Six development questions were selected from the completed comparison: the four OptChat-only successes, one shared failure, and one shared success. Each received six conditions. Two native repeats measured instability. Other conditions aligned citation instructions, added an evidence-review reminder, removed eight recent quoted messages, or supplied only the complete author-resolved source records.

The source-selected condition also aligned citation instructions and removed other context. It tests aided answerability with a cleaner source pack. It is not an independent oracle for the necessary fact spans.

All 36 answers preceded all 42 grades, which include six fresh grades of saved original Boros answers. Every grade was valid and high confidence. All six saved-answer grades matched the original grades. There were no generation failures. The structural token check and all answer and grade receipts passed independent verification.

| Condition | Correct out of six |
| --- | ---: |
| Native repeat 1 | 2 |
| Native repeat 2 | 1 |
| Citation aligned | 1 |
| Evidence-review reminder | 2 |
| Recent quotes removed | 2 |
| Author-selected complete sources | 4 |
| Saved original answers, freshly graded | 1 |

These totals describe selected development cases. They are not replacement scores for the 20-question benchmark.

## What the interventions revealed

The knowledge-update case failed both native repeats. Its updated fact was already present in the supplied historical records. The review reminder and removal of recent quotes each produced a correct answer without adding historical evidence. This implicates how Qwen uses the supplied context in this case.

The multi-session case failed every condition except the author-selected source pack. Boros originally included two of seven referenced records completely. OptChat delivered five, with three complete. The native candidate cap excluded a preceding human turn at rank 16, and four other referenced records lacked a primary candidate or eligible exchange partner. Retrieval and source-pack completeness are concrete weaknesses here.

The instruction-following case changed verdict between identical native requests. Four of the six native pairs produced identical answer bytes. Two differed, with only the instruction case changing correctness. Temperature zero did not guarantee stable results in this run.

Citation alignment recovered none of the four targeted misses. Both contradiction questions remained wrong under every first-wave condition, including the author-selected source pack. The preference-following success stayed correct in every condition.

## Confirmation

Eight further answers tested the knowledge-update effects and added OptChat's saved overview to the contradiction request. All eight answers preceded their eight grades. The confirmation retained the original diagnostic start, deadline, and counter. It used the same local Qwen model and exact request bytes for the three knowledge conditions.

| Case and condition | New correct repeats | Including first-wave repeats |
| --- | ---: | ---: |
| Knowledge update, native | 0/2 | 0/4 |
| Knowledge update, review reminder | 2/2 | 3/3 |
| Knowledge update, recent quotes removed | 2/2 | 3/3 |
| Contradiction, saved overview added | 0/2 | 0/2 |

All repeat pairs in the confirmation produced identical answer bytes within their condition. All eight grades were valid and high confidence. Predicted and provider input counts matched: 14,709 native, 14,730 with the reminder, 11,288 without recent quotes, and 25,585 with the overview. There were no answer or grading failures.

The knowledge effect replicated without adding evidence. This supports a context-use failure for that question. Removing recent history also changes input length and placement, so these results do not identify one attention mechanism. They do establish that citation changes and missing historical source records were unnecessary to recover this answer.

Adding all 46 saved shared summary nodes did not recover the contradiction answer. The addition used the exact 35,577-byte projection, excluded the original tool-navigation envelope, and preserved all native message bytes. This combined control cannot establish that OptChat's navigation caused its success. Its initial overview alone was insufficient under the tested Boros request.

## Evidence and limits

The first wave used 79 calls: one structural check, 36 answers, and 42 grades. The original 2,628-call run and its stored history were preserved. All actual rendered requests fit the accepted 32K envelope, and predicted input token counts matched provider receipts. The independent audit verified 68 source bindings and private artifact permissions.

Confirmation added 16 calls. The diagnostic phase finished at 95 calls, within its original 120-call ceiling and fixed 30-minute deadline. The combined experiment count is 2,723. The completed first-wave counter remains 79 and the original run remains 2,628. No new compaction calls were made.

Independent confirmation validation verified all 93 source bindings and the 16 fresh request and token receipts. It also verified the inherited 79-call metric prefix and all candidate and grading bindings. Calls 80–87 generated the answers. Calls 88–95 graded them. All 16 calls succeeded, and private artifact permissions passed.

The local Qwen model answered and graded. Authored criteria and accepted calibration constrain the grading, but shared model bias remains possible. The questions were selected after inspecting benchmark outcomes. Source presence does not prove factual sufficiency, and the interventions do not isolate every presentation effect.

No Boros application defaults or runtime code changed. The strongest implementation target from this phase is retrieval coverage and exchange expansion. The knowledge case warrants a controlled presentation comparison on additional questions before promoting the reminder or removing recent history by default.

See the [initial source-coverage diagnosis](optchat-boros-quality-diagnosis.md), [first-wave protocol](boros-context-diagnostic-protocol.md), and [confirmation protocol](boros-diagnostic-confirmation-protocol.md).

The [first-wave metadata](boros-context-diagnostic-result.json), [independent validation](boros-context-diagnostic-validation.json), [confirmation metadata](boros-diagnostic-confirmation-result.json), and [confirmation validation](boros-diagnostic-confirmation-validation.json) preserve the measured outcomes.

The first wave measured source commit `ae5985a2022d3b313aac028835dbb24a9e12d462`. Confirmation measured `6716974`. The full first-wave checks passed 252 tests with one skipped test. The three additional confirmation tests, TypeScript checks, and documentation checks passed before dispatch. Requests, answers, references, and detailed receipts remain private.

# Diagnosis of the OptChat quality advantage

OptChat's four additional correct answers have more than one apparent cause.
Three wins occurred with both authored source records completely present in Boros's submitted context.
The fourth win shows a measurable retrieval difference.
The records support answer-handling and retrieval hypotheses, but they do not isolate their causal effects.

This diagnosis inspects the completed [32K comparison](beam-expanded-memory-results.md).
It makes no model calls and changes no runtime configuration.
The model-call counter remains 2,628.
The comparison uses one BEAM history, twenty questions, and one local Qwen answerer and grader.

## Measured differences

The question labels below use SHA-256 prefixes of opaque question identifiers.
No prompts, answers, references, or original conversation text appear in this report.

| Question label | Category | Boros complete referenced sources | OptChat referenced sources | OptChat answer calls |
| --- | --- | ---: | --- | ---: |
| `cfe976a3493c9ea5` | Contradiction resolution | 2/2 | 2/2, both complete | 13 |
| `9cd27fcb7e3d60af` | Instruction following | 2/2 | 0/2 delivered originals | 1 |
| `cf558e1152a1b36e` | Knowledge update | 2/2 | 2/2, both complete | 8 |
| `c396433f9b37eb3e` | Multi-session reasoning | 2/7 | 5/7, three complete | 13 |

All four received valid, high-confidence correctness grades.
The grades provide no rationale because the frozen grader returns only its verdict fields.
Complete reference-source delivery does not prove that every required fact appears in those sources.
Unresolved author references also remain outside these denominators.

### Contradiction resolution

Boros supplied complete originals at source sequences 112 and 160.
Their complete text appears in its actual submitted messages, with matching source receipts.
Both sources occupy early positions in the historical evidence block.
OptChat also retrieved both complete originals.

The native criteria contain conflict and clarification requirements.
A sanitized lexical check finds no conflict, uncertainty, or question markers in Boros's answer.
OptChat's answer contains conflict and uncertainty markers and a question.
Its answer has 1,714 characters, versus Boros's 247.

These observations support different handling of conflicting evidence.
They cannot prove that longer answers, extra tool rounds, or summary orientation caused the successful verdict.
The lexical markers also cannot replace a complete semantic review of every authored criterion.

### Knowledge update

Boros supplied complete originals at source sequences 182 and 234.
The authored one-word updated value occurs exactly in source 234 and in Boros's submitted context.
Boros's answer omits that value.
OptChat retrieved the same complete originals and included the authored value in its answer.

The literal updated value was available but absent from Boros's final answer.
Together with the failed correctness verdict, this supports an answer-handling hypothesis.
The audit does not independently rule out a semantic equivalent.
It does not identify whether context ordering, competing statements, concise answering, or model attention produced the failure.

### Instruction following

Boros supplied complete originals at source sequences 76 and 78.
OptChat used one answer call, with zero search, source, or zoom calls.
The recent-history control also answered this question correctly.

This win cannot result from OptChat's iterative tool navigation on this question.
Summary content, context presentation, or ordinary question answering remain possible explanations.
The measured grade distinguishes the outputs, but this audit does not establish the exact failed semantic criterion independently.

This question uses structured native criteria and lacks an authored positive calibration candidate.
The accepted calibration therefore provides no positive-control coverage for this specific question.

### Multi-session reasoning

Boros completely supplied sources 172 and 173.
It omitted referenced sources 20, 174, 175, 336, and 337.
Those five sources are absent from the recorded sixteen-primary selection.
The trace does not record their ranking beyond that candidate window.
Source 21 appears as a primary, but expansion records its disposition as `candidate_limit`.
That limit prevents its adjacent source 20 from receiving the normal exchange expansion.

OptChat delivered partial pages from sources 172 and 173.
It completely delivered sources 175, 336, and 337.
Sources 20 and 174 remain absent from its original-source receipts.
Its complete summary projection may contain additional information from those originals.

This question supports a retrieval-reach hypothesis.
OptChat's iterative navigation obtained three complete referenced originals that Boros did not select.
The receipts do not establish that those three originals contain every decisive required fact.
The audit therefore does not assign the entire correctness difference to retrieval.

## Implemented mechanisms

Boros's evaluated ordinary-send profile uses lexical retrieval with its semantic index disabled.
Its query formulation selects at most eight terms.
Automatic retrieval combines those terms with `OR` and ranks matches by SQLite `bm25`, then descending event sequence.
It inspects sixteen primary candidates.

Exchange expansion adds adjacent messages within a sixteen-candidate limit.
The observed expansion reports five dropped primaries for the multi-session question.
Four missing references have neither a primary candidate nor an eligible selected exchange partner.
The fifth, source 20, has selected adjacent source 21, but its expansion stops at the candidate limit.
The trace therefore shows candidate-selection and expansion limits before final context assembly.

These limits can omit relevant records when one question needs several topics or exchanges.
The trace cannot distinguish absent query terms from ranking below the candidate limit.
A controlled query or ranking test would be necessary to identify that distinction.

OptChat starts with the complete 35,577-byte summary projection under the expanded 65,536-byte memory allowance.
Its requests retain the 32,768-token context limit.
Search, source paging, and zoom permit query reformulation across twelve navigation rounds and one finalization call.
Three additional wins used eight or thirteen generation calls.

Those additional calls combine information gathering with additional model processing.
This comparison does not isolate the summary tree, search mechanism, or extra processing independently.

## Context and instruction checks

All twenty requests share the same base answering instruction.
Its SHA-256 is `4d61e72d2e619c49fba8a767a2cf6aa27078ca570e83ae2b4676141e946a17bc`.
Both arms retain its requirements about dates, corrections, preferences, uncertainty, and missing facts.
Different base wording therefore does not explain the result.

Boros adds its native source-attribution instructions.
It supplies eight recent originals as separate quoted `user` messages, then one historical evidence `user` message.
It places the exact current question last.
Original roles remain source metadata rather than active conversational roles.
Every frozen Boros request follows this quoted-history convention.

OptChat adds tool-navigation guidance and places the summary projection in the system message.
It supplies the question separately and appends assistant tool calls and tool results during navigation.
These differences affect the model's input presentation and processing opportunities.
No matched presentation test establishes their causal effect.

The base instruction requests original source identifiers for citations.
Boros's native extension requests assigned citation labels and prohibits event identifiers.
This implemented instruction conflict requires separate attention.
The grader explicitly ignores harmless citation notation differences, so citation syntax alone does not explain the score gap.

The four winning Boros requests contain 14,709–15,580 input tokens.
Their audit records show zero evidence exclusions from token, byte, or envelope limits.
Increasing the final context window alone would not restore the missing multi-session candidates in these existing requests.

## Controls and uncertainty

Two other completed questions fail in both arms despite complete Boros delivery of their authored source pairs.
Their categories are contradiction resolution and temporal reasoning.
These controls reinforce the distinction between source delivery and successful answering.

The instruction-following recent-control success also limits a universal retrieval explanation.
The same model grades its own family of answers, and candidate styles can expose indirect arm clues.
High confidence and valid JSON do not establish independent grading accuracy.
Four paired discordant outcomes on one history provide limited evidence for a general quality advantage.

OptChat also has four prompt-budget failures, which remain zero-credit outcomes.
It used 141 answering calls, versus Boros's twenty.
The result compares complete pipelines with different computation and context presentation.

## Proposed diagnostic tests

The following proposed development diagnostics have not run.
They must preserve this result and label reused questions as development diagnostics.

1. Present the two complete knowledge-update originals in a minimal, matched context, as a control for basic answerability.
2. Test the contradiction question with fixed facts, and vary source order, framing, or recent history one factor at a time.
3. Supply the same verified multi-session evidence pack to both answerers before testing retrieval changes.
4. Compare frozen original Boros selection with query reformulation under equal candidate and model-call limits.
5. Grade the four discordant answers independently against every native criterion, including the structured instruction question.
6. Evaluate additional preselected histories after the diagnostic changes stabilize.

The first test controls basic answerability with identical inputs to the same model.
The second test varies one presentation factor at a time to measure its effect.
The third test separates answer synthesis from the observed candidate-selection omission.
The fourth tests retrieval reach without assuming that more computation alone explains the gain.

## Evidence locations

The audit uses frozen candidate files, submitted messages, source receipts, native context traces, and authored criteria in ignored private storage.
It compares literal values and source bytes locally and publishes only hashes, coordinates, counts, and sanitized findings.
It does not claim an independent human semantic review.

Public evidence includes [the result metadata](beam-expanded-memory-result.json) and [the active protocol](expanded-memory-protocol.md).
The source mechanisms appear in these files:

- `scripts/expanded-memory-comparison.ts`, lines 77–79, constructs the OptChat initial request.
- `scripts/compare-long-history.ts`, lines 27–33, supplies the shared base instruction to Boros.
- `scripts/beam-grader.ts`, lines 21–34, defines the correctness and citation policy.
- Boros `HistoricalQueryFormulation.swift`, lines 35–106, defines the bounded lexical query.
- Boros `MemoryStore.swift`, lines 1223–1233, defines lexical matching and ranking.
- Boros `ContextAssembler.swift`, lines 465–496 and 856, defines source framing and message order.
- Boros `MeteredExchangeExpansion.swift`, lines 112–155, defines adjacent-source expansion limits.

The evaluated Boros source revision is `f28584bb621e0900563f57b768846d9f06f875fd`.
The measured OptChat source revision is `09ce7ac`.
The completed comparison report revision is `86c33a1`.

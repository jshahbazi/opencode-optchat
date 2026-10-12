# Boros context development diagnostic

## Purpose and preserved evidence

This diagnostic tests possible causes of the four extra OptChat wins in the completed [32K comparison](beam-expanded-memory-results.md).
It preserves that benchmark, its candidates, its grades, and its twenty-question scores.
It does not change Boros application defaults.
See [the diagnosis](optchat-boros-quality-diagnosis.md) for measured differences and remaining uncertainty.

This is a new user-authorized development phase.
It reuses selected questions after their outcomes are known.
Its results cannot establish held-out accuracy or authorize general quality claims.
The diagnostic uses the frozen Boros requests from revision `f28584bb621e0900563f57b768846d9f06f875fd`.
It does not compile the newer active Boros checkout.

## Frozen cases

The selection includes all four OptChat-only correct questions.
It adds one shared-correct and one shared-wrong control.
Both controls require nonempty resolved author references and complete delivery of those referenced originals by Boros.

Control selection first searches the four discordance categories in native question order.
If no shared-correct control qualifies, selection uses the first eligible shared-correct question across all categories.
The shared-wrong control remains restricted to the discordance categories.
No shared-correct question in those categories has complete nonempty reference-source coverage in the recorded Boros request.

| Opaque question label | Category | Original relation |
| --- | --- | --- |
| `cfe976a3493c9ea5` | Contradiction resolution | OptChat correct, Boros incorrect |
| `9cd27fcb7e3d60af` | Instruction following | OptChat correct, Boros incorrect |
| `cf558e1152a1b36e` | Knowledge update | OptChat correct, Boros incorrect |
| `c396433f9b37eb3e` | Multi-session reasoning | OptChat correct, Boros incorrect |
| `d895286773713cfd` | Preference following | Both correct |
| `ab844202768f56b8` | Contradiction resolution | Both incorrect |

The normalized case, native author supplement, accepted native requests, and saved candidates retain their existing hashes.
Each diagnostic request must bind its source request and transformation before generation.

## Request conditions

Each of the six cases receives these six conditions.
Each condition permits one answer request, without tools or retries.
The question remains the exact final user message.

| Condition | Change from frozen native request |
| --- | --- |
| `native_repeat_1` | None. |
| `native_repeat_2` | None. It repeats the same request to measure generation stability. |
| `citation_aligned` | Replace only the base sentence that requires original source IDs with native-label-compatible wording. |
| `evidence_review` | Append one general evidence-review instruction to the existing first system message. |
| `without_recent` | Remove only the eight recorded recent-source messages. |
| `oracle_minimal` | Supply complete originals identified by resolved author references, with aligned citation instructions and no unrelated recent history. |

Citation alignment retains the requirement to read original records before citing them.
It retains the complete native attribution extension.
The conflict comes from the benchmark's custom instruction combined with that extension.
It does not establish a conflict in the default application's instructions.

The evidence-review condition preserves all source bytes, source order, message roles, message boundaries, recent messages, and existing instructions.
It adds this sentence to the first system message:

> Before answering, inspect the supplied historical excerpts and compare any conflicting or updated statements relevant to the current question.

The recent-removal condition preserves all remaining messages byte-for-byte.
Neither condition changes original source storage or runtime authority.
The evidence-review condition tests prompt guidance.
It does not test message-role authority.

The loaded Qwen template rejects system messages outside the first position.
The proposed historical-role condition failed local rendering before any model request.
This version replaces that unsupported condition before any diagnostic candidate exists.

The reference-source condition uses authored source locations and is explicitly oracle-aided.
It changes several factors and serves as a basic answerability control.
Resolved references may omit other relevant sources or required facts.
The condition therefore does not establish complete factual evidence or successful retrieval.
Author answers, rubrics, and criteria never enter answer requests.

## Local model and token checks

All requests use local `ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit`.
Temperature is zero and thinking is disabled.
Calls run serially through the same counted local backend.
The diagnostic does not reload or reconfigure the user's model server.

Answers retain the 32,768-token context window, 2,048 output tokens, and 1,024 safety tokens.
Each complete answer request must contain at most 29,696 actual Qwen input tokens.
Grading permits 384 output tokens and at most 31,360 actual input tokens.
Every submitted request must match the provider's reported input count exactly.
Unknown or mismatched counts invalidate the affected measurement.

The existing accepted tokenizer controls remain unchanged.
A counted synthetic request tests the supported quoted-history structure with several user messages before real questions run.
Its count must match the provider exactly.
A failed structural check stops execution before case answering.

## Grading and repeatability

All thirty-six new candidates must finish before comparative grading begins.
The unchanged correctness-only grader receives native author references and criteria.
It receives no condition label or pipeline metadata.
Delivered original evidence is omitted from grading requests.
Grounding scores remain unset.

The original calibration controls require exact identity and input checks before reuse.
They include fourteen positive controls and twenty incorrect controls.
Six structured questions lacked usable positive calibration candidates.
Positive-control coverage remains incomplete for selected structured questions.

The diagnostic grades all thirty-six new candidates.
It also grades the six unchanged original Boros candidates again.
Fresh original-candidate grades measure judge variation.
Duplicate native requests measure generation variation.
The diagnostic preserves invalid grades and low-confidence verdicts.
It does not retry until a desired verdict appears.

## Resource and artifact contracts

The planned total is seventy-nine new model calls.
This includes one structural check, thirty-six answers, and forty-two grades.
The hard ceiling is 120 new calls.
The phase has one fixed thirty-minute deadline, starting after implementation tests and request freezing.
Resume preserves the same start, deadline, counter, requests, and candidate identities.

The new counter remains separate from the original 2,628-call lineage.
Public reporting must show both counts and their relationship.
The original backend state remains unchanged.
Every failed submitted call consumes a call.
Global resource exhaustion stops dispatch without fabricating unrun cells.

After interruption, audit captured calls before resuming an uncached cell.
The runner does not guarantee exactly-once dispatch across a crash between submission and cache saving.

Private artifacts use ignored storage, directory permissions `0700`, and file permissions `0600`.
They retain source hashes, submitted request hashes, candidates, token receipts, and grading bindings.
Public reports contain counts, hashes, categories, flags, safe error codes, and timings.
They contain no prompts, answers, original text, reference text, or raw provider errors.

## Interpretation rules

Report the four selected discordances separately from the two controls.
Report native repeat stability before attributing a changed verdict to an input transformation.
Compare each isolated condition against its exact native request.
Report the reference-source condition as an oracle-aided control.

An improvement supports a local hypothesis only when its request invariants and grade checks pass.
The same model answerer and grader limit independent semantic conclusions.
A changed grade does not identify which native criterion changed.
Any later implementation requires its own focused validation and evaluation evidence.

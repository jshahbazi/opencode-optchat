# Managed controller failed-receipt amendment

The first summarization attempt reached the unchanged 2,048-token output limit during final answering.
Its request contained 26,019 input tokens and remained within the 32K envelope.
The backend recorded provider usage and rejected the unfinished output with `MODEL_OUTPUT_INCOMPLETE`.
The request receipt lacked a returned provider count because the backend threw after capturing usage.
The strict cache verifier then stopped the phase.

## Preserved measurement

Preserve the original controller, protocol, freeze, all dispatched requests, and all seventeen saved answer files.
Keep the failed candidate empty and worth zero credit.
Do not use truncated provider text as an answer.
Do not retry any dispatched question.
Keep the original 320-call ceiling, fixed 60-minute deadline, and counter.
The continuation begins after 128 counted calls.

## Receipt verification

Use a separate continuation runner without changing the frozen controller or original runner.
Authenticate any missing final provider count against its exact saved request, provider response, and persisted call metric.
Require `MODEL_OUTPUT_INCOMPLETE`, an empty candidate, and a `length` finish reason.
Require matching model, generation settings, prompt usage, output usage, stage, and failure code.
Keep all other request receipts subject to the original strict validation.

Pass the observed provider input count through a cloned validation view only.
Do not change saved receipt bytes or candidate hashes.
Record the authenticated failure proof separately.
Apply this rule to any further equivalent operational failure without retrying that question.

## Continuation binding

Freeze the continuation source, this amendment, the original experiment identity, fixed resources, and existing candidate hashes before further dispatch.
Bind the preserved 128-call metric prefix and original failed-cell proof.
Check these bindings throughout the continuation.
Preserve the original controller and input identity in answer and grade records.
Record the separate amendment identity in continuation metadata.

Complete only the three missing answer cells.
Then grade all forty saved and new candidates with the unchanged blind judge.
Keep the twenty-question denominators and report operational failures explicitly.
Publish only metadata, counts, hashes, and verdicts.

# Managed retrieval controller comparison

The user requested a controller repair and the same twenty-question test with local Qwen at 32K.
This phase changes the custom local evaluation controller.
The OpenCode host controls its own live answering loop.
This phase does not change that host loop or application defaults.

## Controller change

Keep the initial system message, question, complete summary projection, tool definitions, and literal search behavior unchanged.
Keep original records and saved summaries unchanged.
Do not add authored source references or grading information to answering requests.

Maintain a bounded working transcript with complete assistant and tool-result groups.
Retire older navigation results before original-source groups when space is insufficient.
Admit useful source pages before reducing their size through the existing paging interface.
Cache identical validated tool requests and remove fully superseded duplicate groups.
Restore cached evidence when a repeated request needs it again.

Count every rendered request with the actual local Qwen template and tokenizer.
Preserve the 32,768-token window, 2,048 output tokens, and 1,024 safety tokens.
Permit at most 29,696 input tokens.
Pair every tool call with its result or explicit error before another generation request.
Permit twelve navigation rounds and one final answer request.
Finalize with tools disabled when further retrieval cannot continue safely.

Keep the private complete retrieval transcript and immutable request receipts.
Report evidence present in the final submitted request separately from evidence fetched during earlier requests.
Do not count retired source pages as current evidence.

## Frozen inputs

Reuse the saved BEAM conversation, all twenty questions, and the complete 796-message archive.
Reuse the normalized case and native author-reference supplement without edits.
Copy the database through a consistent SQLite snapshot into a new private run.
Verify exact original, summary, publication, failed-job, and snapshot hashes against the completed comparison.
Reuse all 398 publications and retain all twenty-three optional failed parent jobs.
Do not run compaction, retry preparation, or alter summary selection.

Freeze the controller, runner, dependencies, tokenizer identity, graph audit, and this protocol before generation.
Bind all twenty saved OptChat candidates and their ledgers to the original experiment identity.
Verify the fourteen accepted positive controls and twenty rejected negative controls.
Six structured questions still lack usable positive calibration candidates.

## Answering and grading

Use `ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit` through the unchanged local endpoint.
Use temperature zero, disabled thinking, serial requests, and no automatic retries.
Do not reload or reconfigure the server.
Answer all twenty questions once in native order before any grading.

Grade the twenty new and twenty saved OptChat candidates with the unchanged blind correctness-only judge.
Alternate saved and new candidate order by question index.
Do not include controller labels or delivered evidence in grading requests.
Preserve authored criteria and reference answers exactly.
Use 384 grading output tokens and 1,024 safety tokens within the same 32K window.
Verify actual input counts against provider receipts.

All twenty questions remain in each denominator.
Answer failures receive zero credit.
Invalid grades or token-integrity failures hold aggregate quality scores.
Report low-confidence verdicts and changes in saved-candidate grades explicitly.
Keep the original 10/20 result unchanged.
Retain the existing Boros 6/20 and recent-control 3/20 results as historical comparisons.

## Resources and interpretation

This is a new user-authorized phase with its own fixed 60-minute deadline and 320-call ceiling.
The phase counter begins at zero and counts every attempted request.
The planned maximum is 260 answering calls and forty grading calls.

Preserve the earlier 2,628-call experiment and the completed 95-call diagnostic phase separately.
Report combined known usage without counting inherited calls twice.
Do not extend the new deadline on resume.
Audit an interrupted dispatch before any manual resume.

Keep private directories at mode 0700 and files at mode 0600.
Publish only counts, hashes, opaque question labels, timings, and verdicts.
The same local model answers and grades these reused development questions.
Any improvement measures this controller on this history.
It does not establish general accuracy or integration with the OpenCode host.

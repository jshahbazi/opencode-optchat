# Sol paired memory comparison

The user authorized the same twenty-question benchmark with GPT-6.1 Sol.
The user selected a comparison of OptChat and Boros.
This phase creates forty new answers and eighty blind grades.
The grader also evaluates forty saved Qwen answers from the previous two systems.

## Model and context

Use `gpt-6.1-sol` through the OpenAI Responses API.
Use medium reasoning effort for both answer arms.
Use low reasoning effort for the blind grader.
Do not claim deterministic generation or specify an unsupported temperature.

Keep the total context allowance at 32,768 tokens.
Reserve 8,192 output tokens and 1,024 safety tokens before input admission.
Permit at most 23,552 input tokens.
Output usage includes reasoning tokens and visible answer tokens.
Use the same 8K allowance for grading because Sol performs reasoning during grading.

Count each complete request through the Responses input-token endpoint before generation.
Include instructions, questions, tool definitions, and retained paired tool results.
Check observed input usage against the count receipt.
Keep incomplete responses outside the accepted answer candidate.

## Preserved preparations

Reuse the complete 796-message BEAM history and all twenty native questions.
Reuse the existing OptChat graph, summaries, publications, and retained optional preparation failures.
Use the repaired bounded OptChat controller with its unchanged literal search, zoom, and original-source tools.
Verify every original and graph hash before answering.

Reuse each accepted Boros context from the original paired comparison.
Verify its exact messages, source excerpts, request-body digest, and selection receipt.
Keep the pinned Boros revision in the experiment identity.
This phase tests Sol on those saved preparations.
It does not measure later Boros implementation changes.

Do not rebuild summaries or change the native application defaults.
OptChat summaries were prepared by Qwen.
The result compares answerers and retrieval controllers using those preparations.
It does not qualify an entire Sol-prepared memory pipeline.

## Answering and grading

Alternate the two answer arms within native question order.
Finish all forty answers before calibration or benchmark grading.
Use the unchanged blind grading instruction and complete authored reference and rubric.
Exclude system labels, retrieval evidence, and experiment metadata from grading requests.

Calibrate the Sol grader on fourteen authored positives and twenty fabricated negatives.
Report the six questions that lack usable authored positive controls.
Keep low-confidence verdicts and invalid grades explicit.
Hold aggregate quality scores if calibration or grading integrity fails.
Keep all twenty questions in each answer denominator.
Assign zero credit to failed answers.

Grade the forty new answers and forty saved Qwen answers with the same Sol judge.
Alternate saved and new candidates by question.
Preserve previous Qwen-graded results as historical evidence.
Report correctness separately from original-source coverage.

## Remote processing and accounting

The supplied API key authorizes this standalone benchmark's OpenAI requests.
Read the supplied credential file into process memory only.
Do not copy the key, authentication headers, raw provider errors, or hidden reasoning into artifacts.
Keep private directories at mode 0700 and files at mode 0600.
Publish only aggregate results, hashes, opaque labels, usage, timings, and verdicts.

Use stateless requests with storage disabled and complete visible tool-call and tool-result pairs.
Authenticate a synthetic two-request tool continuation before the benchmark answers.
Preserve the synthetic receipts as separate transport evidence.
Do not use provider conversation identifiers or hidden reasoning to bypass context accounting.

Use serial generation with no automatic retries.
The phase permits at most 420 generation calls and 3,000 token-count calls.
Keep the initial 120-minute deadline fixed across continuations.
Each request permits ten minutes within the remaining phase time.
Reserve conservative cost before generation and stop at the 60-dollar ceiling.
Keep unknown usage charged and require an audit before further dispatch.

A new private directory and frozen identity separate this phase from the stopped Qwen benchmark.
Preserve the previous 2,628, 95, and 196 generation counters separately.
Honor stop markers before writes and requests.
Abort an active request when a new stop marker appears.

The same Sol model answers and grades reused development questions.
Report that limitation with every quality result.
The benchmark does not establish held-out accuracy or native remote-processing support.

## Official API sources

The [Sol model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol) specifies Responses tool calling and supported reasoning efforts.
The [token-counting documentation](https://developers.openai.com/api/docs/guides/token-counting) describes complete request counts and reasoning-inclusive output usage.
The [function-calling documentation](https://developers.openai.com/api/docs/guides/function-calling) defines paired tool calls and outputs.

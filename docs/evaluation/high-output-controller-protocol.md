# Larger answering output allowance

The user requested a larger output allowance after two answers reached the former 2,048-token limit.
The new local evaluation controller permits 8,192 output tokens for every answering request.
This allowance is four times the former limit.
The total context window remains 32,768 tokens.

| Request component | Token allowance |
| --- | ---: |
| Answer output | 8,192 |
| Safety reserve | 1,024 |
| Maximum input | 23,552 |
| Additional navigation margin | 256 |

The controller reserves output capacity before it admits retrieved evidence.
It counts instructions, tools, summaries, questions, and retained retrieval groups within the input allowance.
Navigation requests also preserve the existing 256-token continuation margin.
Final answering requests use the same 8,192-token output allowance.

The saved initial requests contain between 11,181 and 11,217 input tokens.
Those recorded counts fit the new input allowance.
Later requests may retain less retrieved evidence because the larger output reserve reduces input capacity.

The larger allowance does not guarantee that every answer finishes.
An incomplete answer still receives zero credit.
The runner authenticates incomplete last-request receipts from exact captured requests, provider usage, and failed metrics.
It preserves an empty candidate and does not retry that answer.

The former backend permitted 120 seconds for each request.
The two incomplete 2K requests took approximately 40 and 47 seconds.
An 8K answer could exceed that timeout.
The new backend permits 600 seconds per request, limited by the remaining phase deadline.
It retains the overall 60-minute deadline and serial request accounting.

## Source and experiment boundaries

Use `scripts/high-output-controller-comparison.ts` for a future comparison.
That runner uses `scripts/high-output-optchat-controller.ts` and the versioned 8K protocol.
It uses `scripts/high-output-local-backend.ts` for the longer request timeout.
It validates cached answer receipts against the new output and input allowances.
The existing managed controller, comparison, continuation, and frozen experiment artifacts retain their original settings.
Separate source versions preserve their recorded source hashes.

A future comparison requires a new private run directory and a new frozen identity.
The runner rejects a directory that contains `user-requested-stop.json` before it writes data or contacts the local server.
It checks that marker again before subsequent requests.
The previous stopped benchmark remains stopped.
This configuration change does not authorize a benchmark restart.

The blind grader retains its existing 384-token output allowance.
Summary preparation and existing saved summaries retain their previous settings.
The local model server, OpenCode host loop, and application defaults retain their previous configuration.

## Verification

Offline synthetic checks cover output propagation, exact input admission, retrieval retirement, final answering, and incomplete-output handling.
They use synthetic sources and local fixtures.
They make no model requests.

All 24 focused checks passed with 210 assertions.
TypeScript and documentation checks passed.
All 130 source bindings across the previous experiment and receipt amendment still match.
The stopped experiment retains 196 calls and its stop marker.
No new twenty-question accuracy result accompanies this configuration change.

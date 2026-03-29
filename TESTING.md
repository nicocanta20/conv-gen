# Testing notes

## Tested

- **Responses API streaming** — generates conversations correctly with `client.responses.create()` + streaming
- **Structured output** — JSON schema enforces valid format, eliminated retries (was 24.5s with 3 retries, now 3.5s with 0)
- **Parallel workers** — 2 concurrent slots generating simultaneously
- **JSONL output format** — verified output parses correctly, conversations have proper role/content structure
- **`--quiet` mode** — outputs clean NDJSON, one JSON object per line, no ANSI escape codes
- **Retries with backoff** — observed retries happening on first key (auth failure), worked correctly on valid key
- **Diversity params** — `temperature: 0.9`, `frequency_penalty: 0.5`, `presence_penalty: 0.5` produce varied conversations
- **LLM-as-judge** — tested with `threshold: 7` (all 3 passed, scores 8-9) and `threshold: 10` (all 3 filtered out). Scoring and filtering work correctly.

## Not tested

- **Batch API** (`--batch`) — implemented but not run, takes up to 24h to complete
- **Cache/resume** — logic implemented + SIGINT handler saves in-flight IDs, but didn't test interrupting mid-run and resuming
- **Interactive wizard** — code works (readline prompts), but not run end-to-end through the API
- **Other output formats** — `sharegpt`, `openai-ft`, `alpaca`, `json` are implemented but only `jsonl` was verified
- **Rate limiting** — token-bucket logic implemented, not tested under load with `max_rpm` set
- **Large scale** — only tested with 3 conversations, not 100+ to check memory/performance

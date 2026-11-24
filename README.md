# conv-gen

Generate synthetic multi-turn conversation datasets using the OpenAI Responses API. Any topic, any format, in parallel.

## Setup

```bash
npm install
export OPENAI_API_KEY="sk-..."
```

## Usage

```bash
# Interactive — asks you everything
node conv-gen.mjs

# With config file
node conv-gen.mjs config.example.json

# Override count (50) and concurrency (5)
node conv-gen.mjs config.example.json 50 5

# Batch API — 50% cheaper, up to 24h
node conv-gen.mjs config.example.json 1000 --batch

# Machine-readable NDJSON output (for agents/pipelines)
node conv-gen.mjs config.example.json --quiet
```

## Config

See `config.example.json`. The key fields:

```json
{
  "prompt": "Tech support for a SaaS platform. Include ticket IDs and error codes.",
  "scenarios": ["User can't log in", "User reports a bug", "User asks about billing"],
  "user_role": "customer",
  "assistant_role": "support agent"
}
```

Optional: `model`, `format`, `count`, `concurrency`, `retries`, `max_rpm`, `batch`, `judge`, `reasoning_effort`, and `temperature` / `frequency_penalty` / `presence_penalty`.

GPT-5.x models reject the sampling params unless reasoning is off. To use them, set `"reasoning_effort": "none"`:

```json
{ "reasoning_effort": "none", "temperature": 0.9, "frequency_penalty": 0.5, "presence_penalty": 0.5 }
```

## Output formats

`json` (default), `jsonl`, `openai-ft`, `sharegpt`, `alpaca` — set via `"format"` in config.

## Features

- **Parallel streaming** with live terminal UI (progress bars per worker)
- **Structured output** — OpenAI JSON schema guarantees valid format, no retries needed
- **Rate limiting** — token-bucket `max_rpm` to stay within API limits
- **Retries** — exponential backoff on failures
- **Cache/resume** — Ctrl+C saves progress, re-run to continue
- **Batch API** — `--batch` flag, 50% cheaper for large datasets
- **LLM judge** — `"judge": {"threshold": 7}` scores and filters low-quality conversations
- **`--quiet`** — NDJSON output for agents and CI/CD

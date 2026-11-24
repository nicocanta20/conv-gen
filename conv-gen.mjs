#!/usr/bin/env node
// conv-gen.mjs — generic parallel conversation generator
//
// Usage:
//   node conv-gen.mjs                          # interactive wizard
//   node conv-gen.mjs <config.json>            # use config file
//   node conv-gen.mjs <config.json> [count] [concurrency] [output]
//   node conv-gen.mjs <config.json> --batch    # use OpenAI Batch API (50% cheaper)
//   node conv-gen.mjs <config.json> --quiet    # machine-readable output (no ANSI)

import OpenAI, { toFile } from "openai";
import fs from "fs";
import readline from "readline";

// ━━━ TERMINAL ━━━
const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", gray: "\x1b[90m",
  hide: "\x1b[?25l", show: "\x1b[?25h",
  clear: "\x1b[2K", up: (n) => `\x1b[${n}A`,
};

const BAR_WIDTH = 20;
const PREVIEW_WIDTH = 50;

// ━━━ INTERACTIVE WIZARD ━━━

function ask(rl, question, fallback) {
  return new Promise((resolve) => {
    rl.question(`${c.bold}? ${c.reset}${question}${fallback ? ` ${c.dim}(${fallback})${c.reset}` : ""}: `, (answer) => {
      resolve(answer.trim() || fallback || "");
    });
  });
}

async function wizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n${c.bold}━━━ CONVERSATION GENERATOR — Setup ━━━${c.reset}\n`);

  const prompt = await ask(rl, "Topic / domain description", "General customer support");
  const userRole = await ask(rl, "User role", "user");
  const assistantRole = await ask(rl, "Assistant role", "assistant");
  const model = await ask(rl, "Model", "gpt-5.6-luna");
  const count = await ask(rl, "Number of conversations", "10");
  const concurrency = await ask(rl, "Concurrency (parallel workers)", "3");
  const format = await ask(rl, "Output format (json, jsonl, sharegpt, openai-ft, alpaca)", "jsonl");
  const output = await ask(rl, "Output file", `conversations.${format === "json" ? "json" : "jsonl"}`);
  const scenariosRaw = await ask(rl, "Scenarios (comma-separated, or empty for auto)", "");
  const useBatch = await ask(rl, "Use Batch API? 50% cheaper, slower (y/n)", "n");
  const useJudge = await ask(rl, "Score quality with LLM judge? (y/n)", "n");

  let scenarios;
  if (scenariosRaw) {
    scenarios = scenariosRaw.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    scenarios = [
      `${userRole} asks a general question`,
      `${userRole} has a complaint`,
      `${userRole} needs help with a problem`,
      `${userRole} asks about pricing or billing`,
      `${userRole} requests a change`,
      `${userRole} follows up on a previous issue`,
    ];
  }

  const config = {
    model,
    prompt,
    scenarios,
    user_role: userRole,
    assistant_role: assistantRole,
    count: parseInt(count),
    concurrency: parseInt(concurrency),
    format,
    output,
    batch: useBatch.toLowerCase() === "y",
    judge: useJudge.toLowerCase() === "y" ? { threshold: 7 } : false,
  };

  const configPath = "conv-gen-config.json";
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`\n${c.green}Config saved to ${configPath}${c.reset}\n`);

  rl.close();
  return config;
}

// ━━━ INSTRUCTIONS BUILDER ━━━

function buildInstructions(config) {
  const userRole = config.user_role || "user";
  const assistantRole = config.assistant_role || "assistant";
  const topicPrompt = config.prompt || "A general conversation";

  return `Generate a realistic conversation.
- user = ${userRole}, assistant = ${assistantRole}
- 4-8 turns, natural dialogue
Topic: ${topicPrompt}`;
}

// Optional model params, only sent when set in config.
// GPT-5.x models reject sampling params unless reasoning_effort is "none".
function samplingParams(config) {
  const keys = ["temperature", "frequency_penalty", "presence_penalty"];
  const params = Object.fromEntries(keys.filter((k) => config[k] !== undefined).map((k) => [k, config[k]]));
  if (config.reasoning_effort) params.reasoning = { effort: config.reasoning_effort };
  return params;
}

const CONVERSATION_SCHEMA = {
  format: {
    type: "json_schema",
    name: "conversation",
    strict: true,
    schema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant"] },
              content: { type: "string" },
            },
            required: ["role", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["messages"],
      additionalProperties: false,
    },
  },
};

// ━━━ RATE LIMITER ━━━

class RateLimiter {
  constructor(maxRpm) {
    this.maxRpm = maxRpm;
    this.tokens = maxRpm;
    this.lastRefill = Date.now();
  }

  async acquire() {
    if (!this.maxRpm) return;
    while (true) {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 60000;
      this.tokens = Math.min(this.maxRpm, this.tokens + elapsed * this.maxRpm);
      this.lastRefill = now;

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Sleep for the exact time needed to accumulate 1 token, then re-check
      const waitMs = ((1 - this.tokens) / this.maxRpm) * 60000;
      await new Promise((r) => setTimeout(r, Math.ceil(waitMs) + 1));
    }
  }
}

// ━━━ CACHE / RESUME ━━━

class Cache {
  constructor(outputPath) {
    this.path = outputPath + ".cache.json";
    this.data = { completed: [], pending: [], config_hash: "" };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.path)) {
        this.data = JSON.parse(fs.readFileSync(this.path, "utf-8"));
      }
    } catch {
      this.data = { completed: [], pending: [], config_hash: "" };
    }
  }

  save() {
    fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  isValid(configHash) {
    return this.data.config_hash === configHash && this.data.completed.length > 0;
  }

  init(configHash, totalIds) {
    this.data.config_hash = configHash;
    this.data.pending = totalIds;
    this.data.completed = [];
    this.save();
  }

  markDone(id, conv) {
    this.data.completed.push(conv);
    this.data.pending = this.data.pending.filter((i) => i !== id);
    this.save();
  }

  cleanup() {
    try { fs.unlinkSync(this.path); } catch {}
  }
}

function configHash(config, count) {
  return `${config.prompt}|${config.model}|${count}|${config.scenarios?.join(",")}`;
}

// ━━━ LLM-AS-JUDGE ━━━

async function judgeConversation(client, model, conv) {
  const convText = conv.messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const resp = await client.responses.create({
    model,
    max_output_tokens: 100,
    instructions: `Rate this conversation's quality on a scale of 1-10. Consider: naturalness, coherence, information density, and realism. Reply with ONLY a JSON object: {"score": N, "reason": "brief reason"}`,
    input: convText,
    store: false,
  });

  try {
    const text = resp.output_text;
    return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0]);
  } catch {
    return { score: 5, reason: "judge parse error" };
  }
}

// ━━━ OUTPUT FORMATTERS ━━━

function formatOutput(conversations, format) {
  switch (format) {
    case "jsonl":
      return conversations.map((conv) => JSON.stringify(conv)).join("\n") + "\n";

    case "sharegpt":
      return conversations
        .map((conv) => {
          const mapped = {
            id: conv.id,
            conversations: conv.messages.map((m) => ({
              from: m.role === "user" ? "human" : "gpt",
              value: m.content,
            })),
          };
          return JSON.stringify(mapped);
        })
        .join("\n") + "\n";

    case "openai-ft":
      return conversations
        .map((conv) => {
          return JSON.stringify({ messages: conv.messages });
        })
        .join("\n") + "\n";

    case "alpaca":
      return conversations
        .map((conv) => {
          // Alpaca: take first user message as instruction, first assistant as output
          const instruction = conv.messages.find((m) => m.role === "user")?.content || "";
          const output = conv.messages.find((m) => m.role === "assistant")?.content || "";
          return JSON.stringify({ instruction, input: "", output });
        })
        .join("\n") + "\n";

    case "json":
    default:
      return JSON.stringify({ conversations }, null, 2);
  }
}

// ━━━ DISPLAY ━━━

function progressBar(percent) {
  const filled = Math.round(BAR_WIDTH * percent);
  const empty = BAR_WIDTH - filled;
  return `${"█".repeat(filled)}${c.dim}${"░".repeat(empty)}${c.reset}`;
}

function truncate(str, len) {
  const clean = str.replace(/[\n\r]/g, " ").replace(/\s+/g, " ");
  return clean.length > len ? clean.slice(0, len - 1) + "…" : clean.padEnd(len);
}

class Display {
  constructor(slots) {
    this.slots = slots;
    this.state = Array(slots).fill().map(() => ({ status: "idle", text: "", percent: 0, id: null }));
    this.completed = 0;
    this.failed = 0;
    this.filtered = 0;
    this.retried = 0;
    this.total = 0;
    process.stdout.write(c.hide);
    this.init();
  }

  init() {
    console.log(`\n${c.bold}━━━ CONVERSATION GENERATOR ━━━${c.reset}\n`);
    for (let i = 0; i < this.slots; i++) {
      console.log(`  ${c.gray}Slot ${i + 1}: waiting...${c.reset}`);
    }
    console.log(`\n${c.dim}Progress: 0/0${c.reset}`);
    console.log("");
  }

  update(slot, data) {
    this.state[slot] = { ...this.state[slot], ...data };
    this.render();
  }

  render() {
    process.stdout.write(c.up(this.slots + 3));

    for (let i = 0; i < this.slots; i++) {
      const s = this.state[i];
      process.stdout.write(c.clear);

      if (s.status === "idle") {
        console.log(`  ${c.gray}Slot ${i + 1}: waiting...${c.reset}`);
      } else if (s.status === "running") {
        const preview = truncate(s.text || "starting...", PREVIEW_WIDTH);
        console.log(`  ${c.bold}#${s.id.toString().padStart(3)}${c.reset} ${progressBar(s.percent)} ${c.dim}${preview}${c.reset}`);
      } else if (s.status === "done") {
        const preview = truncate(s.preview || "", PREVIEW_WIDTH);
        console.log(`  ${c.green}#${s.id.toString().padStart(3)} ✓${c.reset} ${c.dim}${s.ms}ms${c.reset} ${c.gray}${preview}${c.reset}`);
      } else if (s.status === "judging") {
        console.log(`  ${c.dim}#${s.id.toString().padStart(3)} ⚖${c.reset}  ${c.dim}scoring...${c.reset}`);
      } else if (s.status === "filtered") {
        console.log(`  ${c.dim}#${s.id.toString().padStart(3)} ✗${c.reset} ${c.dim}score ${s.score}/10 — filtered${c.reset}`);
      } else if (s.status === "error") {
        console.log(`  ${c.red}#${s.id.toString().padStart(3)} ✗ ${s.error}${c.reset}`);
      }
    }

    process.stdout.write(c.clear);
    const done = this.completed + this.failed + this.filtered;
    const pct = this.total > 0 ? Math.round(done / this.total * 100) : 0;
    let stats = `${c.green}${this.completed}${c.reset}${c.dim}/${this.total} done`;
    if (this.failed > 0) stats += ` ${c.red}${this.failed}${c.reset}${c.dim} failed`;
    if (this.filtered > 0) stats += ` ${c.dim}${this.filtered}${c.reset}${c.dim} filtered`;
    if (this.retried > 0) stats += ` ${c.bold}${this.retried}${c.reset}${c.dim} retried`;
    stats += ` [${pct}%]${c.reset}`;
    console.log(`\n${c.dim}Progress: ${stats}`);
    console.log("");
  }

  finish(output, elapsed, extra = {}) {
    process.stdout.write(c.show);
    console.log(`${c.bold}━━━ COMPLETE ━━━${c.reset}`);
    console.log(`  ${c.green}✓${c.reset} Generated: ${this.completed}`);
    if (this.failed > 0) console.log(`  ${c.red}✗${c.reset} Failed: ${this.failed}`);
    if (this.filtered > 0) console.log(`  ${c.dim}⚖${c.reset} Filtered: ${this.filtered}`);
    if (this.retried > 0) console.log(`  ${c.bold}↻${c.reset} Retried: ${this.retried}`);
    if (extra.resumed) console.log(`  ${c.bold}↺${c.reset} Resumed: ${extra.resumed} from cache`);
    console.log(`  ${c.dim}⏱${c.reset}  Time: ${elapsed}s`);
    console.log(`  ${c.dim}📁${c.reset} Saved: ${output}`);
    if (extra.format) console.log(`  ${c.dim}📄${c.reset} Format: ${extra.format}`);
    console.log("");
  }
}

class QuietDisplay {
  constructor() {
    this.completed = 0;
    this.failed = 0;
    this.filtered = 0;
    this.retried = 0;
    this.total = 0;
    this._slotIds = {};
  }

  update(slot, data) {
    if (data.id !== undefined) this._slotIds[slot] = data.id;
    const id = data.id ?? this._slotIds[slot] ?? null;
    if (data.status === "done") {
      console.log(JSON.stringify({ event: "done", id, ms: data.ms, preview: (data.preview || "").slice(0, 80) }));
    } else if (data.status === "error") {
      console.log(JSON.stringify({ event: "error", id, error: data.error }));
    } else if (data.status === "filtered") {
      console.log(JSON.stringify({ event: "filtered", id, score: data.score }));
    }
  }

  finish(output, elapsed, extra = {}) {
    console.log(JSON.stringify({ event: "complete", generated: this.completed, failed: this.failed, filtered: this.filtered, retried: this.retried, time_s: parseFloat(elapsed), file: output, format: extra.format || "json", ...(extra.resumed ? { resumed: extra.resumed } : {}) }));
  }
}

// ━━━ GENERATE (streaming, with retries) ━━━

async function generate(id, slot, display, { client, model, instructions, scenarios, maxRetries, rateLimiter, sampling }) {
  const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      display.retried++;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      display.update(slot, { status: "running", id, text: `retry ${attempt}/${maxRetries}...`, percent: 0 });
      await new Promise((r) => setTimeout(r, delay));
    }

    await rateLimiter.acquire();
    const start = Date.now();
    let text = "";

    display.update(slot, { status: "running", id, text: scenario, percent: 0 });

    try {
      const stream = await client.responses.create({
        model,
        max_output_tokens: 4000,
        stream: true,
        instructions,
        input: scenario,
        text: CONVERSATION_SCHEMA,
        ...sampling,
        store: false,
      });

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          text += event.delta;
          const percent = Math.min(text.length / 1200, 0.95);
          const previewMatch = text.match(/"content"\s*:\s*"([^"]{10,50})/);
          const preview = previewMatch ? previewMatch[1] : text.slice(0, 50);
          display.update(slot, { percent, text: preview });
        }
      }

      display.update(slot, { percent: 1, text: "parsing..." });

      const json = JSON.parse(text);

      const ms = Date.now() - start;
      const firstMsg = json.messages[0]?.content?.slice(0, 50) || "";

      display.update(slot, { status: "done", ms, preview: firstMsg });

      return {
        id: `conv_${String(id).padStart(5, "0")}`,
        messages: json.messages,
        metadata: { timestamp: new Date().toISOString(), scenario, ms, attempts: attempt + 1 },
      };
    } catch (e) {
      lastError = e;
    }
  }

  display.failed++;
  display.update(slot, { status: "error", error: lastError.message.slice(0, 40) });
  return null;
}

// ━━━ BATCH MODE ━━━

async function runBatch(config, count, outputPath) {
  const client = new OpenAI();
  const instructions = buildInstructions(config);
  const model = config.model || "gpt-5.6-luna";
  const scenarios = config.scenarios || ["General conversation"];

  console.log(`\n${c.bold}━━━ BATCH MODE ━━━${c.reset}\n`);

  // Step 1: Build JSONL
  console.log(`  ${c.bold}1/5${c.reset} Building ${count} requests...`);
  const requests = [];
  for (let i = 1; i <= count; i++) {
    const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
    requests.push({
      custom_id: `conv_${String(i).padStart(5, "0")}`,
      method: "POST",
      url: "/v1/responses",
      body: {
        model,
        max_output_tokens: 4000,
        instructions,
        input: scenario,
        text: CONVERSATION_SCHEMA,
        ...samplingParams(config),
        store: false,
      },
    });
  }
  const jsonl = requests.map((r) => JSON.stringify(r)).join("\n");

  // Step 2: Upload
  console.log(`  ${c.bold}2/5${c.reset} Uploading JSONL file...`);
  const inputFile = await client.files.create({
    file: await toFile(Buffer.from(jsonl, "utf-8"), "batch_input.jsonl"),
    purpose: "batch",
  });
  console.log(`        ${c.dim}File: ${inputFile.id}${c.reset}`);

  // Step 3: Create batch
  console.log(`  ${c.bold}3/5${c.reset} Creating batch...`);
  const batch = await client.batches.create({
    input_file_id: inputFile.id,
    endpoint: "/v1/responses",
    completion_window: "24h",
  });
  console.log(`        ${c.dim}Batch: ${batch.id}${c.reset}`);

  // Step 4: Poll
  console.log(`  ${c.bold}4/5${c.reset} Waiting for completion...`);
  let status = batch;
  const startTime = Date.now();
  while (!["completed", "failed", "expired", "cancelled"].includes(status.status)) {
    await new Promise((r) => setTimeout(r, 10000));
    status = await client.batches.retrieve(batch.id);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const counts = status.request_counts || {};
    process.stdout.write(c.clear);
    process.stdout.write(`\r        ${c.dim}${status.status} — ${counts.completed || 0}/${counts.total || count} done — ${elapsed}s${c.reset}`);
  }
  console.log("");

  if (status.status !== "completed") {
    console.error(`\n  ${c.red}Batch ${status.status}${c.reset}`);
    if (status.errors) console.error(JSON.stringify(status.errors, null, 2));
    process.exit(1);
  }

  // Step 5: Download & parse results
  console.log(`  ${c.bold}5/5${c.reset} Downloading results...`);
  const response = await client.files.content(status.output_file_id);
  const resultText = await response.text();
  const results = resultText.trim().split("\n").map((line) => JSON.parse(line));

  const format = config.format || "json";
  const conversations = [];
  let apiFailed = 0;
  let parseFailed = 0;

  for (const result of results) {
    if (result.error) { apiFailed++; continue; }
    try {
      const text = result.response.body.output_text;
      const json = JSON.parse(text);
      conversations.push({
        id: result.custom_id,
        messages: json.messages,
        metadata: { timestamp: new Date().toISOString() },
      });
    } catch { parseFailed++; }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  fs.writeFileSync(outputPath, formatOutput(conversations, format));

  console.log(`\n${c.bold}━━━ COMPLETE ━━━${c.reset}`);
  console.log(`  ${c.green}✓${c.reset} Generated: ${conversations.length}`);
  if (apiFailed > 0) console.log(`  ${c.red}✗${c.reset} API errors: ${apiFailed}`);
  if (parseFailed > 0) console.log(`  ${c.red}✗${c.reset} Parse/validation errors: ${parseFailed}`);
  console.log(`  ${c.dim}⏱${c.reset}  Time: ${elapsed}s`);
  console.log(`  ${c.dim}📁${c.reset} Saved: ${outputPath}`);
  console.log(`  ${c.dim}📄${c.reset} Format: ${format}`);
  console.log("");
}

// ━━━ STREAMING MODE (main) ━━━

async function runStreaming(config, count, concurrency, outputPath, { quiet = false } = {}) {
  const client = new OpenAI();
  const instructions = buildInstructions(config);
  const model = config.model || "gpt-5.6-luna";
  const scenarios = config.scenarios || ["General conversation"];
  const maxRetries = config.retries ?? 3;
  const sampling = samplingParams(config);
  const maxRpm = config.max_rpm || 0;
  const format = config.format || "json";
  const judgeConfig = config.judge || false;

  const rateLimiter = new RateLimiter(maxRpm);
  const cache = new Cache(outputPath);
  const hash = configHash(config, count);

  let results = [];
  let queue;
  let resumed = 0;

  if (cache.isValid(hash)) {
    results = cache.data.completed;
    queue = cache.data.pending.slice();
    resumed = results.length;
    console.log(`\n${c.bold}Resuming: ${resumed} cached, ${queue.length} remaining${c.reset}`);
  } else {
    queue = Array.from({ length: count }, (_, i) => i + 1);
    cache.init(hash, queue.slice());
  }

  const display = quiet ? new QuietDisplay() : new Display(concurrency);
  display.total = count;
  display.completed = resumed;

  const startTime = Date.now();

  // Track in-flight IDs so SIGINT can save them
  const inFlight = new Set();

  // Graceful shutdown: save cache on SIGINT
  let shutdownRequested = false;
  process.on("SIGINT", () => {
    if (shutdownRequested) process.exit(1);
    shutdownRequested = true;
    if (!quiet) process.stdout.write(c.show);
    cache.data.pending = [...queue, ...inFlight];
    cache.save();
    if (quiet) {
      console.log(JSON.stringify({ event: "interrupted", saved: results.length, remaining: cache.data.pending.length }));
    } else {
      console.log(`\n\n${c.dim}Interrupted — saving progress to cache...${c.reset}`);
      console.log(`${c.green}Saved ${results.length} conversations. Re-run to resume.${c.reset}\n`);
    }
    process.exit(0);
  });

  const worker = async (slot) => {
    while (queue.length > 0 && !shutdownRequested) {
      const id = queue.shift();
      inFlight.add(id);

      const conv = await generate(id, slot, display, {
        client, model, instructions, scenarios, maxRetries, rateLimiter, sampling,
      });

      if (conv) {
        if (judgeConfig) {
          display.update(slot, { status: "judging", id });
          await rateLimiter.acquire();
          const verdict = await judgeConversation(client, model, conv);
          conv.metadata.score = verdict.score;
          conv.metadata.score_reason = verdict.reason;

          if (verdict.score < (judgeConfig.threshold || 7)) {
            display.filtered++;
            display.update(slot, { status: "filtered", id, score: verdict.score });
          } else {
            display.completed++;
            results.push(conv);
            cache.markDone(id, conv);
          }
        } else {
          display.completed++;
          results.push(conv);
          cache.markDone(id, conv);
        }
      }

      inFlight.delete(id);
      await new Promise((r) => setTimeout(r, 300));
      if (queue.length > 0 && !shutdownRequested) {
        display.update(slot, { status: "idle" });
      }
    }
  };

  await Promise.all(Array(concurrency).fill().map((_, i) => worker(i)));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  fs.writeFileSync(outputPath, formatOutput(results, format));
  cache.cleanup();

  display.finish(outputPath, elapsed, { format, resumed });
}

// ━━━ MAIN ━━━

async function main() {
  let config;

  const args = process.argv.slice(2);
  const isBatch = args.includes("--batch");
  const isQuiet = args.includes("--quiet");
  const positional = args.filter((a) => !a.startsWith("--"));

  if (positional.length === 0) {
    // Interactive wizard
    config = await wizard();
  } else {
    config = JSON.parse(fs.readFileSync(positional[0], "utf-8"));
  }

  const count = parseInt(positional[1]) || config.count || 10;
  const concurrency = parseInt(positional[2]) || config.concurrency || 3;
  const outputPath = positional[3] || config.output || "conversations.json";
  const batch = isBatch || config.batch;

  if (batch) {
    await runBatch(config, count, outputPath);
  } else {
    await runStreaming(config, count, concurrency, outputPath, { quiet: isQuiet });
  }
}

main().catch((e) => {
  process.stdout.write(c.show);
  console.error(e);
});

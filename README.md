<p align="center">
  <img src="assets/HydraMCP.png" width="200" />
</p>

<h1 align="center">HydraMCP</h1>
<p align="center">Connect agents to agents.</p>

An MCP server that lets Claude Code query any LLM — compare, vote, and synthesize across GPT, Gemini, Claude, and local models from one terminal.

## Quick Start

```bash
npx hydramcp setup
```

That's it. The wizard walks you through everything — API keys, subscriptions, local models. At the end it gives you the one-liner to add to Claude Code.

Or if you already have API keys:

```bash
claude mcp add hydramcp -e OPENAI_API_KEY=sk-... -- npx hydramcp
```

## What It Looks Like

Four models, four ecosystems, one prompt. Real output from a live session:

```
> compare gpt-5-codex, gemini-3, claude-sonnet, and local qwen on this function review

## Model Comparison (4 models, 11637ms total)

| Model                      | Latency         | Tokens |
|----------------------------|-----------------|--------|
| gpt-5-codex                | 1630ms fastest  | 194    |
| gemini-3-pro-preview       | 11636ms         | 1235   |
| claude-sonnet-4-5-20250929 | 3010ms          | 202    |
| ollama/qwen2.5-coder:14b   | 8407ms          | 187    |
```

All four independently found the same async bug. Then each one caught something different the others missed.

And this is consensus with a local judge:

```
> get consensus from gpt-5, gemini-3, and claude-sonnet. use local qwen as judge.

## Consensus: REACHED

Strategy: majority (needed 2/3)
Agreement: 3/3 models (100%)
Judge: ollama/qwen2.5-coder:14b (686ms)
```

Three cloud models polled, local model judging them. 686ms to evaluate agreement.

## Tools

| Tool | What It Does |
|------|-------------|
| **list_models** | See what's available across all providers |
| **ask_model** | Query any model, optional response distillation |
| **compare_models** | Same prompt to 2-5 models in parallel |
| **consensus** | Poll 3-7 models, LLM-as-judge evaluates agreement |
| **synthesize** | Combine best ideas from multiple models into one answer |
| **analyze_file** | Offload file analysis to a worker model |
| **smart_read** | Extract specific code sections without reading the whole file |
| **session_recap** | Restore context from previous Claude Code sessions |

From inside Claude Code, just say things like:
- "ask gpt-5 to review this function"
- "compare gemini and claude on this approach"
- "get consensus from 3 models on whether this is thread safe"
- "synthesize responses from all models on how to design this API"

## How It Works

```
Claude Code
    |
    HydraMCP (MCP Server)
    |
    SmartProvider (circuit breaker, cache, metrics)
    |
    MultiProvider (routes to the right backend)
    |
    |-- OpenAI     -> api.openai.com (API key)
    |-- Google     -> Gemini API (API key)
    |-- Anthropic  -> api.anthropic.com (API key)
    |-- Sub        -> CLI tools (Gemini CLI, Claude Code, Codex CLI)
    |-- Ollama     -> local models (your hardware)
    |-- LM Studio  -> local or LAN LM Studio server
```

## Three Ways to Connect Models

### API Keys (fastest setup)

Set environment variables. HydraMCP auto-detects them.

| Variable | Provider |
|----------|----------|
| `OPENAI_API_KEY` | OpenAI (GPT-4o, GPT-5, o3, etc.) |
| `GOOGLE_API_KEY` | Google Gemini (2.5 Flash, Pro, etc.) |
| `ANTHROPIC_API_KEY` | Anthropic Claude (Opus, Sonnet, Haiku) |

### Subscriptions (use your monthly plan)

Already paying for ChatGPT Plus, Claude Pro, or Gemini Advanced? HydraMCP wraps the CLI tools those subscriptions include. No API billing.

```bash
npx hydramcp setup   # auto-installs CLIs and runs auth
```

The setup wizard detects which CLIs you have, installs missing ones, and walks you through authentication. Each CLI authenticates via browser once — then it's stored forever.

| Subscription | CLI Tool | What You Get |
|-------------|----------|-------------|
| Gemini Advanced | `gemini` | Gemini 2.5 Flash, Pro, etc. |
| Claude Pro/Max | `claude` | Claude Opus, Sonnet, Haiku |
| ChatGPT Plus/Pro | `codex` | GPT-5, o3, Codex models |

### Local Models

Install [Ollama](https://ollama.com), pull a model, done. Auto-detected.

```bash
ollama pull qwen2.5-coder:14b
```

Or run [LM Studio](https://lmstudio.ai), load a model, and start its server. Auto-detected on `localhost:1234`. If LM Studio is on another machine, point HydraMCP at it. Either pass it to Claude Code when registering the server:

```bash
claude mcp add hydramcp \
  -e LMSTUDIO_URL=http://192.168.40.10:1234 \
  -- npx hydramcp
```

Or set it in your shell / `~/.hydramcp/.env` before starting HydraMCP:

```bash
LMSTUDIO_URL=http://192.168.40.10:1234
```

### Mix and Match

All three methods stack. Use API keys for some providers, subscriptions for others, and Ollama for local. They all show up in `list_models` together.

Route explicitly with prefixes:
- `openai/gpt-5` — force OpenAI API
- `google/gemini-2.5-flash` — force Google API
- `sub/gemini-2.5-flash` — force subscription CLI
- `ollama/qwen2.5-coder:14b` — force local
- `lmstudio/<model>` — force LM Studio
- `gpt-5` — auto-detect (tries each provider)

## Setup Details

### Option A: npx (recommended)

```bash
npx hydramcp setup                           # interactive wizard
claude mcp add hydramcp -- npx hydramcp      # register with Claude Code
```

Config is saved to `~/.hydramcp/.env` and persists across npx runs.

### Option B: Clone

```bash
git clone https://github.com/Pickle-Pixel/HydraMCP.git
cd HydraMCP
npm install && npm run build
claude mcp add hydramcp -- node /path/to/HydraMCP/dist/index.js
```

### Verify

Restart Claude Code and say "list models". You should see everything you configured.

## Architecture

HydraMCP wraps all providers in a **SmartProvider** layer that adds:

- **Circuit breaker** — per-model failure tracking. After 3 failures, the model is disabled for 60s and auto-recovers.
- **Response cache** — SHA-256 keyed, 15-minute TTL. Identical queries are served instantly.
- **Metrics** — per-model query counts, latency, token usage, cache hit rates.
- **Response distillation** — set `max_response_tokens` on any query and a cheap model compresses the response while preserving code, errors, and specifics.

## Contributing

Want to add a provider? The interface is three methods:

```typescript
interface Provider {
  healthCheck(): Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
  query(model: string, prompt: string, options?: QueryOptions): Promise<QueryResponse>;
}
```

See `src/providers/ollama.ts` for a working example. Implement it, register in `src/index.ts`, done.

Providers we'd love to see: OpenRouter, Groq, Together AI, or anything that speaks HTTP.

## License

MIT

#!/usr/bin/env node

/**
 * HydraMCP — Entry point.
 *
 * Auto-detects available providers from environment and installed tools:
 *
 *   API Keys (direct, fast):
 *     OPENAI_API_KEY      → OpenAI (GPT-4o, GPT-5, o3, etc.)
 *     GOOGLE_API_KEY      → Google Gemini (or GEMINI_API_KEY)
 *     ANTHROPIC_API_KEY   → Anthropic Claude
 *
 *   Subscriptions (via installed CLI tools):
 *     gemini CLI           → Gemini Advanced subscription
 *     claude CLI           → Claude Pro/Max subscription
 *     codex CLI            → ChatGPT Plus/Pro subscription
 *
 *   Local models:
 *     OLLAMA_URL           → Ollama local models (auto-detected)
 *     LMSTUDIO_URL         → LM Studio (defaults to http://localhost:1234)
 *
 * Set any combination. HydraMCP registers what's available.
 *
 * Model routing:
 *   "openai/gpt-4o"          → OpenAI API key
 *   "google/gemini-2.5-flash" → Google API key
 *   "anthropic/claude-..."    → Anthropic API key
 *   "sub/gemini-2.5-flash"    → Gemini CLI subscription
 *   "sub/claude-..."          → Claude CLI subscription
 *   "ollama/llama3"           → local Ollama instance
 *   "lmstudio/<model>"        → local/LAN LM Studio instance
 *   "gpt-4o"                  → auto-detect (tries each provider)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenAIProvider } from "./providers/openai.js";
import { GoogleProvider } from "./providers/google.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { SubscriptionProvider } from "./providers/subscription.js";
import { OllamaProvider } from "./providers/ollama.js";
import { LMStudioProvider } from "./providers/lmstudio.js";
import { MultiProvider } from "./providers/multi-provider.js";
import { SmartProvider } from "./orchestrator/index.js";
import { createServer } from "./server.js";
import { logger } from "./utils/logger.js";
import { loadEnv } from "./utils/env.js";

async function main() {
  // Setup wizard: npx hydramcp setup
  if (process.argv.includes("setup")) {
    const { runSetup } = await import("./setup.js");
    await runSetup();
    return;
  }

  // Load .env before anything reads process.env
  loadEnv();

  const multi = new MultiProvider();
  const active: string[] = [];

  // --- Native API providers (preferred — direct, fast, reliable) ---

  if (process.env.OPENAI_API_KEY) {
    multi.register("openai", new OpenAIProvider());
    active.push("OpenAI");
  }

  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
    multi.register("google", new GoogleProvider());
    active.push("Google");
  }

  if (process.env.ANTHROPIC_API_KEY) {
    multi.register("anthropic", new AnthropicProvider());
    active.push("Anthropic");
  }

  // --- Subscription providers (CLI-based, uses monthly subscriptions) ---

  const sub = new SubscriptionProvider();
  const subCount = await sub.detect();
  if (subCount > 0) {
    multi.register("sub", sub);
    active.push(`Subscriptions (${subCount} CLI tools)`);
  }

  // --- Local models ---

  const ollama = new OllamaProvider();
  if (await ollama.healthCheck()) {
    multi.register("ollama", ollama);
    active.push("Ollama");
  }

  const lmstudio = new LMStudioProvider();
  if (await lmstudio.healthCheck()) {
    multi.register("lmstudio", lmstudio);
    active.push("LM Studio");
  }

  // --- Startup summary ---

  if (active.length === 0) {
    logger.warn(
      "No providers detected. Set at least one:\n" +
        "\n" +
        "  API Keys (direct access):\n" +
        "    OPENAI_API_KEY      — OpenAI (GPT-4o, GPT-5, o3, ...)\n" +
        "    GOOGLE_API_KEY      — Google Gemini\n" +
        "    ANTHROPIC_API_KEY   — Anthropic Claude\n" +
        "\n" +
        "  Subscriptions (install CLI tools, auth once):\n" +
        "    npm i -g @google/gemini-cli   → then: gemini auth\n" +
        "    npm i -g @anthropic-ai/claude-code → then: claude\n" +
        "    npm i -g @openai/codex         → then: codex auth\n" +
        "\n" +
        "  Local models:\n" +
        "    Install Ollama → ollama pull llama3\n" +
        "    LM Studio      → LMSTUDIO_URL=http://host:1234 (default: localhost:1234)\n" +
        "\n" +
        "HydraMCP will start anyway and retry on first request."
    );
  } else {
    logger.info(`Providers: ${active.join(", ")}`);
  }

  // Wrap with SmartProvider (orchestrator: circuit breaker, caching, metrics)
  const provider = new SmartProvider(multi);

  const server = createServer(provider);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info(`HydraMCP running — ${active.length} provider(s) active`);
}

main().catch((err) => {
  logger.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

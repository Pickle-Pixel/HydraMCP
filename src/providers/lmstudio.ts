/**
 * LM Studio Backend — uses LM Studio's native REST API at /api/v1/*.
 *
 * Endpoints used:
 *   GET  /api/v1/models   — rich model metadata (type, capabilities, loaded
 *                           instances with their runtime ctx, max ctx)
 *   POST /api/v1/chat     — inference; JIT-loads the model if not loaded
 *
 * This is the LM Studio native API — distinct from their OpenAI-compat
 * surface at /v1/*. It returns local-inference detail the OpenAI shape
 * strips (tokens/sec, time-to-first-token, load time, model instance id).
 *
 * Known limitation — system prompts:
 *   /api/v1/chat accepts `input` as either a string or a message array,
 *   but the message-array content-part discriminator is not documented
 *   on my probed instance and the exact shape couldn't be determined
 *   from error messages. Until that's pinned down we use string `input`
 *   and prepend the system prompt as a framed prefix. Works correctly
 *   for single-turn prompts, which is all HydraMCP's tools currently do.
 *
 * Known limitation — context size:
 *   We report whatever LM Studio has configured. If a model is loaded,
 *   we see `loaded_instances[0].config.context_length`. If it's not,
 *   /api/v1/chat JIT-loads it with whatever default LM Studio was last
 *   set to for that model. To run at larger context, bump it in the
 *   LM Studio UI — we don't force a reload here.
 *
 * Default endpoint: http://localhost:1234
 * Override with LMSTUDIO_URL (e.g. http://192.168.40.10:1234 when
 * LM Studio runs on another machine on the LAN).
 *
 * Optional LMSTUDIO_API_KEY — sent as Bearer token if set. Only needed
 * if LM Studio is behind a reverse proxy that enforces auth.
 */

import { Provider, ModelInfo, QueryOptions, QueryResponse } from "./provider.js";
import { logger } from "../utils/logger.js";

interface LMStudioModel {
  key: string;
  type?: string;
  display_name?: string;
  max_context_length?: number;
  loaded_instances?: Array<{
    id: string;
    config?: { context_length?: number };
  }>;
}

export class LMStudioProvider implements Provider {
  name = "LM Studio";
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = baseUrl ?? process.env.LMSTUDIO_URL ?? "http://localhost:1234";
    this.apiKey = apiKey ?? process.env.LMSTUDIO_API_KEY ?? "";
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    return h;
  }

  /**
   * Fetch with a hard timeout so a dead/unreachable LM Studio can't stall
   * tool calls. list_models waits on this inside Promise.allSettled alongside
   * other providers, so we want it to fail fast.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(
        `${this.baseUrl}/api/v1/models`,
        { headers: this.headers() },
        3_000
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/models`,
      { headers: this.headers() },
      3_000
    );
    if (!res.ok) {
      throw new Error(`LM Studio: failed to list models (${res.status})`);
    }

    const data = (await res.json()) as { models?: LMStudioModel[] };

    // Only chat-capable types. /api/v1/models uses `embedding` (singular)
    // for embedding models; exclude them and anything else non-chat.
    return (data.models ?? [])
      .filter((m) => m.type === "llm" || m.type === "vlm")
      .map((m) => ({ id: m.key, name: m.display_name ?? m.key, provider: "lmstudio" }));
  }

  async query(
    model: string,
    prompt: string,
    options?: QueryOptions
  ): Promise<QueryResponse> {
    const startTime = Date.now();

    // See "Known limitation — system prompts" in the file header.
    const input = options?.system_prompt
      ? `[SYSTEM]\n${options.system_prompt}\n\n[USER]\n${prompt}`
      : prompt;

    const body: Record<string, unknown> = { model, input };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.max_tokens !== undefined) body.max_output_tokens = options.max_tokens;

    const res = await fetch(`${this.baseUrl}/api/v1/chat`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`LM Studio query failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as {
      model_instance_id?: string;
      output?: Array<{ type?: string; content?: string }>;
      stats?: {
        input_tokens?: number;
        total_output_tokens?: number;
        reasoning_output_tokens?: number;
        tokens_per_second?: number;
        time_to_first_token_seconds?: number;
        model_load_time_seconds?: number;
        stop_reason?: string;
      };
      response_id?: string;
    };

    const latency_ms = Date.now() - startTime;

    // /api/v1/chat returns output[] where type="message" holds the assistant
    // content. Reasoning models may also emit type="reasoning" items we skip.
    const message = data.output?.find((o) => o.type === "message" || o.type === undefined);
    const content = message?.content ?? "";

    const prompt_tokens = data.stats?.input_tokens ?? 0;
    const completion_tokens = data.stats?.total_output_tokens ?? 0;

    // Surface LM Studio-only fields via debug log. These don't belong in
    // QueryResponse (which is provider-agnostic) but help diagnose local
    // inference performance.
    if (data.stats) {
      const parts: string[] = [`lmstudio ${model}`];
      if (data.stats.tokens_per_second !== undefined) {
        parts.push(`${data.stats.tokens_per_second.toFixed(1)} tok/s`);
      }
      if (data.stats.time_to_first_token_seconds !== undefined) {
        parts.push(`ttft ${(data.stats.time_to_first_token_seconds * 1000).toFixed(0)}ms`);
      }
      if (data.stats.model_load_time_seconds !== undefined) {
        parts.push(`load ${(data.stats.model_load_time_seconds * 1000).toFixed(0)}ms`);
      }
      logger.debug(parts.join(" | "));
    }

    return {
      model,
      content,
      usage: {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
      },
      latency_ms,
      finish_reason: data.stats?.stop_reason ?? "stop",
    };
  }
}

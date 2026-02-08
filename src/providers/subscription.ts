/**
 * Subscription Provider — use your monthly subscriptions as an API.
 *
 * Reads OAuth tokens stored by CLI tools (Claude Code, Gemini CLI, Codex CLI)
 * and makes direct HTTP requests to provider-internal APIs.
 *
 * Token locations:
 *   Claude  → ~/.claude/.credentials.json
 *   Gemini  → ~/.gemini/oauth_creds.json
 *   Codex   → ~/.codex/auth.json
 *
 * Endpoints (from CLIProxyAPI & Gemini CLI source):
 *   Gemini  → https://cloudcode-pa.googleapis.com/v1internal:generateContent
 *   Codex   → https://chatgpt.com/backend-api/codex/responses (SSE)
 *   Claude  → CLI subprocess (api.anthropic.com rejects OAuth without TLS fingerprint)
 *
 * Approach learned from CLIProxyAPI (github.com/router-for-me/CLIProxyAPI).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { Provider, ModelInfo, QueryOptions, QueryResponse } from "./provider.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  accountId?: string; // Codex: ChatGPT account ID for request header
}

// ---------------------------------------------------------------------------
// Token file readers
// ---------------------------------------------------------------------------

function readClaudeTokens(): OAuthTokens | null {
  try {
    const raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf-8");
    const data = JSON.parse(raw);
    const oauth = data.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt ?? 0,
    };
  } catch {
    return null;
  }
}

function readGeminiTokens(): OAuthTokens | null {
  try {
    const raw = readFileSync(join(homedir(), ".gemini", "oauth_creds.json"), "utf-8");
    const data = JSON.parse(raw);
    if (!data.access_token || !data.refresh_token) return null;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expiry_date ?? 0,
    };
  } catch {
    return null;
  }
}

function readCodexTokens(): OAuthTokens | null {
  try {
    const raw = readFileSync(join(homedir(), ".codex", "auth.json"), "utf-8");
    const data = JSON.parse(raw);
    const tokens = data.tokens;
    if (!tokens?.access_token || !tokens?.refresh_token) return null;
    let expiresAt = 0;
    try {
      const payload = JSON.parse(
        Buffer.from(tokens.access_token.split(".")[1], "base64").toString()
      );
      if (payload.exp) expiresAt = payload.exp * 1000;
    } catch { /* non-JWT or malformed */ }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      accountId: tokens.account_id ?? undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

async function refreshClaudeToken(refreshToken: string): Promise<OAuthTokens | null> {
  try {
    const res = await fetch("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const accessToken = data.access_token as string;
    const newRefresh = data.refresh_token as string;
    const expiresIn = (data.expires_in as number) ?? 86400;
    if (!accessToken) return null;

    try {
      const credPath = join(homedir(), ".claude", ".credentials.json");
      const existing = JSON.parse(readFileSync(credPath, "utf-8"));
      existing.claudeAiOauth.accessToken = accessToken;
      existing.claudeAiOauth.refreshToken = newRefresh || refreshToken;
      existing.claudeAiOauth.expiresAt = Date.now() + expiresIn * 1000;
      writeFileSync(credPath, JSON.stringify(existing), "utf-8");
    } catch { /* non-fatal */ }

    return {
      accessToken,
      refreshToken: newRefresh || refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  } catch {
    return null;
  }
}

async function refreshGeminiToken(refreshToken: string): Promise<OAuthTokens | null> {
  try {
    const body = new URLSearchParams({
      client_id: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
      client_secret: "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",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const accessToken = data.access_token as string;
    const expiresIn = (data.expires_in as number) ?? 3600;
    if (!accessToken) return null;

    try {
      const credPath = join(homedir(), ".gemini", "oauth_creds.json");
      const existing = JSON.parse(readFileSync(credPath, "utf-8"));
      existing.access_token = accessToken;
      existing.expiry_date = Date.now() + expiresIn * 1000;
      if (data.id_token) existing.id_token = data.id_token;
      writeFileSync(credPath, JSON.stringify(existing, null, 2), "utf-8");
    } catch { /* non-fatal */ }

    return {
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  } catch {
    return null;
  }
}

async function refreshCodexToken(refreshToken: string): Promise<OAuthTokens | null> {
  try {
    const body = new URLSearchParams({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    });
    const res = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const accessToken = data.access_token as string;
    const newRefresh = data.refresh_token as string;
    const expiresIn = (data.expires_in as number) ?? 864000;
    if (!accessToken) return null;

    let accountId: string | undefined;
    try {
      const credPath = join(homedir(), ".codex", "auth.json");
      const existing = JSON.parse(readFileSync(credPath, "utf-8"));
      accountId = existing.tokens?.account_id;
      existing.tokens.access_token = accessToken;
      existing.tokens.refresh_token = newRefresh || refreshToken;
      if (data.id_token) existing.tokens.id_token = data.id_token;
      existing.last_refresh = new Date().toISOString();
      writeFileSync(credPath, JSON.stringify(existing, null, 2), "utf-8");
    } catch { /* non-fatal */ }

    return {
      accessToken,
      refreshToken: newRefresh || refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      accountId,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gemini project ID — resolved via Cloud Code Assist loadCodeAssist API
// ---------------------------------------------------------------------------

let cachedGeminiProjectId: string | null = null;

async function getGeminiProjectId(token: string): Promise<string> {
  if (cachedGeminiProjectId) return cachedGeminiProjectId;

  const res = await fetch(
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": "google-api-nodejs-client/9.15.1",
        "X-Goog-Api-Client": "gl-node/22.17.0",
      },
      body: JSON.stringify({
        metadata: {
          ideType: "IDE_UNSPECIFIED",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini loadCodeAssist failed (${res.status}): ${err}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  let projectId: string | null = null;

  if (typeof data.cloudaicompanionProject === "string") {
    projectId = data.cloudaicompanionProject;
  } else if (
    data.cloudaicompanionProject &&
    typeof data.cloudaicompanionProject === "object" &&
    typeof (data.cloudaicompanionProject as Record<string, unknown>).id === "string"
  ) {
    projectId = (data.cloudaicompanionProject as Record<string, unknown>).id as string;
  }
  if (!projectId && Array.isArray(data.allowedTiers)) {
    const defaultTier = (data.allowedTiers as Array<Record<string, unknown>>).find(
      (t) => t.isDefault === true
    );
    if (typeof defaultTier?.id === "string") {
      projectId = defaultTier.id as string;
    }
  }

  if (!projectId) {
    throw new Error(
      "Gemini: no project ID from loadCodeAssist. Run `gemini` CLI once to set up your account."
    );
  }

  cachedGeminiProjectId = projectId;
  logger.info(`Gemini project ID resolved: ${projectId}`);
  return projectId;
}

// ---------------------------------------------------------------------------
// Query: Codex — chatgpt.com/backend-api/codex SSE streaming
// ---------------------------------------------------------------------------

async function queryCodex(
  tokens: OAuthTokens,
  model: string,
  prompt: string,
  options?: QueryOptions
): Promise<QueryResponse> {
  const startTime = Date.now();

  const input: unknown[] = [];
  if (options?.system_prompt) {
    input.push({ role: "developer", content: options.system_prompt });
  }
  input.push({ role: "user", content: prompt });

  const body: Record<string, unknown> = {
    model,
    instructions: "",
    input,
    stream: true,
    store: false,
  };
  // Note: chatgpt.com/backend-api/codex does NOT support temperature or
  // max_output_tokens for Codex reasoning models. Omitting these params.

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${tokens.accessToken}`,
    "Accept": "text/event-stream",
    "Version": "0.98.0",
    "Openai-Beta": "responses=experimental",
    "User-Agent": "codex_cli_rs/0.98.0",
    "Originator": "codex_cli_rs",
    "Connection": "Keep-Alive",
  };
  if (tokens.accountId) {
    headers["Chatgpt-Account-Id"] = tokens.accountId;
  }

  const res = await fetch(
    "https://chatgpt.com/backend-api/codex/responses",
    { method: "POST", headers, body: JSON.stringify(body) }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Codex subscription query failed (${res.status}): ${err}`);
  }

  // Parse SSE stream — look for response.completed event
  const text = await res.text();
  const lines = text.split("\n");
  let content = "";
  let usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined;
  let finishReason: string | undefined;

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (event.type === "response.output_text.done") {
        content += event.text ?? "";
      } else if (event.type === "response.completed") {
        const resp = event.response;
        if (resp?.usage) usage = resp.usage;
        finishReason = resp?.status;
        // Also extract content from completed response if not yet captured
        if (!content && resp?.output) {
          for (const item of resp.output) {
            if (item.type === "message" && item.content) {
              for (const block of item.content) {
                if (block.type === "output_text") content += block.text ?? "";
              }
            }
          }
        }
      }
    } catch { /* skip non-JSON lines */ }
  }

  return {
    model,
    content,
    usage: usage
      ? {
          prompt_tokens: usage.input_tokens ?? 0,
          completion_tokens: usage.output_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        }
      : undefined,
    latency_ms: Date.now() - startTime,
    finish_reason: finishReason,
  };
}

// ---------------------------------------------------------------------------
// Query: Gemini — Cloud Code Assist direct HTTP
// ---------------------------------------------------------------------------

async function queryGemini(
  tokens: OAuthTokens,
  model: string,
  prompt: string,
  options?: QueryOptions
): Promise<QueryResponse> {
  const startTime = Date.now();

  const projectId = await getGeminiProjectId(tokens.accessToken);

  const request: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  };
  if (options?.system_prompt) {
    request.systemInstruction = { parts: [{ text: options.system_prompt }] };
  }
  const genConfig: Record<string, unknown> = {};
  if (options?.temperature !== undefined) genConfig.temperature = options.temperature;
  if (options?.max_tokens !== undefined) genConfig.maxOutputTokens = options.max_tokens;
  if (Object.keys(genConfig).length > 0) request.generationConfig = genConfig;

  const body = { model, project: projectId, request };

  const res = await fetch(
    "https://cloudcode-pa.googleapis.com/v1internal:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${tokens.accessToken}`,
        "User-Agent": "google-api-nodejs-client/9.15.1",
        "X-Goog-Api-Client": "gl-node/22.17.0",
        "Client-Metadata":
          "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini subscription query failed (${res.status}): ${err}`);
  }

  // Cloud Code Assist wraps the standard Gemini response in a "response" field
  const data = (await res.json()) as Record<string, unknown>;
  const inner = (data.response ?? data) as Record<string, unknown>;

  const candidates = inner.candidates as Array<Record<string, unknown>> | undefined;
  const parts = (candidates?.[0]?.content as Record<string, unknown>)?.parts as
    | Array<{ text?: string }>
    | undefined;
  const content = parts?.map((p) => p.text ?? "").join("") ?? "";
  const meta = inner.usageMetadata as Record<string, number> | undefined;

  return {
    model,
    content,
    usage: meta
      ? {
          prompt_tokens: meta.promptTokenCount ?? 0,
          completion_tokens: meta.candidatesTokenCount ?? 0,
          total_tokens: meta.totalTokenCount ?? 0,
        }
      : undefined,
    latency_ms: Date.now() - startTime,
    finish_reason: (candidates?.[0]?.finishReason as string) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Query: Claude — CLI subprocess (api.anthropic.com requires TLS fingerprint
// bypass for OAuth tokens, which needs Go's utls library. Node.js can't do it
// natively, so we use the Claude CLI as a subprocess.)
// ---------------------------------------------------------------------------

function execCLI(
  command: string,
  args: string[],
  stdinData?: string,
  timeoutMs = 120_000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const proc = spawn(command, args, {
      shell: isWin,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ stdout, stderr: stderr + "\n[TIMEOUT]", code: 124 });
    }, timeoutMs);

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, code: 1 });
    });

    if (stdinData && proc.stdin) {
      proc.stdin.write(stdinData);
      proc.stdin.end();
    }
  });
}

async function queryClaude(
  _tokens: OAuthTokens,
  model: string,
  prompt: string,
  options?: QueryOptions
): Promise<QueryResponse> {
  const startTime = Date.now();

  const args = [
    "--output-format", "json",
    "-p", "-", // Read prompt from stdin
    "--model", model,
  ];
  if (options?.max_tokens) args.push("--max-tokens", String(options.max_tokens));

  const result = await execCLI("claude", args, prompt, 120_000);

  if (result.code !== 0) {
    throw new Error(
      `Claude CLI failed (code ${result.code}): ${result.stderr.substring(0, 200)}`
    );
  }

  // Parse JSON output from claude --output-format json
  let content = "";
  try {
    const data = JSON.parse(result.stdout);
    if (typeof data.result === "string") {
      content = data.result;
    } else if (typeof data.content === "string") {
      content = data.content;
    } else if (Array.isArray(data.content)) {
      content = data.content
        .filter((b: Record<string, unknown>) => b.type === "text")
        .map((b: Record<string, unknown>) => b.text ?? "")
        .join("");
    } else {
      content = result.stdout;
    }
  } catch {
    content = result.stdout;
  }

  return {
    model,
    content,
    latency_ms: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Fallback model lists (used when dynamic discovery fails)
// ---------------------------------------------------------------------------

const CODEX_FALLBACK_MODELS: Array<{ id: string; name: string }> = [
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
];

const GEMINI_FALLBACK_MODELS: Array<{ id: string; name: string }> = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
];

const CLAUDE_FALLBACK_MODELS: Array<{ id: string; name: string }> = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5" },
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
  { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku" },
];

// ---------------------------------------------------------------------------
// Dynamic model discovery
// ---------------------------------------------------------------------------

function formatModelName(slug: string): string {
  return slug
    .split("-")
    .map((w) => {
      if (w === "gpt") return "GPT";
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/** Read Codex models from ~/.codex/models_cache.json (written by Codex CLI). */
function discoverCodexModels(): Array<{ id: string; name: string }> {
  try {
    const raw = readFileSync(
      join(homedir(), ".codex", "models_cache.json"),
      "utf-8"
    );
    const data = JSON.parse(raw);
    if (!Array.isArray(data.models)) return CODEX_FALLBACK_MODELS;
    const models = data.models
      .filter((m: Record<string, unknown>) => m.visibility === "list")
      .map((m: Record<string, unknown>) => ({
        id: m.slug as string,
        name: formatModelName(m.slug as string),
      }));
    if (models.length > 0) {
      logger.info(`Codex: discovered ${models.length} models from cache`);
      return models;
    }
    return CODEX_FALLBACK_MODELS;
  } catch {
    return CODEX_FALLBACK_MODELS;
  }
}

/** Fetch available models from Cloud Code Assist. May include Claude models. */
async function discoverGeminiModels(token: string): Promise<{
  geminiModels: Array<{ id: string; name: string }>;
  claudeViaGemini: Array<{ id: string; name: string }>;
}> {
  const fallback = { geminiModels: GEMINI_FALLBACK_MODELS, claudeViaGemini: [] };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(
      "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "google-api-nodejs-client/9.15.1",
          "X-Goog-Api-Client": "gl-node/22.17.0",
        },
        body: "{}",
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);
    if (!res.ok) return fallback;

    const data = (await res.json()) as Record<string, unknown>;
    const models = data.models as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(models) || models.length === 0) return fallback;

    const geminiModels: Array<{ id: string; name: string }> = [];
    const claudeViaGemini: Array<{ id: string; name: string }> = [];

    for (const m of models) {
      const id = m.name as string;
      if (!id) continue;
      const entry = { id, name: formatModelName(id) };
      if (id.startsWith("claude-")) {
        claudeViaGemini.push(entry);
      } else {
        geminiModels.push(entry);
      }
    }

    logger.info(
      `Gemini: discovered ${geminiModels.length} Gemini + ${claudeViaGemini.length} Claude models from Cloud Code Assist`
    );
    return {
      geminiModels: geminiModels.length > 0 ? geminiModels : GEMINI_FALLBACK_MODELS,
      claudeViaGemini,
    };
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Backend definitions
// ---------------------------------------------------------------------------

interface SubBackend {
  id: string;
  displayName: string;
  readTokens: () => OAuthTokens | null;
  refreshTokens: (refreshToken: string) => Promise<OAuthTokens | null>;
  query: (
    tokens: OAuthTokens,
    model: string,
    prompt: string,
    options?: QueryOptions
  ) => Promise<QueryResponse>;
  models: Array<{ id: string; name: string }>; // Populated during detect()
}

const CLAUDE_BACKEND: SubBackend = {
  id: "claude-sub",
  displayName: "Claude (subscription)",
  readTokens: readClaudeTokens,
  refreshTokens: refreshClaudeToken,
  query: queryClaude,
  models: [],
};

const GEMINI_BACKEND: SubBackend = {
  id: "gemini-sub",
  displayName: "Gemini (subscription)",
  readTokens: readGeminiTokens,
  refreshTokens: refreshGeminiToken,
  query: queryGemini,
  models: [],
};

const CODEX_BACKEND: SubBackend = {
  id: "codex-sub",
  displayName: "Codex (subscription)",
  readTokens: readCodexTokens,
  refreshTokens: refreshCodexToken,
  query: queryCodex,
  models: [],
};

// ---------------------------------------------------------------------------
// SubscriptionProvider
// ---------------------------------------------------------------------------

export class SubscriptionProvider implements Provider {
  name = "Subscription";
  private backends: SubBackend[] = [];
  private modelToBackend = new Map<string, SubBackend>();
  private tokenCache = new Map<string, OAuthTokens>();

  async detect(): Promise<number> {
    // --- Gemini: dynamic discovery via fetchAvailableModels ---
    const geminiTokens = readGeminiTokens();
    let claudeViaGeminiModels: Array<{ id: string; name: string }> = [];

    if (geminiTokens) {
      const { geminiModels, claudeViaGemini } = await discoverGeminiModels(
        geminiTokens.accessToken
      );
      GEMINI_BACKEND.models = geminiModels;
      claudeViaGeminiModels = claudeViaGemini;

      // Register Claude models served through Cloud Code Assist (direct HTTP, faster than CLI)
      for (const model of claudeViaGeminiModels) {
        GEMINI_BACKEND.models.push(model);
      }

      this.backends.push(GEMINI_BACKEND);
      this.tokenCache.set(GEMINI_BACKEND.id, geminiTokens);
      for (const model of GEMINI_BACKEND.models) {
        this.modelToBackend.set(model.id, GEMINI_BACKEND);
      }
      logger.info(
        `Subscription: ${GEMINI_BACKEND.displayName} — ${geminiModels.length} Gemini` +
          (claudeViaGeminiModels.length > 0
            ? ` + ${claudeViaGeminiModels.length} Claude via Cloud Code Assist`
            : "")
      );
    }

    // --- Codex: dynamic discovery from ~/.codex/models_cache.json ---
    const codexTokens = readCodexTokens();
    if (codexTokens) {
      CODEX_BACKEND.models = discoverCodexModels();
      this.backends.push(CODEX_BACKEND);
      this.tokenCache.set(CODEX_BACKEND.id, codexTokens);
      for (const model of CODEX_BACKEND.models) {
        this.modelToBackend.set(model.id, CODEX_BACKEND);
      }
      logger.info(
        `Subscription: ${CODEX_BACKEND.displayName} — ${CODEX_BACKEND.models.length} models`
      );
    }

    // --- Claude: expanded hardcoded list, skip models already available via Gemini ---
    const claudeTokens = readClaudeTokens();
    if (claudeTokens) {
      CLAUDE_BACKEND.models = CLAUDE_FALLBACK_MODELS.filter(
        (m) => !this.modelToBackend.has(m.id)
      );
      if (CLAUDE_BACKEND.models.length > 0) {
        this.backends.push(CLAUDE_BACKEND);
        this.tokenCache.set(CLAUDE_BACKEND.id, claudeTokens);
        for (const model of CLAUDE_BACKEND.models) {
          this.modelToBackend.set(model.id, CLAUDE_BACKEND);
        }
        logger.info(
          `Subscription: ${CLAUDE_BACKEND.displayName} — ${CLAUDE_BACKEND.models.length} models (CLI fallback)`
        );
      }
    }

    return this.backends.length;
  }

  async healthCheck(): Promise<boolean> {
    return this.backends.length > 0;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.backends.flatMap((b) =>
      b.models.map((m) => ({
        id: m.id,
        name: `${m.name} (${b.displayName})`,
        provider: b.id,
      }))
    );
  }

  async query(
    model: string,
    prompt: string,
    options?: QueryOptions
  ): Promise<QueryResponse> {
    const backend = this.modelToBackend.get(model);
    if (!backend) {
      const match = this.backends.find((b) =>
        b.models.some((m) => model.includes(m.id) || m.id.includes(model))
      );
      if (!match) {
        throw new Error(
          `No subscription handles model "${model}". ` +
            `Available: ${[...this.modelToBackend.keys()].join(", ")}`
        );
      }
      return this.runQuery(match, model, prompt, options);
    }
    return this.runQuery(backend, model, prompt, options);
  }

  private async runQuery(
    backend: SubBackend,
    model: string,
    prompt: string,
    options?: QueryOptions
  ): Promise<QueryResponse> {
    let tokens = this.tokenCache.get(backend.id);
    if (!tokens) {
      const fresh = backend.readTokens();
      if (!fresh) throw new Error(`${backend.displayName}: no tokens found`);
      tokens = fresh;
      this.tokenCache.set(backend.id, tokens);
    }

    // Refresh if expired (with 60s buffer)
    if (tokens.expiresAt > 0 && tokens.expiresAt < Date.now() + 60_000) {
      logger.info(`Subscription: refreshing ${backend.displayName} token`);
      const refreshed = await backend.refreshTokens(tokens.refreshToken);
      if (refreshed) {
        tokens = refreshed;
        this.tokenCache.set(backend.id, tokens);
      } else {
        logger.warn(
          `Subscription: ${backend.displayName} token refresh failed, trying existing token`
        );
      }
    }

    return backend.query(tokens, model, prompt, options);
  }
}

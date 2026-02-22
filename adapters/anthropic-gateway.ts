// Main Fastify server that routes requests by provider prefix
import Fastify from "fastify";
import { parseProviderModel, warnIfTools } from "./map.js";
import type { AnthropicRequest, ProviderModel } from "./types.js";
import { chatOpenRouter } from "./providers/openrouter.js";
import { chatGeminiOAuth } from "./providers/gemini-oauth.js";
import { chatCodexOAuth } from "./providers/codex-oauth.js";
import { passThrough } from "./providers/anthropic-pass.js";
import { preprocessImages } from "./vision-preprocess.js";
import {
  buildLoginUrl,
  handleOAuthCallback,
  getLoginStatus,
  googleLogout,
  loginPage,
} from "./google-auth.js";
import {
  buildCodexLoginUrl,
  handleCodexOAuthCallback,
  getCodexLoginStatus,
  codexLogout,
  codexLoginPage,
} from "./openai-auth.js";
import { writePid, registerCleanup } from "./pid-manager.js";
import { config } from "dotenv";
import { join } from "path";
import { homedir } from "os";

// Load .env from ~/.claude-proxy/.env
const envPath = join(homedir(), ".claude-proxy", ".env");
config({ path: envPath });

const PORT = Number(process.env.CLAUDE_PROXY_PORT || 17870);

// Support default provider from CLI commands (claude-codex, claude-gemini)
const defaultProvider = process.env.CCX_DEFAULT_PROVIDER as import("./types.js").ProviderKey | undefined;
const defaultModel = process.env.CCX_DEFAULT_MODEL;

let active: ProviderModel | null = defaultProvider && defaultModel
  ? { provider: defaultProvider, model: defaultModel }
  : null;

const fastify = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });

// startedAt captured at module load = process birth time
const startedAt = Date.now();

// Health check - returns pid + startedAt so CLI can cross-verify against PID lock
fastify.get("/healthz", async () => ({
  ok: true,
  pid: process.pid,
  startedAt,
  active: active ?? { provider: "glm", model: "auto" }
}));

// Status endpoint (shows current active provider/model)
fastify.get("/_status", async () => {
  return active ?? { provider: "glm", model: "glm-5" };
});

// ── Google OAuth endpoints ─────────────────────────────────────────────

// Landing page with sign-in button
fastify.get("/google/login", async (_req, reply) => {
  reply.type("text/html").send(loginPage(PORT));
});

// Start OAuth flow (redirects to Google)
fastify.get("/google/login/start", async (_req, reply) => {
  const authUrl = buildLoginUrl(PORT);
  reply.redirect(authUrl);
});

// OAuth callback (receives auth code from Google)
fastify.get("/google/callback", async (req, reply) => {
  const query = req.query as Record<string, string>;
  const { code, state, error } = query;

  if (error) {
    return reply.type("text/html").code(400).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Login Failed</h1><p>${error}</p>
        <a href="/google/login" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }

  if (!code || !state) {
    return reply.type("text/html").code(400).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Missing Parameters</h1><p>No authorization code received.</p>
        <a href="/google/login" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }

  try {
    const tokens = await handleOAuthCallback(code, state);
    reply.type("text/html").send(
      `<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;">
        <div style="text-align:center;color:#e2e8f0;max-width:500px;">
          <div style="font-size:48px;">&#10003;</div>
          <h1 style="color:#4ade80;">Authenticated Successfully</h1>
          <p>Logged in as: <strong>${tokens.email || "unknown"}</strong></p>
          ${tokens.project_id ? `<p>Code Assist Project: <code style="background:#1e293b;padding:2px 8px;border-radius:4px;">${tokens.project_id}</code></p>` : `<p style="color:#94a3b8;">Using standard Generative Language API</p>`}
          <p style="color:#64748b;margin-top:24px;">You can close this window.<br>Use <code style="background:#1e293b;padding:2px 8px;border-radius:4px;">go:gemini-3.1-pro-preview</code> as your model in Claude Code.</p>
        </div>
      </body></html>`
    );
  } catch (e: any) {
    reply.type("text/html").code(500).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Login Failed</h1><p>${e.message}</p>
        <a href="/google/login" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }
});

// Login status
fastify.get("/google/status", async () => {
  return getLoginStatus();
});

// Logout
fastify.post("/google/logout", async () => {
  await googleLogout();
  return { ok: true, message: "Logged out of Google" };
});

// ── OpenAI/Codex OAuth endpoints ──────────────────────────────────────

// Landing page with sign-in button
fastify.get("/codex/login", async (_req, reply) => {
  reply.type("text/html").send(codexLoginPage());
});

// Start OAuth flow (redirects to OpenAI)
fastify.get("/codex/login/start", async (_req, reply) => {
  const authUrl = buildCodexLoginUrl(PORT);
  reply.redirect(authUrl);
});

// OAuth callback (receives auth code from OpenAI)
fastify.get("/codex/callback", async (req, reply) => {
  const query = req.query as Record<string, string>;
  const { code, state, error } = query;

  if (error) {
    return reply.type("text/html").code(400).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Login Failed</h1><p>${error}</p>
        <a href="/codex/login" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }

  if (!code || !state) {
    return reply.type("text/html").code(400).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Missing Parameters</h1><p>No authorization code received.</p>
        <a href="/codex/login" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }

  try {
    const tokens = await handleCodexOAuthCallback(code, state);
    reply.type("text/html").send(
      `<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;">
        <div style="text-align:center;color:#e2e8f0;max-width:500px;">
          <div style="font-size:48px;">&#10003;</div>
          <h1 style="color:#4ade80;">OpenAI Authenticated</h1>
          <p>Logged in as: <strong>${tokens.email || "unknown"}</strong></p>
          <p>Plan: <strong style="color:#a78bfa;">${tokens.plan || "unknown"}</strong></p>
          <p style="color:#64748b;margin-top:24px;">You can close this window.<br>Use <code style="background:#1e293b;padding:2px 8px;border-radius:4px;">codex</code> as your model in Claude Code.</p>
        </div>
      </body></html>`
    );
  } catch (e: any) {
    reply.type("text/html").code(500).send(
      `<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0;">
        <h1 style="color:#f87171;">Login Failed</h1><p>${e.message}</p>
        <a href="/codex/login" style="color:#60a5fa;">Try again</a>
      </body></html>`
    );
  }
});

// Codex login status
fastify.get("/codex/status", async () => {
  return getCodexLoginStatus();
});

// Codex logout
fastify.post("/codex/logout", async () => {
  await codexLogout();
  return { ok: true, message: "Logged out of OpenAI" };
});

// Main messages endpoint - routes by model prefix
fastify.post("/v1/messages", async (req, res) => {
  try {
    const body = req.body as AnthropicRequest;
    const defaults = active ?? undefined;
    const { provider, model, reasoning } = parseProviderModel(body.model, defaults);

    // Log every request for debugging
    const tools = body.tools?.map((t: any) => t.name).join(",") || "none";
    const hasSystem = !!body.system;
    const msgCount = body.messages?.length || 0;
    console.log(`[ccx] REQUEST: model="${body.model}" → provider="${provider}" model="${model}"${reasoning ? ` reasoning=${reasoning}` : ""} | tools=[${tools}] system=${hasSystem} messages=${msgCount}`);

    // Warn if using tools with providers that may not support them
    warnIfTools(body, provider);

    // Don't let internal Claude Code requests (haiku for titles, etc.) override the user's active model
    if (provider !== "anthropic") {
      active = { provider, model };
    }

    // Validate API keys BEFORE setting headers
    if (provider === "openai") {
      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        throw apiError(401, "OPENAI_API_KEY not set in ~/.claude-proxy/.env");
      }
      res.raw.setHeader("Content-Type", "text/event-stream");
      res.raw.setHeader("Cache-Control", "no-cache, no-transform");
      res.raw.setHeader("Connection", "keep-alive");
      // @ts-ignore
      res.raw.flushHeaders?.();
      return chatCodexOAuth(res, body, model, key, reasoning);
    }

    if (provider === "openrouter") {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) {
        throw apiError(401, "OPENROUTER_API_KEY not set in ~/.claude-proxy/.env");
      }
      res.raw.setHeader("Content-Type", "text/event-stream");
      res.raw.setHeader("Cache-Control", "no-cache, no-transform");
      res.raw.setHeader("Connection", "keep-alive");
      // @ts-ignore
      res.raw.flushHeaders?.();
      return chatOpenRouter(res, body, model, key);
    }

    if (provider === "gemini-oauth") {
      res.raw.setHeader("Content-Type", "text/event-stream");
      res.raw.setHeader("Cache-Control", "no-cache, no-transform");
      res.raw.setHeader("Connection", "keep-alive");
      // @ts-ignore
      res.raw.flushHeaders?.();
      return chatGeminiOAuth(res, body, model, undefined, reasoning);
    }

    if (provider === "codex-oauth") {
      res.raw.setHeader("Content-Type", "text/event-stream");
      res.raw.setHeader("Cache-Control", "no-cache, no-transform");
      res.raw.setHeader("Connection", "keep-alive");
      // @ts-ignore
      res.raw.flushHeaders?.();
      return chatCodexOAuth(res, body, model, undefined, reasoning);
    }

    if (provider === "gemini") {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        throw apiError(401, "GEMINI_API_KEY not set in ~/.claude-proxy/.env");
      }
      res.raw.setHeader("Content-Type", "text/event-stream");
      res.raw.setHeader("Cache-Control", "no-cache, no-transform");
      res.raw.setHeader("Connection", "keep-alive");
      // @ts-ignore
      res.raw.flushHeaders?.();
      return chatGeminiOAuth(res, body, model, key, reasoning);
    }

    if (provider === "anthropic") {
      const base = process.env.ANTHROPIC_UPSTREAM_URL;
      const key = process.env.ANTHROPIC_API_KEY;
      if (!base || !key) {
        throw apiError(
          500,
          "ANTHROPIC_UPSTREAM_URL and ANTHROPIC_API_KEY not set in ~/.claude-proxy/.env"
        );
      }
      // Don't set headers here - passThrough will do it after validation
      return passThrough({
        res,
        body,
        model,
        baseUrl: base,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": process.env.ANTHROPIC_VERSION || "2023-06-01"
        }
      });
    }

    // Default: glm (Z.AI)
    const glmBase = process.env.GLM_UPSTREAM_URL;
    const glmKey = process.env.ZAI_API_KEY || process.env.GLM_API_KEY;
    if (!glmBase || !glmKey) {
      throw apiError(
        500,
        "GLM_UPSTREAM_URL and ZAI_API_KEY not set in ~/.claude-proxy/.env. Run: ccx --setup"
      );
    }
    // Convert images to text descriptions since GLM doesn't support vision
    await preprocessImages(body, process.env.OPENROUTER_API_KEY);
    // Don't set headers here - passThrough will do it after validation
    return passThrough({
      res,
      body,
      model,
      baseUrl: glmBase,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${glmKey}`,
        "anthropic-version": process.env.ANTHROPIC_VERSION || "2023-06-01"
      }
    });
  } catch (e: any) {
    const status = e?.statusCode ?? 500;
    const msg = e?.message || "proxy error";
    console.error(`[ccx] ERROR: ${msg}`);

    // If SSE headers already sent, we can't send a JSON error - write error as SSE event
    if (res.raw.headersSent) {
      try {
        res.raw.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: msg } })}\n\n`);
        res.raw.end();
      } catch { /* stream already closed */ }
      return;
    }
    return res.code(status).send({ error: msg });
  }
});

function apiError(status: number, message: string) {
  const e = new Error(message);
  // @ts-ignore
  e.statusCode = status;
  return e;
}

registerCleanup();

fastify
  .listen({ port: PORT, host: "127.0.0.1" })
  .then(async () => {
    await writePid();
    console.log(`[ccx] Proxy listening on http://127.0.0.1:${PORT} (PID ${process.pid})`);
    console.log(`[ccx] Configure API keys in: ${envPath}`);

    if (active) {
      console.log(`[ccx] Default provider: ${active.provider}:${active.model}`);
    }

    // Show Google login status
    const gStatus = await getLoginStatus();
    if (gStatus.loggedIn) {
      console.log(`[ccx] Google: logged in as ${gStatus.email || "unknown"} (${gStatus.mode})`);
    } else {
      console.log(`[ccx] Google: not logged in. Visit http://127.0.0.1:${PORT}/google/login to authenticate`);
    }

    // Show Codex/OpenAI login status
    const cStatus = await getCodexLoginStatus();
    if (cStatus.loggedIn) {
      console.log(`[ccx] OpenAI: logged in as ${cStatus.email || "unknown"} (${cStatus.plan || "unknown"}) via ${cStatus.source}`);
    } else {
      console.log(`[ccx] OpenAI: not logged in. Visit http://127.0.0.1:${PORT}/codex/login or use Codex CLI`);
    }
  })
  .catch((err) => {
    console.error("[ccx] Failed to start proxy:", err.message);
    process.exit(1);
  });

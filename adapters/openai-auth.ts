// OpenAI OAuth 2.0 authentication for Codex
// Reads existing Codex CLI tokens from ~/.codex/auth.json or our own ~/.claude-proxy/codex-oauth.json
// Supports auto-refresh and browser-based PKCE login flow

import * as http from "http";
import * as crypto from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

// ── OAuth constants (from Codex CLI) ──────────────────────────────────

const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_ENDPOINT = "https://auth.openai.com/oauth/authorize";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"];

// ── Storage paths ─────────────────────────────────────────────────────

const CODEX_AUTH_FILE = join(homedir(), ".codex", "auth.json");
const PROXY_DIR = join(homedir(), ".claude-proxy");
const PROXY_AUTH_FILE = join(PROXY_DIR, "codex-oauth.json");

// ── Types ─────────────────────────────────────────────────────────────

export interface CodexTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // timestamp in ms
  email?: string;
  plan?: string;
  account_id?: string;
}

// ── JWT decode (no library needed) ────────────────────────────────────

function decodeJwtPayload(token: string): any {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// ── Token loading ─────────────────────────────────────────────────────

/** Load tokens from our proxy storage */
async function loadProxyTokens(): Promise<CodexTokens | null> {
  try {
    const data = await readFile(PROXY_AUTH_FILE, "utf-8");
    const parsed = JSON.parse(data);
    if (!parsed.access_token || !parsed.refresh_token) return null;
    return parsed as CodexTokens;
  } catch {
    return null;
  }
}

/** Load tokens from Codex CLI's auth.json */
async function loadCodexCliTokens(): Promise<CodexTokens | null> {
  try {
    const data = await readFile(CODEX_AUTH_FILE, "utf-8");
    const parsed = JSON.parse(data);
    const tokens = parsed.tokens;
    if (!tokens?.access_token || !tokens?.refresh_token) return null;

    // Decode JWT to get expiry and user info
    const payload = decodeJwtPayload(tokens.access_token);
    const idPayload = decodeJwtPayload(tokens.id_token);

    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: payload?.exp ? payload.exp * 1000 : 0,
      email: idPayload?.email || payload?.["https://api.openai.com/profile"]?.email,
      plan: payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type,
      account_id: tokens.account_id,
    };
  } catch {
    return null;
  }
}

/** Load tokens - tries proxy storage first, falls back to Codex CLI */
export async function loadTokens(): Promise<CodexTokens | null> {
  return (await loadProxyTokens()) || (await loadCodexCliTokens());
}

async function saveTokens(tokens: CodexTokens): Promise<void> {
  await mkdir(PROXY_DIR, { recursive: true });
  await writeFile(PROXY_AUTH_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

// ── Token refresh ─────────────────────────────────────────────────────

async function refreshAccessToken(
  refreshToken: string
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  // Codex CLI sends refresh as JSON (not form-encoded)
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI token refresh failed (${resp.status}): ${text}`);
  }

  return (await resp.json()) as { access_token: string; refresh_token?: string; expires_in: number };
}

/** Get the ChatGPT account ID (needed for ChatGPT-Account-ID header) */
export function getCodexAccountId(): string | null {
  // Synchronously read from cache or files
  try {
    const fs = require("fs");
    // Try proxy tokens first
    try {
      const data = JSON.parse(fs.readFileSync(PROXY_AUTH_FILE, "utf-8"));
      if (data.account_id) return data.account_id;
    } catch {}
    // Fall back to Codex CLI tokens
    try {
      const data = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, "utf-8"));
      if (data.tokens?.account_id) return data.tokens.account_id;
      // Also try to extract from JWT
      if (data.tokens?.access_token) {
        const payload = decodeJwtPayload(data.tokens.access_token);
        const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
        if (accountId) return accountId;
      }
    } catch {}
    return null;
  } catch {
    return null;
  }
}

/** Get a valid access token, auto-refreshing if needed */
export async function getCodexAccessToken(): Promise<string> {
  const tokens = await loadTokens();
  if (!tokens) {
    throw new Error(
      "Not logged in to OpenAI. Run `claude-codex` to authenticate, or log in via Codex CLI."
    );
  }

  // Refresh if expired or within 5-minute buffer
  if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
    console.log("[codex-oauth] Access token expired, refreshing...");
    try {
      const refreshed = await refreshAccessToken(tokens.refresh_token);
      tokens.access_token = refreshed.access_token;
      if (refreshed.refresh_token) {
        tokens.refresh_token = refreshed.refresh_token;
      }

      // Decode new JWT for expiry
      const payload = decodeJwtPayload(refreshed.access_token);
      tokens.expires_at = payload?.exp
        ? payload.exp * 1000
        : Date.now() + (refreshed.expires_in || 3600) * 1000;

      await saveTokens(tokens);
      console.log("[codex-oauth] Token refreshed successfully");
    } catch (e: any) {
      throw new Error(
        `OpenAI token refresh failed: ${e.message}. Please re-login with claude-codex.`
      );
    }
  }

  return tokens.access_token;
}

// ── Login status ──────────────────────────────────────────────────────

export async function getCodexLoginStatus(): Promise<{
  loggedIn: boolean;
  email?: string;
  plan?: string;
  accountId?: string;
  expiresAt?: number;
  source?: string;
}> {
  // Check proxy storage first
  const proxyTokens = await loadProxyTokens();
  if (proxyTokens) {
    return {
      loggedIn: true,
      email: proxyTokens.email,
      plan: proxyTokens.plan,
      accountId: proxyTokens.account_id,
      expiresAt: proxyTokens.expires_at,
      source: "proxy",
    };
  }

  // Fall back to Codex CLI
  const cliTokens = await loadCodexCliTokens();
  if (cliTokens) {
    return {
      loggedIn: true,
      email: cliTokens.email,
      plan: cliTokens.plan,
      accountId: cliTokens.account_id,
      expiresAt: cliTokens.expires_at,
      source: "codex-cli",
    };
  }

  return { loggedIn: false };
}

// ── Logout ────────────────────────────────────────────────────────────

export async function codexLogout(): Promise<void> {
  try {
    const { unlink } = await import("fs/promises");
    await unlink(PROXY_AUTH_FILE);
    console.log("[codex-oauth] Logged out, proxy credentials removed.");
  } catch {
    console.log("[codex-oauth] Already logged out (no proxy tokens).");
  }
}

// ── PKCE helpers ──────────────────────────────────────────────────────

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

// ── Browser opener ────────────────────────────────────────────────────

function openBrowser(url: string) {
  try {
    if (process.platform === "darwin") {
      execSync(`open "${url}"`);
    } else if (process.platform === "win32") {
      execSync(`start "" "${url}"`);
    } else {
      execSync(`xdg-open "${url}"`);
    }
  } catch {
    // Browser open failed - URL is shown in console anyway
  }
}

// ── Standalone login (browser-based OAuth from terminal) ──────────────

export async function codexLoginStandalone(): Promise<CodexTokens> {
  // Find an available port for callback
  const port = await new Promise<number>((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolve(p));
      } else {
        reject(new Error("Could not find available port"));
      }
    });
  });

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = crypto.randomBytes(32).toString("hex");
  const { verifier, challenge } = generatePKCE();

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
    // Match Codex CLI's special parameters for API access
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  });

  const authUrl = `${AUTH_ENDPOINT}?${params}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      try {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(codexErrorPage(`OAuth error: ${error}`));
          clearTimeout(timeout);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(codexErrorPage("State mismatch - possible CSRF attack"));
          clearTimeout(timeout);
          server.close();
          reject(new Error("OAuth state mismatch"));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(codexErrorPage("No authorization code received"));
          clearTimeout(timeout);
          server.close();
          reject(new Error("No authorization code"));
          return;
        }

        // Exchange code for tokens
        const tokenResp = await fetch(TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: OAUTH_CLIENT_ID,
            code,
            code_verifier: verifier,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
          }),
        });

        if (!tokenResp.ok) {
          const text = await tokenResp.text();
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(codexErrorPage(`Token exchange failed: ${text}`));
          clearTimeout(timeout);
          server.close();
          reject(new Error(`Token exchange failed: ${text}`));
          return;
        }

        const tokenData = (await tokenResp.json()) as any;

        // Decode JWT for user info
        const payload = decodeJwtPayload(tokenData.access_token);
        const idPayload = decodeJwtPayload(tokenData.id_token);

        const tokens: CodexTokens = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: payload?.exp
            ? payload.exp * 1000
            : Date.now() + (tokenData.expires_in || 3600) * 1000,
          email: idPayload?.email || payload?.["https://api.openai.com/profile"]?.email,
          plan: payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type,
          account_id: payload?.["https://api.openai.com/auth"]?.chatgpt_account_id,
        };

        await saveTokens(tokens);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(codexSuccessPage(tokens.email, tokens.plan));

        clearTimeout(timeout);
        server.close();
        resolve(tokens);
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(codexErrorPage(e.message));
        clearTimeout(timeout);
        server.close();
        reject(e);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`\n[codex-oauth] Opening browser for OpenAI login...`);
      console.log(`[codex-oauth] If browser doesn't open, visit:`);
      console.log(`  ${authUrl}\n`);
      openBrowser(authUrl);
    });
  });
}

// ── Proxy-integrated login (via Fastify routes) ───────────────────────

let pendingOAuth: {
  state: string;
  verifier: string;
  redirectUri: string;
} | null = null;

/** Build the OpenAI OAuth authorization URL (for proxy-integrated login) */
export function buildCodexLoginUrl(proxyPort: number): string {
  const redirectUri = `http://127.0.0.1:${proxyPort}/codex/callback`;
  const state = crypto.randomBytes(32).toString("hex");
  const { verifier, challenge } = generatePKCE();

  pendingOAuth = { state, verifier, redirectUri };

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
    // Match Codex CLI's special parameters for API access
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  });

  return `${AUTH_ENDPOINT}?${params}`;
}

/** Handle OAuth callback (for proxy-integrated login) */
export async function handleCodexOAuthCallback(
  code: string,
  state: string
): Promise<CodexTokens> {
  if (!pendingOAuth) {
    throw new Error("No pending OAuth flow. Visit /codex/login first.");
  }

  if (state !== pendingOAuth.state) {
    pendingOAuth = null;
    throw new Error("OAuth state mismatch - possible CSRF attack.");
  }

  const { verifier, redirectUri } = pendingOAuth;
  pendingOAuth = null;

  const tokenResp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResp.ok) {
    const text = await tokenResp.text();
    throw new Error(`Token exchange failed (${tokenResp.status}): ${text}`);
  }

  const tokenData = (await tokenResp.json()) as any;

  const payload = decodeJwtPayload(tokenData.access_token);
  const idPayload = decodeJwtPayload(tokenData.id_token);

  const tokens: CodexTokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: payload?.exp
      ? payload.exp * 1000
      : Date.now() + (tokenData.expires_in || 3600) * 1000,
    email: idPayload?.email || payload?.["https://api.openai.com/profile"]?.email,
    plan: payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type,
    account_id: payload?.["https://api.openai.com/auth"]?.chatgpt_account_id,
  };

  await saveTokens(tokens);

  console.log(
    `[codex-oauth] Login successful! Email: ${tokens.email || "unknown"}, Plan: ${tokens.plan || "unknown"}`
  );

  return tokens;
}

// ── HTML pages ────────────────────────────────────────────────────────

function codexSuccessPage(email?: string, plan?: string): string {
  return `<!DOCTYPE html>
<html><head><title>Login Successful</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;">
<div style="text-align:center;color:#e2e8f0;max-width:500px;">
  <div style="font-size:48px;margin-bottom:16px;">&#10003;</div>
  <h1 style="color:#4ade80;margin:0 0 12px;">OpenAI Authenticated</h1>
  <p>Logged in as: <strong>${email || "unknown"}</strong></p>
  <p>Plan: <strong style="color:#a78bfa;">${plan || "unknown"}</strong></p>
  <p style="color:#64748b;margin-top:24px;">You can close this window.<br>Use <code style="background:#1e293b;padding:2px 8px;border-radius:4px;">codex</code> as your model in Claude Code.</p>
</div>
</body></html>`;
}

function codexErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html><head><title>Login Failed</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;">
<div style="text-align:center;color:#e2e8f0;max-width:500px;">
  <div style="font-size:48px;margin-bottom:16px;">&#10007;</div>
  <h1 style="color:#f87171;margin:0 0 12px;">Authentication Failed</h1>
  <p>${message}</p>
  <p style="color:#64748b;margin-top:24px;">Please try again at <a href="/codex/login" style="color:#60a5fa;">/codex/login</a></p>
</div>
</body></html>`;
}

export function codexLoginPage(): string {
  return `<!DOCTYPE html>
<html><head><title>OpenAI Login</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;">
<div style="text-align:center;color:#e2e8f0;max-width:500px;">
  <h1 style="margin:0 0 12px;">OpenAI Login for Codex</h1>
  <p style="color:#94a3b8;">Click the button below to authenticate with your OpenAI account.</p>
  <p style="color:#94a3b8;">Uses the same OAuth flow as the Codex CLI.</p>
  <a href="/codex/login/start" style="display:inline-block;margin-top:24px;padding:12px 32px;background:#10a37f;color:white;text-decoration:none;border-radius:8px;font-size:16px;font-weight:600;">
    Sign in with OpenAI
  </a>
  <p style="color:#475569;margin-top:32px;font-size:14px;">Scopes: openid, profile, email, offline_access</p>
</div>
</body></html>`;
}

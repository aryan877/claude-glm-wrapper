// Google OAuth 2.0 authentication for Gemini via Code Assist API
// Uses the same client credentials as the official Gemini CLI
// (safe to include - this is an "installed application" per Google's OAuth2 docs)

import * as http from "http";
import * as crypto from "crypto";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

// ── OAuth constants (from official Gemini CLI) ─────────────────────────

const OAUTH_CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";

const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

// Code Assist API for Pro subscribers
const CA_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CA_VERSION = "v1internal";

// ── Storage ────────────────────────────────────────────────────────────

const PROXY_DIR = join(homedir(), ".claude-proxy");

function authFile(account: number): string {
  return join(PROXY_DIR, account === 1 ? "google-oauth.json" : `google-oauth-${account}.json`);
}

export interface GoogleTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // timestamp in ms
  email?: string;
  project_id?: string;
}

export async function loadTokens(account = 1): Promise<GoogleTokens | null> {
  try {
    const data = await readFile(authFile(account), "utf-8");
    const parsed = JSON.parse(data);
    if (!parsed.access_token || !parsed.refresh_token) return null;
    return parsed as GoogleTokens;
  } catch {
    return null;
  }
}

/** Alias for loadTokens - used by gemini-oauth for failover */
export async function getTokensForAccount(account: number): Promise<GoogleTokens | null> {
  return loadTokens(account);
}

async function saveTokens(tokens: GoogleTokens, account = 1): Promise<void> {
  await mkdir(PROXY_DIR, { recursive: true });
  await writeFile(authFile(account), JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

// ── PKCE helpers ───────────────────────────────────────────────────────

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

// ── Token refresh ──────────────────────────────────────────────────────

async function refreshAccessToken(
  refreshToken: string
): Promise<{ access_token: string; expires_in: number }> {
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }

  return (await resp.json()) as { access_token: string; expires_in: number };
}

/** Get a valid access token, auto-refreshing if needed */
export async function getAccessToken(account = 1): Promise<string> {
  const tokens = await loadTokens(account);
  if (!tokens) {
    const loginPath = account === 1 ? "/google/login" : `/google/login/${account}`;
    throw new Error(
      `Not logged in to Google (account ${account}). Visit http://127.0.0.1:` +
        (process.env.CLAUDE_PROXY_PORT || "17870") +
        `${loginPath} to authenticate.`
    );
  }

  // Refresh if expired or within 5-minute buffer
  if (Date.now() > tokens.expires_at - 5 * 60 * 1000) {
    console.log(`[gemini-oauth] Access token expired (account ${account}), refreshing...`);
    try {
      const refreshed = await refreshAccessToken(tokens.refresh_token);
      tokens.access_token = refreshed.access_token;
      tokens.expires_at = Date.now() + refreshed.expires_in * 1000;
      await saveTokens(tokens, account);
      console.log(`[gemini-oauth] Token refreshed successfully (account ${account})`);
    } catch (e: any) {
      throw new Error(
        `Token refresh failed (account ${account}): ${e.message}. Please re-login at /google/login${account === 1 ? "" : `/${account}`}`
      );
    }
  }

  return tokens.access_token;
}

// ── User info ──────────────────────────────────────────────────────────

async function fetchUserEmail(
  accessToken: string
): Promise<string | undefined> {
  try {
    const resp = await fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (resp.ok) {
      const data = (await resp.json()) as any;
      return data.email;
    }
  } catch {}
  return undefined;
}

// ── Code Assist project setup ──────────────────────────────────────────

async function setupCodeAssist(
  accessToken: string
): Promise<string | undefined> {
  try {
    console.log("[gemini-oauth] Setting up Code Assist project...");

    const resp = await fetch(`${CA_ENDPOINT}/${CA_VERSION}:loadCodeAssist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        metadata: {
          ideType: "IDE_UNSPECIFIED",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        },
      }),
    });

    if (!resp.ok) {
      console.warn(
        `[gemini-oauth] Code Assist setup returned ${resp.status} - will use standard API`
      );
      return undefined;
    }

    const data = (await resp.json()) as any;

    // Already set up
    if (data.cloudaicompanionProject) {
      console.log(
        `[gemini-oauth] Code Assist project: ${data.cloudaicompanionProject}`
      );
      if (data.currentTier) {
        console.log(
          `[gemini-oauth] Tier: ${data.currentTier.name || data.currentTier.id}`
        );
      }
      return data.cloudaicompanionProject;
    }

    // Need to onboard
    const tier =
      data.paidTier ||
      data.currentTier ||
      data.availableTiers?.find(
        (t: any) => t.id === "STANDARD" || t.id === "FREE"
      ) ||
      data.availableTiers?.[0];

    if (!tier) {
      console.warn("[gemini-oauth] No tier available for onboarding");
      return undefined;
    }

    console.log(
      `[gemini-oauth] Onboarding to tier: ${tier.name || tier.id}...`
    );
    const onboardResp = await fetch(
      `${CA_ENDPOINT}/${CA_VERSION}:onboardUser`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          tierId: tier.id,
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
          },
        }),
      }
    );

    if (!onboardResp.ok) {
      console.warn(
        `[gemini-oauth] Onboard failed (${onboardResp.status}) - will use standard API`
      );
      return undefined;
    }

    const onboardData = (await onboardResp.json()) as any;

    // Handle long-running operation
    if (!onboardData.done && onboardData.name) {
      console.log("[gemini-oauth] Waiting for onboarding to complete...");
      const opName = onboardData.name;
      let attempts = 0;
      while (attempts < 12) {
        await new Promise((r) => setTimeout(r, 5000));
        const opResp = await fetch(
          `${CA_ENDPOINT}/${CA_VERSION}/operations/${opName}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        if (!opResp.ok) break;
        const opData = (await opResp.json()) as any;
        if (opData.done) {
          const projectId = opData.response?.cloudaicompanionProject?.id;
          if (projectId) {
            console.log(
              `[gemini-oauth] Onboarded to project: ${projectId}`
            );
            return projectId;
          }
          break;
        }
        attempts++;
      }
    }

    const projectId = onboardData.response?.cloudaicompanionProject?.id;
    if (projectId) {
      console.log(`[gemini-oauth] Onboarded to project: ${projectId}`);
      return projectId;
    }

    return undefined;
  } catch (e: any) {
    console.warn("[gemini-oauth] Code Assist setup error:", e.message);
    return undefined;
  }
}

// ── Browser opener ─────────────────────────────────────────────────────

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

// ── Standalone login (browser-based OAuth from terminal) ───────────────

export async function googleLoginStandalone(): Promise<GoogleTokens> {
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

  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const state = crypto.randomBytes(32).toString("hex");
  const { verifier, challenge } = generatePKCE();

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  const authUrl = `${AUTH_ENDPOINT}?${params}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith("/oauth2callback")) {
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
          res.end(errorPage(`OAuth error: ${error}`));
          clearTimeout(timeout);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(errorPage("State mismatch - possible CSRF attack"));
          clearTimeout(timeout);
          server.close();
          reject(new Error("OAuth state mismatch"));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(errorPage("No authorization code received"));
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
            client_secret: OAUTH_CLIENT_SECRET,
            code,
            code_verifier: verifier,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
          }),
        });

        if (!tokenResp.ok) {
          const text = await tokenResp.text();
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(errorPage(`Token exchange failed: ${text}`));
          clearTimeout(timeout);
          server.close();
          reject(new Error(`Token exchange failed: ${text}`));
          return;
        }

        const tokenData = (await tokenResp.json()) as any;

        const tokens: GoogleTokens = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: Date.now() + tokenData.expires_in * 1000,
        };

        // Fetch user info
        tokens.email = await fetchUserEmail(tokens.access_token);

        // Setup Code Assist
        tokens.project_id = await setupCodeAssist(tokens.access_token);

        // Save
        await saveTokens(tokens);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(successPage(tokens.email, tokens.project_id));

        clearTimeout(timeout);
        server.close();
        resolve(tokens);
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(errorPage(e.message));
        clearTimeout(timeout);
        server.close();
        reject(e);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      console.log(`\n[gemini-oauth] Opening browser for Google login...`);
      console.log(`[gemini-oauth] If browser doesn't open, visit:`);
      console.log(`  ${authUrl}\n`);
      openBrowser(authUrl);
    });
  });
}

// ── Proxy-integrated login (via Fastify routes) ────────────────────────

// In-memory pending OAuth state for proxy-integrated login (keyed by account number)
const pendingOAuthMap = new Map<number, { state: string; verifier: string; redirectUri: string }>();

/** Build the Google OAuth authorization URL (for proxy-integrated login) */
export function buildLoginUrl(proxyPort: number, account = 1): string {
  const callbackPath = account === 1 ? "/google/callback" : `/google/callback/${account}`;
  const redirectUri = `http://127.0.0.1:${proxyPort}${callbackPath}`;
  const state = crypto.randomBytes(32).toString("hex");
  const { verifier, challenge } = generatePKCE();

  pendingOAuthMap.set(account, { state, verifier, redirectUri });

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  return `${AUTH_ENDPOINT}?${params}`;
}

/** Handle OAuth callback (for proxy-integrated login) */
export async function handleOAuthCallback(
  code: string,
  state: string,
  account = 1
): Promise<GoogleTokens> {
  const pending = pendingOAuthMap.get(account);
  if (!pending) {
    const loginPath = account === 1 ? "/google/login" : `/google/login/${account}`;
    throw new Error(`No pending OAuth flow for account ${account}. Visit ${loginPath} first.`);
  }

  if (state !== pending.state) {
    pendingOAuthMap.delete(account);
    throw new Error("OAuth state mismatch - possible CSRF attack.");
  }

  const { verifier, redirectUri } = pending;
  pendingOAuthMap.delete(account);

  // Exchange code for tokens
  const tokenResp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
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

  const tokens: GoogleTokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + tokenData.expires_in * 1000,
  };

  // Fetch user info
  tokens.email = await fetchUserEmail(tokens.access_token);

  // Setup Code Assist
  tokens.project_id = await setupCodeAssist(tokens.access_token);

  // Save
  await saveTokens(tokens, account);

  console.log(
    `[gemini-oauth] Login successful (account ${account})! Email: ${tokens.email || "unknown"}, Project: ${tokens.project_id || "none (using standard API)"}`
  );

  return tokens;
}

/** Get login status */
export async function getLoginStatus(account = 1): Promise<{
  loggedIn: boolean;
  email?: string;
  projectId?: string;
  expiresAt?: number;
  mode?: string;
}> {
  const tokens = await loadTokens(account);
  if (!tokens) return { loggedIn: false };
  return {
    loggedIn: true,
    email: tokens.email,
    projectId: tokens.project_id,
    expiresAt: tokens.expires_at,
    mode: tokens.project_id ? "code-assist" : "standard-api",
  };
}

/** Logout */
export async function googleLogout(account = 1): Promise<void> {
  try {
    const { unlink } = await import("fs/promises");
    await unlink(authFile(account));
    console.log(`[gemini-oauth] Logged out (account ${account}), credentials removed.`);
  } catch {
    console.log(`[gemini-oauth] Already logged out (account ${account}).`);
  }
}

// ── HTML pages ─────────────────────────────────────────────────────────

function successPage(email?: string, projectId?: string): string {
  return `<!DOCTYPE html>
<html><head><title>Login Successful</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;">
<div style="text-align:center;color:#e2e8f0;max-width:500px;">
  <div style="font-size:48px;margin-bottom:16px;">&#10003;</div>
  <h1 style="color:#4ade80;margin:0 0 12px;">Authenticated Successfully</h1>
  <p>Logged in as: <strong>${email || "unknown"}</strong></p>
  ${projectId ? `<p>Code Assist Project: <code style="background:#1e293b;padding:2px 8px;border-radius:4px;">${projectId}</code></p>` : `<p style="color:#94a3b8;">No Code Assist project (using standard API)</p>`}
  <p style="color:#64748b;margin-top:24px;">You can close this window and return to your terminal.<br>Use <code style="background:#1e293b;padding:2px 8px;border-radius:4px;">go:gemini-3.1-pro-preview</code> as your model.</p>
</div>
</body></html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html><head><title>Login Failed</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;">
<div style="text-align:center;color:#e2e8f0;max-width:500px;">
  <div style="font-size:48px;margin-bottom:16px;">&#10007;</div>
  <h1 style="color:#f87171;margin:0 0 12px;">Authentication Failed</h1>
  <p>${message}</p>
  <p style="color:#64748b;margin-top:24px;">Please try again at <a href="/google/login" style="color:#60a5fa;">/google/login</a></p>
</div>
</body></html>`;
}

export function loginPage(_proxyPort: number, account = 1): string {
  const startPath = account === 1 ? "/google/login/start" : `/google/login/${account}/start`;
  const title = account === 1 ? "Google Login for Gemini" : `Google Login for Gemini (Account ${account} — Failover)`;
  const subtitle = account === 1
    ? "Click the button below to authenticate with your Google account."
    : `Click the button below to authenticate a second Google account. This account will be used automatically when account 1 hits rate limits (429).`;
  return `<!DOCTYPE html>
<html><head><title>Google Login</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;">
<div style="text-align:center;color:#e2e8f0;max-width:500px;">
  <h1 style="margin:0 0 12px;">${title}</h1>
  <p style="color:#94a3b8;">${subtitle}</p>
  <p style="color:#94a3b8;">This uses the same OAuth flow as the official Gemini CLI.</p>
  <a href="${startPath}" style="display:inline-block;margin-top:24px;padding:12px 32px;background:#4285f4;color:white;text-decoration:none;border-radius:8px;font-size:16px;font-weight:600;">
    Sign in with Google
  </a>
  <p style="color:#475569;margin-top:32px;font-size:14px;">Scopes: cloud-platform, userinfo.email, userinfo.profile</p>
</div>
</body></html>`;
}

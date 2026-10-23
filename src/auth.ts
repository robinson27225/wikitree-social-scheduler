/**
 * Who may use the app, when it runs on a server.
 *
 * Sign-in is Google's OpenID Connect "authorization code" flow with PKCE. We never see a password. After
 * Google vouches for an email address, we still require that address to be on our own approved list.
 * Everything here is written to fail closed: any doubt means "not signed in".
 */
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { audit } from "./audit.ts";
import { config } from "./config.ts";
import { flashAndRedirect } from "./flash.ts";
import { all, get, run } from "./db.ts";
import { normalizeEmail, userByEmail, userById, userBySub, type Role, type User } from "./users.ts";
import { HttpError } from "./util.ts";

export interface AuthUser {
  id: number | null;
  email: string;
  name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      csrfToken?: string;
    }
  }
}

/** On your own computer there is one implied administrator and no login. */
export const LOCAL_USER: AuthUser = { id: null, email: "this computer", name: "This computer", role: "admin" };

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 10 * 60 * 1000;
export const COOKIE_NAME = config.secureCookies ? "__Host-session" : "session";

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const b64url = (buf: Buffer) => buf.toString("base64url");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- ID token checks (pure, so they can be tested hard)

export interface Jwk {
  kid?: string;
  kty: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

export interface IdentityClaims {
  sub: string;
  email: string;
  name: string;
}

function decodeJson(part: string): Record<string, any> {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    /* fall through */
  }
  throw new Error("The sign-in token was malformed.");
}

/**
 * Checks a Google ID token and returns who it says the person is. Throws on anything unexpected:
 * wrong signature or algorithm, wrong issuer or audience, expired, wrong nonce, or an unverified email.
 */
export function verifyIdToken(
  idToken: string,
  expect: { clientId: string; issuers: string[]; nonce: string; keys: Jwk[]; allowedDomain?: string | null; now?: number },
): IdentityClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("The sign-in token was malformed.");
  const [h, p, sig] = parts;
  const header = decodeJson(h);
  if (header.alg !== "RS256") throw new Error("The sign-in token used an unexpected signing method.");

  const candidates = expect.keys.filter((k) => k.kty === "RSA" && (!header.kid || k.kid === header.kid) && (!k.alg || k.alg === "RS256"));
  if (candidates.length === 0) throw new Error("The sign-in token was signed with an unknown key.");
  const signed = Buffer.from(`${h}.${p}`);
  const signature = Buffer.from(sig, "base64url");
  const valid = candidates.some((jwk) => {
    try {
      const key = crypto.createPublicKey({ key: jwk, format: "jwk" } as unknown as crypto.JsonWebKeyInput);
      return crypto.verify("RSA-SHA256", signed, key, signature);
    } catch {
      return false;
    }
  });
  if (!valid) throw new Error("The sign-in token's signature didn't check out.");

  const claims = decodeJson(p);
  const now = Math.floor((expect.now ?? Date.now()) / 1000);
  if (typeof claims.iss !== "string" || !expect.issuers.includes(claims.iss)) throw new Error("The sign-in token came from the wrong issuer.");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expect.clientId)) throw new Error("The sign-in token was meant for a different app.");
  if (audiences.length > 1 && claims.azp !== expect.clientId) throw new Error("The sign-in token was meant for a different app.");
  if (typeof claims.exp !== "number" || claims.exp <= now - 60) throw new Error("The sign-in token has expired.");
  if (typeof claims.iat === "number" && claims.iat > now + 300) throw new Error("The sign-in token is dated in the future.");
  if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, expect.nonce)) throw new Error("The sign-in didn't match this browser. Please try again.");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("The sign-in token had no account id.");
  if (typeof claims.email !== "string" || !claims.email) throw new Error("Google didn't share an email address.");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new Error("That Google account's email address isn't verified.");

  if (expect.allowedDomain) {
    // Google marks Workspace accounts with "hd". Require it AND the email's own domain, so neither alone can be spoofed by a consumer account.
    const domain = expect.allowedDomain.toLowerCase();
    const hd = typeof claims.hd === "string" ? claims.hd.toLowerCase() : "";
    if (hd !== domain || !normalizeEmail(claims.email).endsWith(`@${domain}`)) {
      throw new Error(`The sign-in token wasn't for a @${domain} account. Sign in with your WikiTree Google account.`);
    }
  }

  return { sub: claims.sub, email: normalizeEmail(claims.email), name: typeof claims.name === "string" ? claims.name.slice(0, 100) : "" };
}

// ---------------------------------------------------------------- Google's published keys

let keyCache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function googleKeys(force = false): Promise<Jwk[]> {
  const g = config.google!;
  const age = keyCache ? Date.now() - keyCache.fetchedAt : Infinity;
  // Reuse for an hour; refetch early only for an unknown key, and at most once a minute.
  if (keyCache && age < 3_600_000 && !(force && age > 60_000)) return keyCache.keys;
  const res = await fetch(g.jwksUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Couldn't fetch Google's signing keys (${res.status}).`);
  const body = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new Error("Google's signing keys were in an unexpected format.");
  keyCache = { keys: body.keys, fetchedAt: Date.now() };
  return keyCache.keys;
}

// ---------------------------------------------------------------- sign-in in progress

interface Pending {
  nonce: string;
  verifier: string;
  expires: number;
}
const pending = new Map<string, Pending>();

function prunePending() {
  const now = Date.now();
  for (const [state, p] of pending) if (p.expires < now) pending.delete(state);
  while (pending.size > 500) pending.delete(pending.keys().next().value!); // oldest first
}

/** A small in-memory limiter, per client address. */
const hits = new Map<string, number[]>();
function tooMany(key: string, max = config.loginRateMax, windowMs = 10 * 60 * 1000): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => t < now - windowMs)) hits.delete(k);
  return recent.length > max;
}

// ---------------------------------------------------------------- sessions

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookieHeader(value: string, maxAgeSeconds: number): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${config.secureCookies ? "; Secure" : ""}`;
}

function createSession(user: User, req: Request): { cookie: string } {
  const secret = b64url(crypto.randomBytes(32));
  const now = Date.now();
  run(
    "INSERT INTO sessions (id_hash, user_id, csrf, created_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)",
    sha256(secret),
    user.id,
    b64url(crypto.randomBytes(24)),
    now,
    now,
    req.ip ?? "",
    String(req.headers["user-agent"] ?? "").slice(0, 200),
  );
  run("DELETE FROM sessions WHERE created_at < ? OR last_seen_at < ?", now - SESSION_MAX_MS, now - SESSION_IDLE_MS);
  return { cookie: cookieHeader(secret, SESSION_MAX_MS / 1000) };
}

/** The signed-in person for this request's cookie, or null. Sessions slide while in use and end after a week regardless. */
function sessionUser(req: Request): { user: AuthUser; csrf: string; hash: string } | null {
  const secret = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!secret || secret.length < 20 || secret.length > 200) return null;
  const hash = sha256(secret);
  const row = get("SELECT * FROM sessions WHERE id_hash = ?", hash);
  if (!row) return null;
  const now = Date.now();
  if (now - Number(row.created_at) > SESSION_MAX_MS || now - Number(row.last_seen_at) > SESSION_IDLE_MS) {
    run("DELETE FROM sessions WHERE id_hash = ?", hash);
    return null;
  }
  const user = userById(Number(row.user_id));
  if (!user || user.status !== "active") {
    run("DELETE FROM sessions WHERE id_hash = ?", hash);
    return null;
  }
  if (now - Number(row.last_seen_at) > 60_000) run("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?", now, hash);
  return { user: { id: user.id, email: user.email, name: user.name, role: user.role }, csrf: String(row.csrf), hash };
}

// ---------------------------------------------------------------- middleware

const bearerMatches = (req: Request) => {
  const token = config.briefToken;
  const header = String(req.headers.authorization ?? "");
  return Boolean(token) && header.startsWith("Bearer ") && safeEqual(header.slice(7).trim(), token!);
};

/**
 * Everything under /api and /oauth goes through this. On a server it needs a valid session, and any change
 * needs the session's CSRF token too. The one exception is the daily brief, which may use its own read-only token.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (config.authMode === "local") {
    req.user = LOCAL_USER;
    next();
    return;
  }
  if (req.method === "GET" && req.baseUrl + req.path === "/api/brief" && bearerMatches(req)) {
    req.user = { id: null, email: "daily brief", name: "Daily brief", role: "member" };
    next();
    return;
  }
  const session = sessionUser(req);
  if (!session) {
    // A platform sending someone back mid-connect lands here as a page view, so send them to the sign-in page.
    if (req.baseUrl === "/oauth") flashAndRedirect(res, "Sign in first, then connect the account again.");
    else res.status(401).json({ error: "Please sign in." });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const sent = String(req.headers["x-csrf-token"] ?? "");
    if (!sent || !safeEqual(sent, session.csrf)) {
      res.status(403).json({ error: "This page is out of date. Reload it and try again." });
      return;
    }
  }
  req.user = session.user;
  req.csrfToken = session.csrf;
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== "admin") throw new HttpError(403, "Only an administrator can do that.");
  next();
}

// ---------------------------------------------------------------- routes

export function authRoutes(app: import("express").Express): void {
  const clientKey = (req: Request) => req.ip ?? "unknown";
  const fail = (res: Response, message: string) => flashAndRedirect(res, message);

  /** Tells the page who is signed in (or that nobody is), and hands it the CSRF token to send with changes. */
  app.get("/auth/me", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (config.authMode === "local") {
      res.json({ mode: "local", user: LOCAL_USER, csrf: "" });
      return;
    }
    const session = sessionUser(req);
    if (!session) {
      res.status(401).json({ mode: "google", error: "Please sign in." });
      return;
    }
    res.json({ mode: "google", user: session.user, csrf: session.csrf });
  });

  app.get("/auth/login", (req, res) => {
    if (config.authMode === "local" || !config.google) {
      res.redirect("/");
      return;
    }
    if (tooMany(`login:${clientKey(req)}`)) return fail(res, "Too many attempts. Wait a few minutes and try again.");
    prunePending();
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    pending.set(state, { nonce, verifier, expires: Date.now() + LOGIN_TTL_MS });
    const url = new URL(config.google.authUrl);
    url.search = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: `${config.publicUrl}/auth/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      prompt: "select_account",
      ...(config.allowedDomain ? { hd: config.allowedDomain } : {}),
    }).toString();
    res.redirect(url.toString());
  });

  app.get("/auth/callback", async (req, res) => {
    if (config.authMode === "local" || !config.google) {
      res.redirect("/");
      return;
    }
    if (tooMany(`callback:${clientKey(req)}`)) return fail(res, "Too many attempts. Wait a few minutes and try again.");
    // A state value works once. Taking it out of the table first means a replayed link finds nothing.
    const state = String(req.query.state ?? "");
    const attempt = pending.get(state);
    pending.delete(state);
    if (!attempt || attempt.expires < Date.now()) return fail(res, "That sign-in link expired. Please try again.");
    if (req.query.error) return fail(res, "Google sign-in was cancelled.");
    const code = String(req.query.code ?? "");
    if (!code) return fail(res, "Google didn't send a sign-in code. Please try again.");

    try {
      const g = config.google;
      const tokenRes = await fetch(g.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: g.clientId,
          client_secret: g.clientSecret,
          redirect_uri: `${config.publicUrl}/auth/callback`,
          grant_type: "authorization_code",
          code_verifier: attempt.verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokens = (await tokenRes.json().catch(() => ({}))) as { id_token?: string };
      if (!tokenRes.ok || !tokens.id_token) throw new Error("Google didn't accept the sign-in. Please try again.");

      const verify = (keys: Jwk[]) => verifyIdToken(tokens.id_token!, { clientId: g.clientId, issuers: g.issuers, nonce: attempt.nonce, keys, allowedDomain: config.allowedDomain });
      let identity: IdentityClaims;
      try {
        identity = verify(await googleKeys());
      } catch (first) {
        // Google rotates its keys; if ours are stale the signature check fails once, so look again before giving up.
        identity = verify(await googleKeys(true).catch(() => { throw first; }));
      }

      // The approved list decides. Google only tells us who someone is.
      const bySub = userBySub(identity.sub);
      const byEmail = userByEmail(identity.email);
      let user: User | null = null;
      if (bySub) {
        user = bySub; // the account is bound to Google's stable id, even if the email on it has since changed
      } else if (byEmail) {
        if (byEmail.googleSub && byEmail.googleSub !== identity.sub) {
          audit({ id: byEmail.id, email: byEmail.email }, "login.refused", "Google account id doesn't match the one first used with this email");
          return fail(res, "That email is linked to a different Google account. Ask an administrator.");
        }
        user = byEmail;
      }
      if (!user) {
        audit({ id: null, email: identity.email }, "login.refused", "not on the approved list");
        return fail(res, "That Google account isn't on the approved list. Ask a WikiTree social media administrator to add you.");
      }
      if (user.status !== "active") {
        audit({ id: user.id, email: user.email }, "login.refused", "access turned off");
        return fail(res, "Your access to the scheduler has been turned off.");
      }

      run(
        "UPDATE users SET google_sub = ?, name = CASE WHEN name = '' THEN ? ELSE name END, last_login_at = ? WHERE id = ?",
        identity.sub,
        identity.name,
        new Date().toISOString(),
        user.id,
      );
      res.append("Set-Cookie", createSession(user, req).cookie);
      audit({ id: user.id, email: user.email }, "login", "");
      res.redirect("/");
    } catch (error) {
      console.error("Sign-in failed:", error instanceof Error ? error.message : error);
      audit({ id: null, email: "unknown" }, "login.failed", error instanceof Error ? error.message : "unknown error");
      fail(res, error instanceof Error && error.message.startsWith("The sign-in") ? error.message : "Sign-in didn't work. Please try again.");
    }
  });

  app.post("/auth/logout", (req, res) => {
    const session = config.authMode === "google" ? sessionUser(req) : null;
    if (session) {
      if (!safeEqual(String(req.headers["x-csrf-token"] ?? ""), session.csrf)) {
        res.status(403).json({ error: "This page is out of date. Reload it and try again." });
        return;
      }
      run("DELETE FROM sessions WHERE id_hash = ?", session.hash);
      audit({ id: session.user.id, email: session.user.email }, "logout", "");
    }
    res.append("Set-Cookie", cookieHeader("", 0));
    res.json({ ok: true });
  });
}

/** For the Users screen: who has a live session right now. */
export function activeSessionCounts(): Map<number, number> {
  const out = new Map<number, number>();
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const row of all("SELECT user_id, COUNT(*) AS n FROM sessions WHERE last_seen_at > ? GROUP BY user_id", cutoff)) out.set(Number(row.user_id), Number(row.n));
  return out;
}

/**
 * How this copy of the app is running, decided once at startup from environment variables.
 *
 *  local   (default)  On one person's own computer. Listens only on this computer and has no login,
 *                     because nobody else can reach it. Used for development and the automated tests.
 *  google             On a server on the internet. Everyone must sign in with an approved Google account.
 *
 * It refuses combinations that would be unsafe (a no-login app listening to the world, a server with no
 * sign-in configured) rather than starting and hoping.
 */

export type AuthMode = "local" | "google";

export class ConfigError extends Error {}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  /** The "issuer" values a genuine Google ID token may carry. */
  issuers: string[];
}

export interface BackupConfig {
  passphrase: string | null;
  /** Null unless the bucket is fully described. */
  bucket: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; prefix: string } | null;
  keep: number;
  /** Hour of the day (server time) when the nightly backup runs. */
  hour: number;
}

export interface AppConfig {
  authMode: AuthMode;
  port: number;
  /** The network address to listen on. */
  bindHost: string;
  /** The address people use, without a trailing slash, such as https://wikitree-social.fly.dev */
  publicUrl: string;
  /** Host header values we accept. Anything else is refused. */
  allowedHosts: ReadonlySet<string>;
  /** Origins we accept on requests that change things. */
  allowedOrigins: ReadonlySet<string>;
  /** Cookies are marked Secure (https only). */
  secureCookies: boolean;
  /** We're behind a proxy (such as Fly's) that tells us the real client address and protocol. */
  trustProxy: boolean;
  maxUploadBytes: number;
  /** Sign-in attempts allowed per address per 10 minutes. */
  loginRateMax: number;
  google: GoogleConfig | null;
  /** If set, only Google Workspace accounts in this domain (for example wikitree.com) may sign in, whatever the approved list says. */
  allowedDomain: string | null;
  /** Emails that are made administrators on startup (google mode). */
  adminEmails: string[];
  /** Encrypts stored sign-in tokens and keys. Required on a server; optional on your own computer. */
  dataKey: Buffer | null;
  /** Automatic encrypted backups to a private S3-compatible bucket, and the passphrase that protects them. */
  backup: BackupConfig;
  /** Where failure alerts are posted (a Discord or Slack "incoming webhook" address). */
  alertWebhook: string | null;
  /** Lets the daily brief / Claude read the digest without signing in. Optional. */
  briefToken: string | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** DATA_KEY may be base64 or hex of at least 32 random bytes. `openssl rand -base64 32` makes one. */
function parseDataKey(raw: string | undefined): Buffer | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const bytes = /^[0-9a-fA-F]{64,}$/.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  if (bytes.length < 32) throw new ConfigError("DATA_KEY must be at least 32 random bytes (for example the output of: openssl rand -base64 32).");
  return bytes;
}

function parseBackup(env: NodeJS.ProcessEnv): BackupConfig {
  const passphrase = (env.BACKUP_PASSPHRASE ?? "").trim() || null;
  if (passphrase && passphrase.length < 12) throw new ConfigError("BACKUP_PASSPHRASE must be at least 12 characters.");
  const keep = Number(env.BACKUP_KEEP ?? 14);
  const hour = Number(env.BACKUP_HOUR ?? 3);
  if (!Number.isInteger(keep) || keep < 1) throw new ConfigError("BACKUP_KEEP must be a whole number of at least 1.");
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new ConfigError("BACKUP_HOUR must be a whole number from 0 to 23.");
  const parts = {
    endpoint: (env.BACKUP_S3_ENDPOINT ?? "").trim(),
    bucket: (env.BACKUP_S3_BUCKET ?? "").trim(),
    accessKeyId: (env.BACKUP_S3_ACCESS_KEY_ID ?? "").trim(),
    secretAccessKey: (env.BACKUP_S3_SECRET_ACCESS_KEY ?? "").trim(),
  };
  const given = Object.values(parts).filter(Boolean).length;
  if (given > 0 && given < 4) {
    throw new ConfigError("Automatic backups need all four of BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY.");
  }
  if (given === 4 && !secureOrLocal(parts.endpoint)) throw new ConfigError("BACKUP_S3_ENDPOINT must start with https://");
  if (given === 4 && !passphrase) throw new ConfigError("Automatic backups also need BACKUP_PASSPHRASE, which encrypts each backup before it leaves the server.");
  return {
    passphrase,
    bucket: given === 4 ? { ...parts, region: (env.BACKUP_S3_REGION ?? "auto").trim() || "auto", prefix: (env.BACKUP_S3_PREFIX ?? "social-scheduler/").trim() } : null,
    keep,
    hour,
  };
}

/** https everywhere, except plain http to this same computer so the automated tests can stand in for the real services. */
const secureOrLocal = (url: string) => /^https:\/\//i.test(url) || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url);

function parseWebhook(raw: string | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  if (!secureOrLocal(text)) throw new ConfigError("ALERT_WEBHOOK_URL must start with https://");
  return text;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be a number between 1 and 65535 (got "${env.PORT}").`);
  }

  const mode = (env.AUTH_MODE ?? "local").trim().toLowerCase();
  if (mode !== "local" && mode !== "google") {
    throw new ConfigError(`AUTH_MODE must be "local" or "google" (got "${env.AUTH_MODE}").`);
  }

  const uploadMb = Number(env.MAX_UPLOAD_MB ?? 512);
  if (!Number.isFinite(uploadMb) || uploadMb < 1) throw new ConfigError("MAX_UPLOAD_MB must be a positive number.");
  const maxUploadBytes = Math.floor(uploadMb * 1024 * 1024);

  const loginRateMax = Number(env.LOGIN_RATE_MAX ?? 30);
  if (!Number.isInteger(loginRateMax) || loginRateMax < 1) throw new ConfigError("LOGIN_RATE_MAX must be a whole number of at least 1.");

  const dataKey = parseDataKey(env.DATA_KEY);
  const backup = parseBackup(env);
  const alertWebhook = parseWebhook(env.ALERT_WEBHOOK_URL);

  const brief = (env.BRIEF_TOKEN ?? "").trim();
  if (brief && brief.length < 24) throw new ConfigError("BRIEF_TOKEN must be at least 24 characters (use a long random value).");

  if (mode === "local") {
    const bindHost = (env.BIND_HOST ?? "127.0.0.1").trim();
    if (!LOOPBACK_HOSTS.has(bindHost)) {
      throw new ConfigError(
        `Local mode has no login, so it may only listen on this computer (127.0.0.1), not "${bindHost}". Use AUTH_MODE=google to run on a server.`,
      );
    }
    return {
      authMode: "local",
      port,
      bindHost,
      publicUrl: `http://localhost:${port}`,
      allowedHosts: new Set([`localhost:${port}`, `127.0.0.1:${port}`]),
      allowedOrigins: new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]),
      secureCookies: false,
      trustProxy: false,
      maxUploadBytes,
      loginRateMax,
      dataKey,
      backup,
      alertWebhook,
      google: null,
      allowedDomain: null,
      adminEmails: [],
      briefToken: brief || null,
    };
  }

  // ---- google (server) mode
  const problems: string[] = [];

  let url: URL | null = null;
  try {
    url = new URL((env.PUBLIC_URL ?? "").trim());
  } catch {
    problems.push("PUBLIC_URL (the address people use, for example https://wikitree-social.fly.dev)");
  }
  let loopback = false;
  if (url) {
    loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new ConfigError("PUBLIC_URL must start with https:// (plain http is only allowed for localhost while testing).");
    }
    if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
      throw new ConfigError("PUBLIC_URL must be just the address, with no path (for example https://wikitree-social.fly.dev).");
    }
  }

  const clientId = (env.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? "").trim();
  if (!clientId) problems.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) problems.push("GOOGLE_CLIENT_SECRET");

  const adminEmails = (env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!dataKey) problems.push("DATA_KEY (protects the stored sign-in tokens; make one with: openssl rand -base64 32)");
  const allowedDomain = (env.GOOGLE_ALLOWED_DOMAIN ?? "").trim().toLowerCase().replace(/^@/, "") || null;
  if (allowedDomain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(allowedDomain)) throw new ConfigError("GOOGLE_ALLOWED_DOMAIN must be a domain such as wikitree.com.");
  if (adminEmails.length === 0) problems.push("ADMIN_EMAILS (at least one approved administrator's email)");
  const bad = adminEmails.filter((e) => !EMAIL.test(e));
  if (bad.length) throw new ConfigError(`ADMIN_EMAILS has something that isn't an email address: ${bad.join(", ")}`);

  if (allowedDomain) {
    const outside = adminEmails.filter((e) => !e.endsWith(`@${allowedDomain}`));
    if (outside.length) throw new ConfigError(`ADMIN_EMAILS must all be @${allowedDomain} addresses (not ${outside.join(", ")}).`);
  }

  if (problems.length || !url) {
    throw new ConfigError(`Server mode (AUTH_MODE=google) needs these settings: ${problems.join(", ")}.`);
  }

  // Where Google lives. These can be pointed at a stand-in only while testing on this computer, never on a real server.
  const overrides = ["GOOGLE_AUTH_URL", "GOOGLE_TOKEN_URL", "GOOGLE_JWKS_URL", "GOOGLE_ISSUER"].filter((k) => env[k]);
  if (overrides.length && !loopback) {
    throw new ConfigError(`${overrides.join(", ")} may only be set while testing on localhost.`);
  }
  const google: GoogleConfig = {
    clientId,
    clientSecret,
    authUrl: env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
    jwksUrl: env.GOOGLE_JWKS_URL || "https://www.googleapis.com/oauth2/v3/certs",
    issuers: env.GOOGLE_ISSUER ? [env.GOOGLE_ISSUER] : ["https://accounts.google.com", "accounts.google.com"],
  };

  const secure = url.protocol === "https:";
  const hosts = new Set([url.host]);
  const origins = new Set([url.origin]);
  if (loopback) {
    // While testing on this computer, either spelling of "this computer" is fine.
    const p = url.port ? `:${url.port}` : "";
    for (const h of ["localhost", "127.0.0.1"]) {
      hosts.add(`${h}${p}`);
      origins.add(`${url.protocol}//${h}${p}`);
    }
  }

  return {
    authMode: "google",
    port,
    bindHost: (env.BIND_HOST ?? (loopback ? "127.0.0.1" : "0.0.0.0")).trim(),
    publicUrl: url.origin,
    allowedHosts: hosts,
    allowedOrigins: origins,
    secureCookies: secure,
    trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY === "1" : secure,
    maxUploadBytes,
    loginRateMax,
    dataKey,
    backup,
    alertWebhook,
    google,
    allowedDomain,
    adminEmails,
    briefToken: brief || null,
  };
}

/** The settings this process is running with. Throws at startup if they're unsafe or incomplete. */
export const config = loadConfig();

import crypto from "node:crypto";
import { connectorFor, connectors } from "./connectors/index.ts";
import type { AppCreds, Connector, DiscoveredAccount } from "./connectors/types.ts";
import { config } from "./config.ts";
import { all, getJsonSetting, readConfig, run, setJsonSetting, writeConfig } from "./db.ts";
import { providerFor } from "./providers/index.ts";
import type { Config, FieldSpec } from "./providers/types.ts";
import { errMsg, HttpError } from "./util.ts";

const TTL_MS = 15 * 60_000;

/** Sign-ins that have been started and are waiting for the platform to send the person back. */
const attempts = new Map<string, { connectorId: string; session: Record<string, string>; created: number }>();
/** Accounts found after a sign-in, waiting for the person to choose which to add. */
const pending = new Map<string, { connectorId: string; accounts: DiscoveredAccount[]; created: number }>();

function prune(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of attempts) if (v.created < cutoff) attempts.delete(k);
  for (const [k, v] of pending) if (v.created < cutoff) pending.delete(k);
}

const key = (id: string) => `app:${id}`;

export function appCreds(id: string): AppCreds {
  return getJsonSetting<AppCreds>(key(id), {});
}

function isSecret(field: FieldSpec): boolean {
  return field.type === "password";
}

export function saveAppCreds(id: string, update: Record<string, unknown>): void {
  const connector = connectorFor(id);
  const next = { ...appCreds(id) };
  for (const field of connector.appFields) {
    const value = update[field.name];
    if (typeof value !== "string") continue;
    // A blank secret means "keep the one I already saved".
    if (isSecret(field) && value.trim() === "") continue;
    next[field.name] = value.trim();
  }
  setJsonSetting(key(id), next);
}

export function redirectUriFor(connector: Connector, app: AppCreds, port: number): string {
  if (app.redirectUri?.trim()) return app.redirectUri.trim();
  // On a server the address is the public https one, which every platform accepts (including Threads and TikTok).
  const base = config.authMode === "google" ? config.publicUrl : `http://${connector.redirectHost}:${port}`;
  return `${base}/oauth/callback/${connector.id}`;
}

function missingFields(connector: Connector, app: AppCreds): FieldSpec[] {
  return connector.appFields.filter((f) => f.required && !app[f.name]?.trim());
}

/** What the browser may see about each connection: never the secrets themselves. */
export function connectorViews(port: number) {
  return connectors.map((connector) => {
    const app = appCreds(connector.id);
    return {
      id: connector.id,
      label: connector.label,
      help: connector.help,
      provides: connector.provides,
      optional: Boolean(connector.optional),
      // Connect can't work if the platform wants https and the redirect address isn't https.
      connectBlocked: Boolean(connector.needsHttps) && !redirectUriFor(connector, app, port).startsWith("https://"),
      acceptsToken: Boolean(connector.finishWithToken),
      tokenHelp: connector.tokenHelp ?? null,
      redirectUri: redirectUriFor(connector, app, port),
      configured: missingFields(connector, app).length === 0,
      appFields: connector.appFields.map((f) => ({
        ...f,
        value: isSecret(f) ? "" : (app[f.name] ?? (typeof f.default === "string" ? f.default : "")),
        hasValue: Boolean(app[f.name]),
      })),
    };
  });
}

export async function startConnect(id: string, port: number): Promise<{ url: string; redirectUri: string }> {
  prune();
  const connector = connectorFor(id);
  const app = appCreds(id);
  const missing = missingFields(connector, app);
  if (missing.length) {
    throw new HttpError(400, `Save the ${missing.map((f) => f.label).join(" and ")} first (from the platform's developer page).`);
  }
  const redirectUri = redirectUriFor(connector, app, port);
  const state = crypto.randomBytes(24).toString("hex");
  try {
    const started = await connector.start(withDefaults(connector, app), redirectUri, state);
    attempts.set(started.key ?? state, { connectorId: id, session: started.session ?? {}, created: Date.now() });
    return { url: started.url, redirectUri };
  } catch (e) {
    throw new HttpError(502, errMsg(e));
  }
}

function withDefaults(connector: Connector, app: AppCreds): AppCreds {
  const out = { ...app };
  for (const f of connector.appFields) {
    if (!out[f.name] && typeof f.default === "string") out[f.name] = f.default;
  }
  return out;
}

/** Called when the platform sends the person back (or when they paste the address it sent them to). */
export async function completeConnect(id: string, query: URLSearchParams, port: number): Promise<string> {
  prune();
  const connector = connectorFor(id);
  const sign = query.get(connector.stateParam ?? "state");
  const attempt = sign ? attempts.get(sign) : undefined;
  if (!sign || !attempt || attempt.connectorId !== id) {
    throw new HttpError(400, "This sign-in wasn't started here, or it took too long (15 minutes). Press Connect again.");
  }
  attempts.delete(sign);

  const app = appCreds(id);
  let accounts: DiscoveredAccount[];
  try {
    accounts = await connector.finish(withDefaults(connector, app), redirectUriFor(connector, app, port), query, attempt.session);
  } catch (e) {
    throw new HttpError(400, errMsg(e));
  }
  const token = crypto.randomBytes(24).toString("hex");
  pending.set(token, { connectorId: id, accounts, created: Date.now() });
  return token;
}

/** Start from a token the person generated on the platform's own tools, instead of the sign-in page. */
export async function completeWithToken(id: string, userToken: string): Promise<string> {
  prune();
  const connector = connectorFor(id);
  if (!connector.finishWithToken) throw new HttpError(400, `${connector.label} can't be connected with a pasted token.`);
  const app = appCreds(id);
  const missing = missingFields(connector, app);
  if (missing.length) {
    throw new HttpError(400, `Save the ${missing.map((f) => f.label).join(" and ")} first (from the platform's developer page).`);
  }
  let accounts: DiscoveredAccount[];
  try {
    accounts = await connector.finishWithToken(withDefaults(connector, app), userToken);
  } catch (e) {
    throw new HttpError(400, errMsg(e));
  }
  const token = crypto.randomBytes(24).toString("hex");
  pending.set(token, { connectorId: id, accounts, created: Date.now() });
  return token;
}

export function pendingView(token: string) {
  const entry = pending.get(token);
  if (!entry) throw new HttpError(404, "These sign-in results have expired. Press Connect again.");
  return entry.accounts.map((a, index) => ({
    index,
    kind: a.kind,
    label: a.label,
    detail: a.detail,
    extraFields: a.extraFields ?? [],
    alreadyAdded: findExisting(a) !== undefined,
  }));
}

/** The identity of an account on its platform, so reconnecting updates it instead of duplicating it. */
function identityOf(kind: string, c: Config): string {
  switch (kind) {
    case "facebook":
      return String(c.pageId);
    case "instagram":
      return String(c.igUserId);
    case "threads":
      return String(c.threadsUserId);
    case "linkedin":
      return String(c.organizationId);
    case "x":
      return String(c.userId || c.username);
    case "youtube":
      return String(c.channelId);
    case "tiktok":
      return String(c.openId);
    case "reddit":
      return `${c.username}/${c.subreddit ?? ""}`;
    default:
      return JSON.stringify(c);
  }
}

function findExisting(a: DiscoveredAccount): { id: number } | undefined {
  const wanted = identityOf(a.kind, a.config);
  return all("SELECT id, config FROM accounts WHERE kind = ?", a.kind).find(
    // Reddit's identity includes the subreddit, which is only chosen later, so match on the login alone.
    (row) =>
      a.kind === "reddit"
        ? readConfig(row.config).username === a.config.username
        : identityOf(a.kind, readConfig(row.config)) === wanted,
  ) as { id: number } | undefined;
}

export interface AddPick {
  index: number;
  label?: string;
  extra?: Record<string, string>;
}

/** Checks each chosen account with its platform, then saves it (or refreshes it if it was added before). */
export async function addPending(token: string, picks: AddPick[]): Promise<{ label: string; ok: boolean; detail: string }[]> {
  const entry = pending.get(token);
  if (!entry) throw new HttpError(404, "These sign-in results have expired. Press Connect again.");
  const results = [];
  for (const pick of picks) {
    const found = entry.accounts[pick.index];
    if (!found) continue;
    const label = pick.label?.trim() || found.label;
    try {
      const provider = providerFor(found.kind);
      for (const field of found.extraFields ?? []) {
        if (field.required && !String(pick.extra?.[field.name] ?? field.default ?? "").trim()) {
          throw new Error(`${field.label} is required.`);
        }
      }
      const extra: Record<string, string> = {};
      for (const field of found.extraFields ?? []) {
        const value = pick.extra?.[field.name] ?? (typeof field.default === "string" ? field.default : "");
        if (value.trim()) extra[field.name] = value.trim();
      }
      const connected = await provider.connect({ ...found.config, ...extra });
      const existing = findExisting(found);
      if (existing) {
        run("UPDATE accounts SET config = ? WHERE id = ?", writeConfig(connected.config), existing.id);
      } else {
        run(
          "INSERT INTO accounts (kind, label, config, created_at) VALUES (?, ?, ?, ?)",
          found.kind,
          label,
          writeConfig(connected.config),
          new Date().toISOString(),
        );
      }
      results.push({ label, ok: true, detail: (existing ? "Updated. " : "") + connected.detail });
    } catch (e) {
      results.push({ label, ok: false, detail: errMsg(e) });
    }
  }
  if (results.every((r) => r.ok)) pending.delete(token);
  return results;
}

/** Exposed for tests. */
export function _clearConnectState(): void {
  attempts.clear();
  pending.clear();
}


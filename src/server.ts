import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { claudeConfiguredFor, DEFAULT_MODEL, draft, explainClaudeError, moveSharedKeyToItsOwner, setApiKeyFor } from "./claude.ts";
import { addPending, completeConnect, completeWithToken, connectorViews, pendingView, saveAppCreds, startConnect } from "./connect.ts";
import {
  all,
  checkDataKey,
  DEFAULT_STYLE_GUIDE,
  get,
  getSecretSetting,
  getSetting,
  MEDIA_DIR,
  readConfig,
  run,
  setSecretSetting,
  sealStoredSecrets,
  setSetting,
  THUMB_DIR,
  writeConfig,
} from "./db.ts";
import { buildBrief } from "./brief.ts";
import { thumbnail } from "./images.ts";
import { deleteFromLibrary, extraImagesOf, libraryFile, libraryIdOf, listLibrary, MAX_IMAGES_PER_POST, pruneMissingFiles, saveUpload, sourceRef, thumbKey } from "./library.ts";
import { mediaKindOf, type MediaKind } from "./media.ts";
import { getHostConfig, publicHostSettings, saveHostConfig, testHost } from "./publicHost.ts";
import { isKeepingAwake, setKeepAwake } from "./keepawake.ts";
import { providerFor, providers, publicConfig } from "./providers/index.ts";
import type { Config } from "./providers/types.ts";
import { markPosted, placeTarget, publishTarget, releaseServerCopy, setHandedOff, setPostedLink, startScheduler, unmarkPosted } from "./scheduler.ts";
import { errMsg, HttpError } from "./util.ts";
import { activeSessionCounts, authRoutes, requireAdmin, requireAuth } from "./auth.ts";
import { backupStatus, checkDisk, diskUsage, maybeRunNightly, runBackup } from "./autobackup.ts";
import { audit, recentAudit } from "./audit.ts";
import { config } from "./config.ts";
import { readMemory, startMemorySampler } from "./resources.ts";
import { listColumnSettings, saveColumnSettings, wikiRows } from "./wiki.ts";
import { checkWtc, listChallenges, phaseLabel, saveWtcRows, WTC_PHASES, wtcRows, wtcTable } from "./wtc.ts";
import { archiveInfo, checkArchivableMonth, clearMonth, collectStats, importTikTokCsv, monthBeforeLast, monthLabel, monthlyCsv, statsRows } from "./stats.ts";
import { createTemplate, deleteTemplate, getTemplate, leftoverPlaceholders, listSkips, listTemplates, seedTemplates, seedWikiSettings, setSkip, updateTemplate } from "./templates.ts";
import { seedManualAccounts } from "./seedAccounts.ts";
import { addUser, listUsers, removeUser, seedAdmins, updateUser } from "./users.ts";

const PORT = config.port;
const ORIGIN = config.publicUrl;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/** The version in package.json, shown under the title so people can say which one they're using. */
const APP_VERSION: string = (() => {
  try {
    return String(JSON.parse(readFileSync(path.join(PUBLIC_DIR, "..", "package.json"), "utf8")).version ?? "");
  } catch {
    return "";
  }
})();

// ---------------------------------------------------------------- app + security

const app = express();
app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", 1); // behind the host's proxy: use the real client address and protocol

// Always-on answer for the host's health check. It says nothing about the app, so it needs no login.
app.get("/healthz", (_req, res) => {
  res.type("text/plain").set("Cache-Control", "no-store").send("ok");
});

// Headers that tell the browser to be strict. The app only ever loads its own scripts and styles.
app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    ...(config.secureCookies ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  });
  next();
});

// This app holds account tokens and can post as you, so only requests addressed to it by its own name are accepted.
app.use((req, res, next) => {
  const host = (req.headers.host ?? "").toLowerCase();
  if (!config.allowedHosts.has(host)) {
    res.status(403).json({ error: "Forbidden host" });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    const originOk = !origin || config.allowedOrigins.has(origin);
    // Uploads are sent as raw bytes; everything else is JSON. Both content types force a browser preflight across sites.
    const type = String(req.headers["content-type"] ?? "");
    const isUpload = req.method === "PUT" && req.path === "/api/library";
    const typeOk = isUpload ? type.startsWith("application/octet-stream") : type.includes("application/json");
    if (!originOk || !typeOk) {
      res.status(403).json({ error: "Forbidden request" });
      return;
    }
  }
  next();
});
// The TikTok file import takes a bigger body, but only for people who are signed in, so it has its own parser below.
app.use((req, res, next) => (req.path === "/api/stats/import" ? next() : express.json({ limit: "1mb" })(req, res, next)));
app.use(express.static(PUBLIC_DIR));

// Signing in and out, and "who am I". Everything else below needs a signed-in person.
authRoutes(app);
app.use(["/api", "/oauth"], requireAuth);

// ---------------------------------------------------------------- helpers

function accountRow(row: Record<string, any>) {
  const provider = providerFor(row.kind);
  const config: Config = readConfig(row.config);
  return {
    id: row.id as number,
    kind: row.kind as string,
    kindLabel: provider.label,
    label: row.label as string,
    config: publicConfig(provider, config),
    textLimit: provider.textLimit(config),
    // Why this account can't take each kind of post (null means it can), so the form can grey it out.
    noText: provider.accepts(null, config),
    noImage: provider.accepts("image", config),
    noVideo: provider.accepts("video", config),
    needsTitle: (provider.needsTitleFor ? provider.needsTitleFor(config) : provider.needsTitle) ?? null,
    titleLimit: provider.titleLimit?.(config) ?? null,
    manual: Boolean(provider.manual),
    heldByPlatform: Boolean(provider.supportsServerSchedule?.(config)),
    // How many pictures one post here can carry; a post with more has the extras left off this channel.
    maxImages: provider.maxImages?.(config) ?? 1,
  };
}

function loadAccounts(ids: unknown): Record<string, any>[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new HttpError(400, "Choose at least one account to post to.");
  }
  return ids.map((id) => {
    const row = get("SELECT * FROM accounts WHERE id = ?", Number(id));
    if (!row) throw new HttpError(400, `Account ${id} no longer exists.`);
    return row;
  });
}

/** The answers typed into a template's blanks: short text under short names, nothing else. */
function templateValuesOf(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter(([k, v]) => k.trim() && typeof v === "string")
      .slice(0, 40)
      .map(([k, v]) => [k.trim().toLowerCase().slice(0, 60), String(v).slice(0, 500)]),
  );
}

/** Kept with a post made from a template, so its wiki row can reuse them. Null when there is nothing to keep. */
function storedTemplateValues(input: unknown): string | null {
  const values = templateValuesOf(input);
  return Object.keys(values).length ? JSON.stringify(values) : null;
}

/** What one channel changes about the post. null means "use the post's own"; noMedia posts that channel without the image or video. */
interface Override {
  text: string | null;
  title: string | null;
  altText: string | null;
  noMedia: boolean;
  /** YouTube: use the video's first frame as its thumbnail. */
  thumbFirstFrame: boolean;
}

function cleanOverride(raw: unknown): Override {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return { text: str(o.text), title: str(o.title), altText: str(o.altText), noMedia: o.noMedia === true, thumbFirstFrame: o.thumbFirstFrame === true };
}

function overrideOfRow(t: Record<string, any>): Override {
  return {
    text: t.text_override ?? null,
    title: t.title_override ?? null,
    altText: t.alt_override ?? null,
    noMedia: Boolean(t.no_media),
    thumbFirstFrame: Boolean(t.thumb_first_frame),
  };
}

interface Channel {
  account: { id?: number; kind: string; label: string; config: string };
  override: Override;
}

/**
 * Checks a post channel by channel, each with its own text, title and media choice: the text fits,
 * the platform takes what that channel will actually post, a required title is present, and (when
 * the file is given) the file itself is acceptable.
 */
async function validatePost(
  fields: { text: unknown; title: unknown; altText: unknown; scheduledAt: unknown },
  channels: Channel[],
  media: { kind: MediaKind | null; file?: string; extraFiles?: string[] },
) {
  const { text, title, altText, scheduledAt } = fields;
  if (typeof text !== "string" || text.trim() === "") throw new HttpError(400, "Write some text for the post.");
  if (typeof title !== "string") throw new HttpError(400, "The title must be text.");
  if (typeof altText !== "string") throw new HttpError(400, "Alt text must be text.");
  if (altText.length > 1500) throw new HttpError(400, "Alt text is limited to 1500 characters.");
  if (typeof scheduledAt !== "string" || Number.isNaN(Date.parse(scheduledAt))) {
    throw new HttpError(400, "Choose a valid date and time.");
  }
  for (const { account, override } of channels) {
    const provider = providerFor(account.kind);
    const config: Config = readConfig(account.config);
    const effectiveText = override.text ?? text.trim();
    const effectiveTitle = override.title ?? title.trim();

    // A template's {{placeholder}} that was never filled in must not be published as it is.
    const unfilled = leftoverPlaceholders(`${effectiveText}\n${effectiveTitle}`);
    if (unfilled.length) {
      throw new HttpError(400, `${account.label}: the text still has ${unfilled[0]} to fill in${unfilled.length > 1 ? ` (and ${unfilled.length - 1} more)` : ""}.`);
    }
    const effectiveKind = override.noMedia ? null : media.kind;

    if ((override.altText ?? "").length > 1500) throw new HttpError(400, `${account.label}: alt text is limited to 1500 characters.`);

    const refusal = provider.accepts(effectiveKind, config);
    if (refusal) throw new HttpError(400, `${account.label}: ${refusal}`);

    const used = provider.countText(effectiveText, config);
    const limit = provider.textLimit(config);
    if (used > limit) throw new HttpError(400, `Too long for ${account.label}: ${used} of ${limit} characters.`);

    // Manual accounts may be given their title later, in the Queue, so only automatic platforms insist now.
    const needsTitle = provider.needsTitleFor ? provider.needsTitleFor(config) : provider.needsTitle;
    if (needsTitle === "required" && !provider.manual && effectiveTitle === "") {
      throw new HttpError(400, `${account.label} needs a title.`);
    }
    const titleLimit = provider.titleLimit?.(config);
    if (titleLimit && effectiveTitle.length > titleLimit) {
      throw new HttpError(400, `Title too long for ${account.label}: ${effectiveTitle.length} of ${titleLimit} characters.`);
    }

    if (media.file && effectiveKind && provider.validateMedia) {
      // Every picture the channel will actually post: the first, and as many more as it takes.
      const cap = provider.maxImages?.(config) ?? 1;
      const files = [media.file, ...(effectiveKind === "image" ? (media.extraFiles ?? []).slice(0, Math.max(cap - 1, 0)) : [])];
      for (const file of files) {
        const problem = await provider.validateMedia(file, effectiveKind, config);
        if (problem) throw new HttpError(400, `${account.label}: ${problem}${files.length > 1 ? ` (${path.basename(file)})` : ""}`);
      }
    }
  }
  return {
    text: text.trim(),
    title: title.trim(),
    altText: altText.trim(),
    scheduledAt: new Date(scheduledAt).toISOString(),
  };
}

function postsWithTargets(whereSql = "", ...params: unknown[]) {
  const posts = all(`SELECT * FROM posts ${whereSql} ORDER BY scheduled_at DESC, id DESC`, ...params);
  return posts.map((post) => {
    const postKind = post.media_file ? mediaKindOf(post.media_file) : null;
    return {
      id: post.id,
      text: post.text,
      altText: post.alt_text,
      title: post.title ?? "",
      // A small picture for the Queue (a still frame for videos), and the file name for "show in Finder".
      mediaUrl: post.media_file ? `/api/media-thumb/${encodeURIComponent(post.media_file)}` : null,
      mediaFile: post.media_file || null,
      mediaKind: postKind,
      // The pictures after the first, in order, each with its own description.
      extraMedia: extraImagesOf(post.extra_media).map((e) => ({
        file: e.file,
        url: `/api/media-thumb/${encodeURIComponent(e.file)}`,
        altText: e.alt,
        libraryId: libraryIdOf(e.source),
      })),
      libraryId: libraryIdOf(String(post.source_path)),
      templateId: post.template_id ?? null,
      wtc: post.wtc_phase ? { challenge: post.wtc_challenge, phase: post.wtc_phase, phaseLabel: phaseLabel(String(post.wtc_phase)) } : null,
      scheduledAt: post.scheduled_at,
      targets: all(
        `SELECT t.id, t.status, t.mode, t.url, t.error, t.posted_at AS postedAt, t.external_id AS externalId, t.handed_off_at AS handedOffAt,
                t.text_override, t.title_override, t.alt_override, t.no_media, t.thumb_first_frame,
                t.account_id AS accountId, a.label AS accountLabel, a.kind, a.config AS accountConfig
           FROM targets t JOIN accounts a ON a.id = t.account_id
          WHERE t.post_id = ? ORDER BY t.id`,
        post.id,
      ).map(({ accountConfig, text_override, title_override, alt_override, no_media, thumb_first_frame, handedOffAt, ...target }) => {
        const provider = providerFor(String(target.kind));
        const config: Config = readConfig(String(accountConfig));
        // What this channel will actually post: its own text/title/alt/media if it has them, else the post's.
        const text = String(text_override ?? post.text);
        const title = String(title_override ?? post.title ?? "");
        const need = provider.needsTitleFor ? provider.needsTitleFor(config) : provider.needsTitle;
        return {
          ...target,
          text,
          title,
          altText: String(alt_override ?? post.alt_text),
          noMedia: Boolean(no_media),
          thumbFirstFrame: Boolean(thumb_first_frame),
          handedOff: handedOffAt != null,
          customText: text_override != null,
          customTitle: title_override != null,
          customAlt: alt_override != null,
          textLimit: provider.textLimit(config),
          needsTitle: need ?? null,
          titleLimit: provider.titleLimit?.(config) ?? null,
          titleMissing: need === "required" && title.trim() === "",
          // Why this channel can't drop the media, and why it can't take it, so the edit form can say so.
          textOnlyRefusal: provider.accepts(null, config),
          mediaRefusal: postKind ? provider.accepts(postKind, config) : null,
          manualUrl: provider.manual ? provider.manual.openUrl(config, { text, title }) : null,
        };
      }),
    };
  });
}

/** Takes one platform-held copy off the platform's schedule so the target can be changed. Throws (changing nothing) if it can't. */
async function releaseOne(target: { id: number; label: string }): Promise<void> {
  let cancelled: boolean;
  try {
    cancelled = await releaseServerCopy(Number(target.id));
  } catch (e) {
    throw new HttpError(502, `Couldn't cancel the copy scheduled on ${target.label}: ${errMsg(e)}`);
  }
  if (!cancelled) {
    throw new HttpError(
      409,
      `This post is no longer on ${target.label}'s schedule, so it may already have been published. Check the account; the Queue will update shortly.`,
    );
  }
}

/**
 * Takes platform-held copies of a post's targets off the platform's schedule, so the post can be
 * edited or cancelled. Stops (and changes nothing further) if any can't be cancelled.
 */
async function releaseServerCopies(postId: number): Promise<void> {
  const held = all(
    "SELECT t.id, a.label FROM targets t JOIN accounts a ON a.id = t.account_id WHERE t.post_id = ? AND t.mode = 'remote' AND t.status = 'scheduled'",
    postId,
  );
  for (const target of held) await releaseOne({ id: Number(target.id), label: String(target.label) });
}

// ---------------------------------------------------------------- status + settings

app.get("/api/status", (req, res) => {
  res.json({
    claudeConfigured: claudeConfiguredFor(req.user?.id),
    keepAwake: isKeepingAwake(),
    platform: process.platform,
    maxUploadBytes: config.maxUploadBytes,
    hostConfigured: getHostConfig() !== null,
    version: APP_VERSION,
  });
});

/** A plain-English digest for a daily brief or for Claude: add ?format=text for just the words. */
app.get("/api/brief", (req, res) => {
  const brief = buildBrief();
  if (req.query.format === "text") res.type("text/plain; charset=utf-8").send(brief.text + "\n");
  else res.json(brief);
});

app.get("/api/settings", (_req, res) => {
  res.json({
    styleGuide: getSetting("style_guide", DEFAULT_STYLE_GUIDE),
    claudeModel: getSetting("claude_model", DEFAULT_MODEL) || DEFAULT_MODEL,
    missedGraceMinutes: Number(getSetting("missed_grace_minutes", "30")),
    keepAwake: getSetting("keep_awake", "true") === "true",
    // On the shared server every person has their own key (see /api/me/claude); the one shared key only exists on a single computer.
    perPersonKeys: config.authMode === "google",
    apiKeySet: config.authMode !== "google" && getSecretSetting("anthropic_api_key") !== "",
    apiKeyFromEnv: config.authMode !== "google" && Boolean(process.env.ANTHROPIC_API_KEY),
  });
});

/** Whether the signed-in person has saved their own Anthropic key. The key itself is never sent back. */
app.get("/api/me/claude", (req, res) => {
  res.json({ keySet: claudeConfiguredFor(req.user?.id), perPerson: config.authMode === "google" });
});

/** Saves or (with an empty key) removes the signed-in person's own Anthropic key. Anyone signed in may; it only ever affects them. */
app.put("/api/me/claude", (req, res) => {
  const key = typeof req.body?.apiKey === "string" ? req.body.apiKey : "";
  setApiKeyFor(req.user?.id, key);
  audit(req, key.trim() ? "claude.key-saved" : "claude.key-removed", "");
  res.json({ ok: true, keySet: claudeConfiguredFor(req.user?.id) });
});

app.put("/api/settings", requireAdmin, (req, res) => {
  const { styleGuide, claudeModel, missedGraceMinutes, keepAwake, apiKey } = req.body ?? {};
  if (typeof styleGuide === "string") setSetting("style_guide", styleGuide);
  if (typeof claudeModel === "string") setSetting("claude_model", claudeModel.trim());
  if (missedGraceMinutes !== undefined) {
    const minutes = Number(missedGraceMinutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
      throw new HttpError(400, "Grace period must be between 0 and 1440 minutes.");
    }
    setSetting("missed_grace_minutes", String(minutes));
  }
  if (typeof keepAwake === "boolean") {
    setSetting("keep_awake", String(keepAwake));
    setKeepAwake(keepAwake);
  }
  // The shared key only exists on a single computer; on the server each person saves their own.
  if (typeof apiKey === "string" && config.authMode !== "google") setSecretSetting("anthropic_api_key", apiKey.trim());
  audit(req, "settings.change", Object.keys(req.body ?? {}).filter((k) => k !== "apiKey" && k !== "styleGuide").concat(typeof apiKey === "string" ? ["apiKey"] : [], typeof styleGuide === "string" ? ["styleGuide"] : []).join(", "));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- accounts

app.get("/api/providers", (_req, res) => {
  // Platforms that sign in through "Connect" have no hand-filled fields, so they aren't listed here.
  res.json(
    Object.values(providers)
      .filter((p) => p.fields.length > 0)
      .map((p) => ({ kind: p.kind, label: p.label, fields: p.fields })),
  );
});

app.get("/api/accounts", (_req, res) => {
  res.json(all("SELECT * FROM accounts ORDER BY id").map(accountRow));
});

app.post("/api/accounts", requireAdmin, async (req, res) => {
  const { kind, label, config } = req.body ?? {};
  const provider = providerFor(String(kind));
  if (typeof label !== "string" || label.trim() === "") throw new HttpError(400, "Give the account a name.");
  for (const field of provider.fields) {
    if (field.required && !String(config?.[field.name] ?? "").trim()) {
      throw new HttpError(400, `${field.label} is required.`);
    }
  }
  let connected;
  try {
    connected = await provider.connect(config ?? {});
  } catch (e) {
    throw new HttpError(400, `Couldn't sign in: ${errMsg(e)}`);
  }
  const result = run(
    "INSERT INTO accounts (kind, label, config, created_at) VALUES (?, ?, ?, ?)",
    provider.kind,
    label.trim(),
    writeConfig(connected.config),
    new Date().toISOString(),
  );
  audit(req, "account.add", `${provider.label}: ${label.trim()}`);
  res.json({ id: Number(result.lastInsertRowid), detail: connected.detail });
});

app.post("/api/accounts/:id/test", async (req, res) => {
  const row = get("SELECT * FROM accounts WHERE id = ?", Number(req.params.id));
  if (!row) throw new HttpError(404, "No such account.");
  try {
    const ctx = {
      saveConfig: (patch: Config) => {
        const latest = get("SELECT config FROM accounts WHERE id = ?", row.id);
        if (latest) run("UPDATE accounts SET config = ? WHERE id = ?", writeConfig({ ...readConfig(latest.config), ...patch }), row.id);
      },
    };
    const connected = await providerFor(row.kind).connect(readConfig(row.config), ctx);
    const latest = get("SELECT config FROM accounts WHERE id = ?", row.id);
    run("UPDATE accounts SET config = ? WHERE id = ?", writeConfig({ ...readConfig(latest?.config ?? row.config), ...connected.config }), row.id);
    res.json({ ok: true, detail: connected.detail });
  } catch (e) {
    res.json({ ok: false, detail: errMsg(e) });
  }
});

app.delete("/api/accounts/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const pending = get(
    "SELECT COUNT(*) AS n FROM targets WHERE account_id = ? AND status IN ('scheduled', 'posting')",
    id,
  );
  if (pending && Number(pending.n) > 0) {
    throw new HttpError(409, "This account still has scheduled posts. Cancel or move them first.");
  }
  const removed = get("SELECT label FROM accounts WHERE id = ?", id);
  run("DELETE FROM targets WHERE account_id = ?", id);
  run("DELETE FROM accounts WHERE id = ?", id);
  audit(req, "account.remove", String(removed?.label ?? `#${id}`));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- media library (uploaded in the browser)

app.get("/api/library", (_req, res) => {
  res.json({ items: listLibrary() });
});

/** One file per request, sent as raw bytes: PUT /api/library?name=photo.jpg */
app.put("/api/library", async (req, res) => {
  const { item, duplicate } = await saveUpload(req, String(req.query.name ?? ""), config.maxUploadBytes);
  if (!duplicate) audit(req, "library.add", `${item.name} (${item.kind}, ${item.size} bytes)`);
  res.status(duplicate ? 200 : 201).json({ item, duplicate });
});

app.get("/api/library/:id/thumb", async (req, res) => {
  const { file, row } = libraryFile(Number(req.params.id));
  const edge = req.query.size === "large" ? 1400 : 360;
  const cached = path.join(THUMB_DIR, `${thumbKey(String(row.stored), edge)}.jpg`);
  const hit = await fs.readFile(cached).catch(() => null);
  const bytes = hit ?? (await thumbnail(file, edge));
  if (!hit) await fs.writeFile(cached, bytes);
  res.type("image/jpeg").set("Cache-Control", "private, max-age=3600").send(bytes);
});

app.delete("/api/library/:id", async (req, res) => {
  const gone = get("SELECT name FROM library WHERE id = ?", Number(req.params.id));
  await deleteFromLibrary(Number(req.params.id));
  audit(req, "library.remove", String(gone?.name ?? req.params.id));
  res.json({ ok: true });
});

/** A post's picture or video. With ?download=1 it is offered as a file download under its original name. */
app.get("/api/media/:file", async (req, res) => {
  const name = path.basename(String(req.params.file));
  const file = path.join(MEDIA_DIR, name);
  if (!(await fs.stat(file).catch(() => null))) throw new HttpError(404, "File not found.");
  res.set("Cache-Control", "private, max-age=3600");
  if (req.query.download === "1") {
    const post = get("SELECT source_path FROM posts WHERE media_file = ?", name);
    let id = post ? libraryIdOf(String(post.source_path)) : null;
    if (!post) {
      // Not a post's first picture: it may be one of the extra pictures of a post.
      for (const row of all("SELECT extra_media FROM posts WHERE extra_media LIKE ?", `%${name}%`)) {
        const extra = extraImagesOf(row.extra_media).find((e) => e.file === name);
        if (extra) id = libraryIdOf(extra.source);
      }
    }
    const original = id === null ? undefined : get("SELECT name FROM library WHERE id = ?", id)?.name;
    res.download(file, original ? String(original) : name);
    return;
  }
  res.type(path.extname(name)).sendFile(file);
});

// ---------------------------------------------------------------- posts

app.get("/api/posts", (_req, res) => {
  res.json(postsWithTargets());
});

/** Keeps the post's own copy of a library file, so renaming, moving or deleting the original later can't break a scheduled post. */
async function keepCopy(source: string): Promise<string> {
  const name = `${crypto.randomUUID()}${path.extname(source).toLowerCase()}`;
  // A second name for the same bytes costs no extra space (a copy is the fallback).
  await fs.link(source, path.join(MEDIA_DIR, name)).catch(() => fs.copyFile(source, path.join(MEDIA_DIR, name), fsConstants.COPYFILE_FICLONE));
  return name;
}

/** The pictures after the first, checked: only after a first picture, only pictures, no repeats, and not too many. */
function checkMoreImages(raw: unknown, first: { id: number | null; kind: MediaKind | null }): { item: ReturnType<typeof libraryFile>; alt: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, "The extra pictures must be a list.");
  if (raw.length === 0) return [];
  if (first.kind !== "image") throw new HttpError(400, "Extra pictures can only go with a first picture. A video or a text-only post can't have them.");
  if (1 + raw.length > MAX_IMAGES_PER_POST) throw new HttpError(400, `A post can have at most ${MAX_IMAGES_PER_POST} pictures.`);
  const seen = new Set<number>(first.id === null ? [] : [first.id]);
  return raw.map((entry) => {
    const id = Number(entry?.libraryId);
    if (seen.has(id)) throw new HttpError(400, "The same picture is in this post twice.");
    seen.add(id);
    const item = libraryFile(id);
    if (mediaKindOf(item.file) !== "image") throw new HttpError(400, `${item.row.name}: only pictures can be added after the first.`);
    const alt = typeof entry?.altText === "string" ? entry.altText.trim() : "";
    if (alt.length > 1500) throw new HttpError(400, "Alt text is limited to 1500 characters.");
    return { item, alt };
  });
}

app.post("/api/posts", async (req, res) => {
  const { libraryId, text, title = "", altText = "", scheduledAt, accountIds, overrides, templateId, templateValues, moreImages, wtc } = req.body ?? {};
  const challenge = checkWtc(wtc);
  // No libraryId means a text-only post. It's stored with an empty media_file and source_path.
  const libraryItem = libraryId ? libraryFile(Number(libraryId)) : null;
  const source = libraryItem?.file ?? "";
  const kind = source ? mediaKindOf(source) : null;
  const more = checkMoreImages(moreImages, { id: libraryItem ? Number(libraryItem.row.id) : null, kind });
  const accounts = loadAccounts(accountIds);
  // Each channel may skip the media or carry its own text/title/alt text. A post with no media has nothing to skip.
  const channels: Channel[] = accounts.map((account) => {
    const override = cleanOverride(overrides?.[account.id]);
    if (!source) override.noMedia = false;
    return { account: account as Channel["account"], override };
  });
  const fields = await validatePost(
    { text, title, altText: kind === "image" ? altText : "", scheduledAt },
    channels,
    { kind, file: source || undefined, extraFiles: more.map((m) => m.item.file) },
  );
  if (Date.parse(fields.scheduledAt) < Date.now() - 60_000) {
    throw new HttpError(400, "That time has already passed. Pick a time in the future.");
  }

  // Keep our own copy of each picture, so deleting the library item later can't break a scheduled post.
  const mediaFile = source ? await keepCopy(source) : "";
  const extraMedia = [];
  for (const m of more) {
    extraMedia.push({ file: await keepCopy(m.item.file), source: sourceRef(Number(m.item.row.id)), alt: m.alt });
  }

  const post = run(
    "INSERT INTO posts (text, title, alt_text, media_file, source_path, scheduled_at, created_at, template_id, template_values, extra_media, wtc_challenge, wtc_phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    fields.text,
    fields.title,
    fields.altText,
    mediaFile,
    libraryItem ? sourceRef(Number(libraryItem.row.id)) : "",
    fields.scheduledAt,
    new Date().toISOString(),
    templateId && getTemplate(Number(templateId)) ? Number(templateId) : null,
    storedTemplateValues(templateValues),
    JSON.stringify(extraMedia),
    challenge.challenge,
    challenge.phase,
  );
  for (const { account, override } of channels) {
    const target = run(
      "INSERT INTO targets (post_id, account_id, text_override, title_override, alt_override, no_media, thumb_first_frame) VALUES (?, ?, ?, ?, ?, ?, ?)",
      post.lastInsertRowid,
      account.id,
      override.text,
      override.title,
      override.altText,
      override.noMedia ? 1 : 0,
      account.kind === "youtube" && override.thumbFirstFrame ? 1 : 0,
    );
    await placeTarget(Number(target.lastInsertRowid)); // hands it to the platform's own scheduler where possible
  }
  audit(req, "post.schedule", `#${post.lastInsertRowid} for ${fields.scheduledAt} on ${channels.map((c) => c.account.label).join(", ")}`);
  res.json({ id: Number(post.lastInsertRowid) });
});

/** Adds more channels to a post that is already in the Queue (for a channel that was missed when it was scheduled). */
app.post("/api/posts/:id/channels", async (req, res) => {
  const id = Number(req.params.id);
  const post = get("SELECT * FROM posts WHERE id = ?", id);
  if (!post) throw new HttpError(404, "No such post.");
  const accounts = loadAccounts(req.body?.accountIds);
  const already = new Set(all("SELECT account_id FROM targets WHERE post_id = ?", id).map((t) => Number(t.account_id)));
  const dup = accounts.find((a) => already.has(Number(a.id)));
  if (dup) throw new HttpError(409, `${dup.label} is already on this post.`);

  const kind = post.media_file ? mediaKindOf(post.media_file) : null;
  const channels: Channel[] = accounts.map((account) => {
    const override = cleanOverride(req.body?.overrides?.[account.id]);
    if (!post.media_file) override.noMedia = false;
    return { account: account as Channel["account"], override };
  });
  // The same checks as when the post was first scheduled, using the post's own text, title and picture.
  await validatePost(
    { text: post.text, title: post.title ?? "", altText: kind === "image" ? post.alt_text : "", scheduledAt: post.scheduled_at },
    channels,
    {
      kind,
      file: post.media_file ? path.join(MEDIA_DIR, post.media_file) : undefined,
      extraFiles: extraImagesOf(post.extra_media).map((e) => path.join(MEDIA_DIR, e.file)),
    },
  );
  for (const { account, override } of channels) {
    const target = run(
      "INSERT INTO targets (post_id, account_id, text_override, title_override, alt_override, no_media, thumb_first_frame) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      account.id,
      override.text,
      override.title,
      override.altText,
      override.noMedia ? 1 : 0,
      account.kind === "youtube" && override.thumbFirstFrame ? 1 : 0,
    );
    await placeTarget(Number(target.lastInsertRowid));
  }
  audit(req, "post.add-channels", `#${id}: ${channels.map((c) => c.account.label).join(", ")}`);
  res.json({ ok: true, added: channels.length });
});

app.patch("/api/posts/:id", async (req, res) => {
  const id = Number(req.params.id);
  const post = get("SELECT * FROM posts WHERE id = ?", id);
  if (!post) throw new HttpError(404, "No such post.");
  const targets = all(
    `SELECT t.status, t.text_override, t.title_override, t.alt_override, t.no_media, a.kind, a.label, a.config
       FROM targets t JOIN accounts a ON a.id = t.account_id WHERE t.post_id = ?`,
    id,
  );
  if (targets.some((t) => t.status === "posted" || t.status === "posting")) {
    throw new HttpError(409, "Part of this post has already gone out. Edit the channels that haven't been posted from their own Edit button.");
  }
  const { text = post.text, title = post.title ?? "", altText = post.alt_text, scheduledAt = post.scheduled_at } = req.body ?? {};
  const kind = post.media_file ? mediaKindOf(post.media_file) : null;
  const fields = await validatePost(
    { text, title, altText: kind === "image" ? altText : "", scheduledAt },
    targets.map((t) => ({ account: t as unknown as Channel["account"], override: overrideOfRow(t) })),
    { kind },
  );
  await releaseServerCopies(id); // validated first, so we never cancel anything for an edit that gets rejected
  run(
    "UPDATE posts SET text = ?, title = ?, alt_text = ?, scheduled_at = ? WHERE id = ?",
    fields.text,
    fields.title,
    fields.altText,
    fields.scheduledAt,
    id,
  );
  // Moving a missed/failed post to a new time puts it back in the queue.
  if (req.body?.scheduledAt && Date.parse(fields.scheduledAt) > Date.now()) {
    run("UPDATE targets SET status = 'scheduled', error = NULL WHERE post_id = ? AND status IN ('missed', 'failed', 'ready')", id);
  }
  for (const target of all("SELECT id FROM targets WHERE post_id = ? AND status = 'scheduled'", id)) {
    await placeTarget(Number(target.id));
  }
  audit(req, "post.edit", `#${id}`);
  res.json({ ok: true });
});

/** Marks a post as being for a stage of a WikiTree Challenge (or clears it). Allowed at any time, even after it has gone out. */
app.put("/api/posts/:id/wtc", (req, res) => {
  const id = Number(req.params.id);
  if (!get("SELECT id FROM posts WHERE id = ?", id)) throw new HttpError(404, "No such post.");
  const challenge = checkWtc(req.body);
  run("UPDATE posts SET wtc_challenge = ?, wtc_phase = ? WHERE id = ?", challenge.challenge, challenge.phase, id);
  audit(req, "post.wtc", `#${id}: ${challenge.phase ? `${challenge.challenge} / ${challenge.phase}` : "cleared"}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- the WikiTree Challenge's table

app.get("/api/wtc", (_req, res) => {
  res.json({ phases: WTC_PHASES.map(({ key, label }) => ({ key, label })), challenges: listChallenges(), rows: wtcRows() });
});

app.get("/api/wtc/table", (req, res) => {
  res.json(wtcTable(String(req.query.challenge ?? "")));
});

app.put("/api/wtc/rows", (req, res) => {
  saveWtcRows(req.body?.rows);
  audit(req, "wtc.rows", "");
  res.json({ ok: true, rows: wtcRows() });
});

app.delete("/api/posts/:id", async (req, res) => {
  const id = Number(req.params.id);
  const post = get("SELECT * FROM posts WHERE id = ?", id);
  if (!post) throw new HttpError(404, "No such post.");
  await releaseServerCopies(id);
  // Never delete the record of something that was actually published.
  run("DELETE FROM targets WHERE post_id = ? AND status IN ('scheduled', 'missed', 'failed', 'ready')", id);
  const left = get("SELECT COUNT(*) AS n FROM targets WHERE post_id = ?", id);
  if (Number(left?.n ?? 0) === 0) {
    run("DELETE FROM posts WHERE id = ?", id);
    // A text-only post has no media_file; rm of "" would target the whole media folder.
    if (post.media_file) await fs.rm(path.join(MEDIA_DIR, path.basename(post.media_file)), { force: true });
  }
  audit(req, "post.cancel", `#${id}`);
  res.json({ ok: true });
});

/** Changes one channel of a post: its own text (for example different tags), title, alt text, or no image. */
app.patch("/api/targets/:id", async (req, res) => {
  const id = Number(req.params.id);
  const t = get(
    `SELECT t.id, t.status, t.mode, t.post_id, t.text_override, t.title_override, t.alt_override, t.no_media,
            a.kind, a.label, a.config
       FROM targets t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`,
    id,
  );
  if (!t) throw new HttpError(404, "No such post.");
  if (!["scheduled", "missed", "failed", "ready"].includes(t.status)) {
    throw new HttpError(409, "That one has already gone out (or is going out right now), so it can't be changed.");
  }
  const post = get("SELECT * FROM posts WHERE id = ?", t.post_id)!;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const current = overrideOfRow(t);
  // Fields left out keep their value; sending "" (or null) goes back to the post's own.
  const next = cleanOverride({
    text: "text" in body ? body.text : current.text,
    title: "title" in body ? body.title : current.title,
    altText: "altText" in body ? body.altText : current.altText,
    noMedia: "noMedia" in body ? body.noMedia : current.noMedia,
  });
  if (!post.media_file) next.noMedia = false;

  const kind = post.media_file ? mediaKindOf(post.media_file) : null;
  await validatePost(
    { text: post.text, title: post.title ?? "", altText: kind === "image" ? post.alt_text : "", scheduledAt: post.scheduled_at },
    [{ account: t as unknown as Channel["account"], override: next }],
    { kind },
  );

  // If a platform is holding this one, take it back first (nothing changes if that fails), then hand the new version over.
  if (t.mode === "remote" && t.status === "scheduled") await releaseOne({ id, label: String(t.label) });
  run(
    "UPDATE targets SET text_override = ?, title_override = ?, alt_override = ?, no_media = ? WHERE id = ?",
    next.text,
    next.title,
    next.altText,
    next.noMedia ? 1 : 0,
    id,
  );
  if (t.status === "scheduled") await placeTarget(id);
  audit(req, "channel.edit", `post #${t.post_id}, ${t.label}`);
  res.json({ ok: true });
});

app.post("/api/targets/:id/post-now", async (req, res) => {
  const id = Number(req.params.id);
  if (!get("SELECT id FROM targets WHERE id = ?", id)) throw new HttpError(404, "No such post.");
  const started = await publishTarget(id);
  if (!started) throw new HttpError(409, "That post has already gone out or is being posted.");
  const target = get("SELECT status, url, error FROM targets WHERE id = ?", id);
  audit(req, "post.now", `target #${id}: ${target?.status}`);
  res.json(target);
});

app.get("/api/media-thumb/:file", async (req, res) => {
  const name = path.basename(String(req.params.file));
  const file = path.join(MEDIA_DIR, name);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) throw new HttpError(404, "File not found.");
  const key = crypto.createHash("sha1").update(`${name}|${stat.mtimeMs}|360`).digest("hex");
  const cached = path.join(THUMB_DIR, `${key}.jpg`);
  const hit = await fs.readFile(cached).catch(() => null);
  const bytes = hit ?? (await thumbnail(file, 360));
  if (!hit) await fs.writeFile(cached, bytes);
  res.type("image/jpeg").set("Cache-Control", "private, max-age=3600").send(bytes);
});

/** For manual platforms: the person says they have scheduled it themselves on the platform's own tool (or takes that back). */
app.post("/api/targets/:id/handed-off", (req, res) => {
  const id = Number(req.params.id);
  const outcome = setHandedOff(id, req.body?.undo !== true);
  if (!outcome.ok) throw new HttpError(outcome.reason === "No such post." ? 404 : 409, outcome.reason);
  audit(req, req.body?.undo === true ? "post.not-scheduled-there" : "post.scheduled-there", `target #${id}`);
  res.json({ ok: true });
});

/** For manual platforms: a slip. "Posted" was pressed on the wrong post, so take it back. */
app.post("/api/targets/:id/unmark-posted", (req, res) => {
  const id = Number(req.params.id);
  const outcome = unmarkPosted(id);
  if (!outcome.ok) throw new HttpError(outcome.reason === "No such post." ? 404 : 409, outcome.reason);
  audit(req, "post.unmark-posted", `target #${id}`);
  res.json({ ok: true });
});

/** For manual platforms: correct the link recorded when it was marked posted. */
app.post("/api/targets/:id/posted-link", (req, res) => {
  const id = Number(req.params.id);
  const outcome = setPostedLink(id, String(req.body?.url ?? ""));
  if (!outcome.ok) throw new HttpError(outcome.reason === "No such post." ? 404 : outcome.reason.startsWith("The link") ? 400 : 409, outcome.reason);
  audit(req, "post.change-link", `target #${id}`);
  res.json({ ok: true });
});

/** For manual platforms: the person says they posted it themselves. */
app.post("/api/targets/:id/mark-posted", (req, res) => {
  const id = Number(req.params.id);
  if (!get("SELECT id FROM targets WHERE id = ?", id)) throw new HttpError(404, "No such post.");
  const url = typeof req.body?.url === "string" ? req.body.url : undefined;
  if (url && !/^https?:\/\//i.test(url.trim())) throw new HttpError(400, "The link must start with https://");
  if (!markPosted(id, url)) throw new HttpError(409, "That one is already marked as posted.");
  audit(req, "post.mark-posted", `target #${id}`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- image host (for Instagram, Threads, TikTok photos)

app.get("/api/host", requireAdmin, (_req, res) => {
  res.json(publicHostSettings());
});

app.put("/api/host", requireAdmin, (req, res) => {
  const { endpoint, region, bucket, accessKeyId, secretAccessKey, publicBaseUrl } = req.body ?? {};
  for (const [name, value] of Object.entries({ endpoint, publicBaseUrl })) {
    if (typeof value === "string" && value.trim() && !/^https?:\/\//i.test(value.trim())) {
      throw new HttpError(400, `${name === "endpoint" ? "The endpoint" : "The public address"} must start with https://`);
    }
  }
  saveHostConfig({ endpoint, region, bucket, accessKeyId, secretAccessKey, publicBaseUrl });
  audit(req, "image-host.change", "");
  res.json(publicHostSettings());
});

app.post("/api/host/test", requireAdmin, async (_req, res) => {
  try {
    res.json({ ok: true, detail: await testHost() });
  } catch (e) {
    res.json({ ok: false, detail: errMsg(e) });
  }
});

// ---------------------------------------------------------------- connecting platforms (sign in with OAuth)

app.get("/api/connectors", requireAdmin, (_req, res) => {
  res.json(connectorViews(PORT));
});

app.put("/api/connectors/:id/app", requireAdmin, (req, res) => {
  saveAppCreds(String(req.params.id), req.body ?? {});
  audit(req, "connector.app-details", String(req.params.id));
  res.json(connectorViews(PORT).find((c) => c.id === req.params.id));
});

app.post("/api/connectors/:id/start", requireAdmin, async (req, res) => {
  res.json(await startConnect(String(req.params.id), PORT));
});

/** For platforms that won't redirect to localhost: the person pastes the address they were sent to. */
app.post("/api/connectors/:id/paste", requireAdmin, async (req, res) => {
  let query: URLSearchParams;
  try {
    query = new URL(String(req.body?.url ?? "").trim()).searchParams;
  } catch {
    throw new HttpError(400, "That doesn't look like a web address. Copy the whole address from the page's address bar.");
  }
  res.json({ token: await completeConnect(String(req.params.id), query, PORT) });
});

/** For when the platform's sign-in page is gated: the person pastes a token made with the platform's own tools. */
app.post("/api/connectors/:id/token", requireAdmin, async (req, res) => {
  res.json({ token: await completeWithToken(String(req.params.id), String(req.body?.token ?? "")) });
});

/** The platform sends the person's browser back here after they approve. */
app.get("/oauth/callback/:id", requireAdmin, async (req, res) => {
  try {
    const query = new URL(req.originalUrl, ORIGIN).searchParams;
    const token = await completeConnect(String(req.params.id), query, PORT);
    audit(req, "connector.connect", String(req.params.id));
    res.redirect(`/?connected=${encodeURIComponent(token)}`);
  } catch (e) {
    res.redirect(`/?connectError=${encodeURIComponent(errMsg(e))}`);
  }
});

app.get("/api/pending/:token", requireAdmin, (req, res) => {
  res.json(pendingView(String(req.params.token)));
});

app.post("/api/pending/:token/add", requireAdmin, async (req, res) => {
  const added = await addPending(String(req.params.token), Array.isArray(req.body?.picks) ? req.body.picks : []);
  audit(req, "connector.add-accounts", "");
  res.json(added);
});

// ---------------------------------------------------------------- people and the record of changes (administrators only)

app.get("/api/users", requireAdmin, (_req, res) => {
  const sessions = activeSessionCounts();
  res.json({ users: listUsers().map((u) => ({ ...u, googleSub: undefined, signedIn: (sessions.get(u.id) ?? 0) > 0, linked: u.googleSub !== null })) });
});

app.post("/api/users", requireAdmin, (req, res) => {
  const user = addUser(req.body?.email, req.body?.name, req.body?.role);
  audit(req, "user.add", `${user.email} as ${user.role}`);
  res.json({ ok: true, id: user.id });
});

app.patch("/api/users/:id", requireAdmin, (req, res) => {
  const user = updateUser(Number(req.params.id), req.user?.id ?? null, req.body ?? {});
  audit(req, "user.change", `${user.email}: ${user.role}, ${user.status}`);
  res.json({ ok: true });
});

app.delete("/api/users/:id", requireAdmin, (req, res) => {
  const user = removeUser(Number(req.params.id), req.user?.id ?? null);
  audit(req, "user.remove", user.email);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- templates for recurring posts (anyone signed in)

app.get("/api/templates", (_req, res) => {
  res.json({ templates: listTemplates(), skips: listSkips() });
});

/** "Not this week": a regular post that isn't happening on a given day stops showing as coming up. */
app.post("/api/templates/:id/skip", (req, res) => {
  setSkip(Number(req.params.id), req.body?.day, req.body?.skipped !== false);
  audit(req, req.body?.skipped === false ? "template.unskip" : "template.skip", `#${req.params.id} ${req.body?.day}`);
  res.json({ ok: true, skips: listSkips() });
});

app.post("/api/templates", (req, res) => {
  const template = createTemplate(req.body ?? {});
  audit(req, "template.add", template.name);
  res.json({ template });
});

app.patch("/api/templates/:id", (req, res) => {
  const template = updateTemplate(Number(req.params.id), req.body ?? {});
  audit(req, "template.change", template.name);
  res.json({ template });
});

app.delete("/api/templates/:id", (req, res) => {
  const template = deleteTemplate(Number(req.params.id));
  audit(req, "template.remove", template.name);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- a list of what has been published, with each platform's own post id

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  // A cell that starts with = + - @ would be run as a formula by a spreadsheet, so make it plain text.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The posts as rows of the wiki's social media posts table. ?post=ID for one post, or ?days=N for what went out in the last N days. */
app.get("/api/export/wiki", (req, res) => {
  const post = req.query.post === undefined ? undefined : Number(req.query.post);
  if (post !== undefined && !Number.isInteger(post)) throw new HttpError(400, "That isn't a post.");
  const days = req.query.days === undefined ? undefined : Number(req.query.days);
  if (days !== undefined && (!Number.isFinite(days) || days <= 0 || days > 3650)) throw new HttpError(400, "Choose a number of days.");
  let values: Record<string, string> = {};
  if (typeof req.query.values === "string" && req.query.values) {
    try {
      values = templateValuesOf(JSON.parse(req.query.values));
    } catch {
      throw new HttpError(400, "Those answers couldn't be read.");
    }
  }
  const tz = typeof req.query.tz === "string" && req.query.tz ? req.query.tz : undefined;
  const rows = wikiRows({ postId: post, from: days === undefined ? undefined : Date.now() - days * 86_400_000 }, { tz, values });
  const text = rows.map((r) => r.text).join("\n");
  if (req.query.format === "text") res.type("text/plain; charset=utf-8").send(text + "\n");
  else res.json({ rows, text });
});

app.get("/api/wiki-columns", requireAdmin, (_req, res) => {
  res.json(listColumnSettings());
});

app.put("/api/wiki-columns", requireAdmin, (req, res) => {
  saveColumnSettings(req.body?.map);
  audit(req, "wiki-columns.change", "");
  res.json(listColumnSettings());
});

app.get("/api/export/published", (req, res) => {
  const from = typeof req.query.from === "string" && req.query.from ? Date.parse(req.query.from) : NaN;
  const to = typeof req.query.to === "string" && req.query.to ? Date.parse(req.query.to) : NaN;
  const rows = all(
    `SELECT t.id AS target_id, t.posted_at, p.scheduled_at, a.label AS account, a.kind AS platform, t.external_id, t.url,
            COALESCE(t.text_override, p.text) AS text, tp.name AS template
       FROM targets t
       JOIN posts p ON p.id = t.post_id
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN templates tp ON tp.id = p.template_id
      WHERE t.status = 'posted'
      ORDER BY t.posted_at DESC, t.id DESC`,
  ).filter((r) => {
    const when = Date.parse(String(r.posted_at ?? r.scheduled_at));
    return (Number.isNaN(from) || when >= from) && (Number.isNaN(to) || when <= to + 86_400_000 - 1);
  });
  const records = rows.map((r) => ({
    postedAt: r.posted_at ?? "",
    channel: r.account,
    platform: r.platform,
    platformPostId: r.external_id ?? "",
    link: r.url ?? "",
    template: r.template ?? "",
    text: String(r.text ?? ""),
    internalId: r.target_id,
  }));
  if (req.query.format === "json") {
    res.json({ posts: records });
    return;
  }
  const columns = ["postedAt", "channel", "platform", "platformPostId", "link", "template", "text", "internalId"] as const;
  const csv = [columns.join(","), ...records.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\r\n");
  res
    .type("text/csv; charset=utf-8")
    .set("Content-Disposition", `attachment; filename="published-posts-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send(`\uFEFF${csv}\r\n`);
});

// ---------------------------------------------------------------- post numbers (views, reach and so on)

app.get("/api/stats", (req, res) => {
  const days = Math.min(Math.max(Math.floor(Number(req.query.days)) || 30, 1), 365);
  const rows = statsRows(new Date(Date.now() - days * 86_400_000).toISOString());
  const accounts = all("SELECT id, kind, label FROM accounts ORDER BY label");
  res.json({
    days,
    rows,
    // What is stopping some numbers, once per channel, so it can be shown as a to-do rather than on every row.
    problems: [...new Set(rows.flatMap((r) => r.notes.map((n) => `${r.channel}|${n}`)))].map((s) => {
      const [channel, ...note] = s.split("|");
      return { channel, note: note.join("|") };
    }),
    accounts,
    archive: archiveInfo(),
  });
});

let refreshingStats = false;
app.post("/api/stats/refresh", async (req, res) => {
  if (refreshingStats) throw new HttpError(409, "Already reading the numbers. Try again in a minute.");
  refreshingStats = true;
  try {
    const result = await collectStats(new Date(), { force: true });
    audit(req, "stats.refresh", `${result.read} read, ${result.failed} failed`);
    res.json({ ok: true, ...result });
  } finally {
    refreshingStats = false;
  }
});

app.post("/api/stats/import", express.json({ limit: "8mb" }), (req, res) => {
  const csv = typeof req.body?.csv === "string" ? req.body.csv : "";
  if (!csv.trim()) throw new HttpError(400, "That file was empty.");
  const result = importTikTokCsv(csv);
  audit(req, "stats.import", `TikTok file: ${result.matched} matched, ${result.unmatched} not`);
  res.json(result);
});

/** ?month=2026-08, or the month before last when left out. */
function archiveMonth(query: unknown): string {
  const month = typeof query === "string" && query ? query : monthBeforeLast();
  try {
    return checkArchivableMonth(month);
  } catch (e) {
    throw new HttpError(400, errMsg(e));
  }
}

app.get("/api/export/stats", (req, res) => {
  const month = archiveMonth(req.query.month);
  const csv = monthlyCsv(month);
  if (!csv) throw new HttpError(404, `Nothing was posted in ${monthLabel(month)}, so there is nothing to export.`);
  audit(req, "stats.export", month);
  res
    .type("text/csv; charset=utf-8")
    .set("Content-Disposition", `attachment; filename="post-stats-${month}.csv"`)
    .send(csv);
});

// Clears a month's numbers once they've been exported. It never touches the posts themselves.
app.post("/api/stats/clear-month", requireAdmin, (req, res) => {
  if (req.body?.confirm !== true) throw new HttpError(400, "Confirm that the month has been exported first.");
  const month = archiveMonth(req.body?.month);
  const result = clearMonth(month);
  audit(req, "stats.clear", `${month}: ${result.readings} readings for ${result.posts} posts`);
  res.json({ ok: true, month, label: monthLabel(month), ...result });
});

app.get("/api/backup", requireAdmin, async (_req, res) => {
  res.json({ ...backupStatus(), disk: await diskUsage(), memory: readMemory() });
});

app.post("/api/backup/run", requireAdmin, async (req, res) => {
  const result = await runBackup().catch((e) => {
    throw new HttpError(500, errMsg(e));
  });
  audit(req, "backup.run", `${result.bytes} bytes`);
  res.json({ ok: true, ...result });
});

app.get("/api/audit", requireAdmin, (req, res) => {
  res.json({ entries: recentAudit(Number(req.query.limit ?? 200)) });
});

// ---------------------------------------------------------------- Claude drafting

app.post("/api/draft", async (req, res) => {
  const { kind, libraryId, brief = "", accountIds = [], currentText = "" } = req.body ?? {};
  if (kind !== "text" && kind !== "alt") throw new HttpError(400, "Unknown draft type.");
  const mediaPath = libraryId ? libraryFile(Number(libraryId)).file : null;

  const accounts = Array.isArray(accountIds)
    ? accountIds.flatMap((id) => {
        const row = get("SELECT * FROM accounts WHERE id = ?", Number(id));
        return row ? [row] : [];
      })
    : [];
  const limits = accounts.map((a) => providerFor(a.kind).textLimit(readConfig(a.config)));
  try {
    const options = await draft({
      kind,
      mediaPath,
      brief: String(brief),
      charLimit: limits.length ? Math.min(...limits) : 300,
      platforms: accounts.length ? accounts.map((a) => a.label) : ["social media"],
      currentText: String(currentText),
    }, req.user?.id);
    res.json({ options });
  } catch (e) {
    throw explainClaudeError(e);
  }
});

// ---------------------------------------------------------------- errors + startup

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  // A request the browser or a tool got wrong (not JSON, too big): the sender's mistake, not a fault here.
  const status = (error as { status?: number })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const type = (error as { type?: string }).type;
    res.status(status).json({ error: type === "entity.too.large" ? "That request is too large." : type === "entity.parse.failed" ? "That request wasn't valid JSON." : "That request wasn't understood." });
    return;
  }
  console.error(error);
  res.status(500).json({ error: errMsg(error) });
});

// Refuse to run with the wrong key, and encrypt anything still stored as plain text (an upgrade, or a restored backup).
try {
  checkDataKey();
  const sealed = sealStoredSecrets();
  if (sealed > 0) console.log(`Encrypted ${sealed} stored sign-in detail${sealed === 1 ? "" : "s"}.`);
} catch (error) {
  console.error(errMsg(error));
  process.exit(1);
}

if (config.authMode === "google") seedAdmins(config.adminEmails);
moveSharedKeyToItsOwner();
seedTemplates();
seedWikiSettings();
// The test suite turns this off (SEED_MANUAL_ACCOUNTS=off) so its servers start with no accounts at all.
if (process.env.SEED_MANUAL_ACCOUNTS !== "off") seedManualAccounts();
pruneMissingFiles(); // after a restore, library entries whose files weren't in the backup would show as broken pictures

const server = app.listen(PORT, config.bindHost, () => {
  setKeepAwake(getSetting("keep_awake", "true") === "true");
  startScheduler();
  setInterval(() => void maybeRunNightly(), 60_000).unref();
  setInterval(() => void checkDisk(), 3_600_000).unref();
  startMemorySampler();
  void checkDisk();
  console.log(`Social scheduler running at ${ORIGIN}`);
  if (process.platform === "darwin") {
    console.log(isKeepingAwake() ? "Keeping this Mac awake while the app runs (caffeinate)." : "Not keeping the Mac awake.");
  }
  if (process.env.NO_OPEN !== "1" && process.platform === "darwin" && config.authMode === "local") {
    execFile("open", [ORIGIN], () => {});
  }
});

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Is the scheduler already running? (Set PORT=... to use another.)`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

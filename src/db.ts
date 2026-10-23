// Must come first: a new server may restore a backup into the data folder, and that has to finish before the
// database is opened. (Importing it here, rather than relying on import order elsewhere, is what guarantees that.)
import "./boot.ts";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { isSealed, open, openJson, seal, SecretBoxError, sealJson } from "./secretbox.ts";

// Everything we store (account tokens, images) is private to this user.
process.umask(0o077);

export const DATA_DIR = path.resolve(process.env.SOCIAL_SCHEDULER_DATA ?? "data");
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const THUMB_DIR = path.join(DATA_DIR, "thumbs");
/** Pictures and videos people have uploaded, kept under their content hash. */
export const LIBRARY_DIR = path.join(DATA_DIR, "library");
/** Uploads in progress, so a half-sent file is never mistaken for a real one. */
export const TMP_DIR = path.join(DATA_DIR, "tmp");
for (const dir of [DATA_DIR, MEDIA_DIR, THUMB_DIR, LIBRARY_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "scheduler.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id         INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL,
    label      TEXT NOT NULL,
    config     TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id           INTEGER PRIMARY KEY,
    text         TEXT NOT NULL,
    alt_text     TEXT NOT NULL DEFAULT '',
    media_file   TEXT NOT NULL,
    source_path  TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS targets (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    status     TEXT NOT NULL DEFAULT 'scheduled',
    url        TEXT,
    error      TEXT,
    posted_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS library (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    stored     TEXT NOT NULL UNIQUE,
    sha256     TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  -- The approved people. Someone not in this table can never sign in, whatever Google says about them.
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'member',
    status        TEXT NOT NULL DEFAULT 'active',
    google_sub    TEXT UNIQUE,
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );

  -- Only a hash of each session's secret is kept, so a copy of the database can't be used to sign in.
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash      TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ip           TEXT,
    user_agent   TEXT
  );

  CREATE TABLE IF NOT EXISTS audit (
    id      INTEGER PRIMARY KEY,
    at      TEXT NOT NULL,
    user_id INTEGER,
    email   TEXT NOT NULL,
    action  TEXT NOT NULL,
    detail  TEXT NOT NULL DEFAULT ''
  );

  -- Reusable post text for things that come round again (a weekly feature, a monthly session).
  CREATE TABLE IF NOT EXISTS templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    body        TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    rules       TEXT NOT NULL DEFAULT '[]',
    account_ids TEXT NOT NULL DEFAULT '[]',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  -- What each platform said about a posted post, now and then (about a day, a week and a month after it went out).
  CREATE TABLE IF NOT EXISTS target_stats (
    target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    stage     TEXT NOT NULL,
    taken_at  TEXT NOT NULL,
    metrics   TEXT NOT NULL DEFAULT '{}',
    notes     TEXT NOT NULL DEFAULT '[]',
    error     TEXT,
    source    TEXT NOT NULL DEFAULT 'api',
    PRIMARY KEY (target_id, stage)
  );

  CREATE INDEX IF NOT EXISTS idx_targets_status ON targets(status);
  CREATE INDEX IF NOT EXISTS idx_posts_source ON posts(source_path);
`);

/**
 * Library ids must never be reused: posts remember `library:<id>`, and browsers cache thumbnails by id, so a
 * reused id would show a deleted picture's thumbnail and "Posted" tag on a different file. Tables created before
 * this was fixed lacked AUTOINCREMENT, so rebuild them, keeping every id and starting past any id a post still names.
 */
export function ensureLibraryNeverReusesIds(database: DatabaseSync): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'library'").get() as { sql?: string } | undefined;
  if (!row?.sql || /AUTOINCREMENT/i.test(row.sql)) return;
  database.exec("BEGIN");
  try {
    database.exec(`
      CREATE TABLE library_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        stored     TEXT NOT NULL UNIQUE,
        sha256     TEXT NOT NULL UNIQUE,
        kind       TEXT NOT NULL,
        size       INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO library_new (id, name, stored, sha256, kind, size, created_at) SELECT id, name, stored, sha256, kind, size, created_at FROM library;
      DROP TABLE library;
      ALTER TABLE library_new RENAME TO library;
    `);
    let highest = Number((database.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM library").get() as { n: number }).n);
    for (const p of database.prepare("SELECT source_path FROM posts WHERE source_path LIKE 'library:%'").all() as { source_path: string }[]) {
      highest = Math.max(highest, Number(p.source_path.slice("library:".length)) || 0);
    }
    database.prepare("DELETE FROM sqlite_sequence WHERE name = 'library'").run();
    database.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('library', ?)").run(highest);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
ensureLibraryNeverReusesIds(db);

// Added after the first release. 'local' targets are posted by this app at the scheduled time;
// 'remote' targets are held by the platform itself (e.g. Mastodon's scheduled posts), and
// `remote` stores whatever we need to find/cancel them there.
const targetColumns = (db.prepare("PRAGMA table_info(targets)").all() as { name: string }[]).map((c) => c.name);
if (!targetColumns.includes("mode")) db.exec("ALTER TABLE targets ADD COLUMN mode TEXT NOT NULL DEFAULT 'local'");
if (!targetColumns.includes("remote")) db.exec("ALTER TABLE targets ADD COLUMN remote TEXT");

// Per-channel changes to a post. NULL means "use the post's own"; no_media = 1 posts that channel without the image or video.
for (const [column, ddl] of [
  ["text_override", "TEXT"],
  ["title_override", "TEXT"],
  ["alt_override", "TEXT"],
  ["no_media", "INTEGER NOT NULL DEFAULT 0"],
] as const) {
  if (!targetColumns.includes(column)) db.exec(`ALTER TABLE targets ADD COLUMN ${column} ${ddl}`);
}

const postColumns = (db.prepare("PRAGMA table_info(posts)").all() as { name: string }[]).map((c) => c.name);
// More pictures after the first, as JSON: [{ file, source, alt }]. `media_file` / `source_path` / `alt_text` stay the first picture.
// Each person's own Anthropic API key for "Draft with Claude" (encrypted like the other secrets).
const userColumns = (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
if (!userColumns.includes("anthropic_key")) db.exec("ALTER TABLE users ADD COLUMN anthropic_key TEXT NOT NULL DEFAULT ''");
if (!postColumns.includes("extra_media")) db.exec("ALTER TABLE posts ADD COLUMN extra_media TEXT NOT NULL DEFAULT '[]'");
if (!postColumns.includes("title")) db.exec("ALTER TABLE posts ADD COLUMN title TEXT NOT NULL DEFAULT ''");
// The template a post was made from, so "due this week" can tell what has already been scheduled.
if (!postColumns.includes("template_id")) db.exec("ALTER TABLE posts ADD COLUMN template_id INTEGER");
// What was typed into the template's blanks, so the wiki row can reuse it (the surname, the place, the member...).
if (!postColumns.includes("template_values")) db.exec("ALTER TABLE posts ADD COLUMN template_values TEXT");

// How a template's post appears as a row of the wiki's social media posts table.
const templateColumns = (db.prepare("PRAGMA table_info(templates)").all() as { name: string }[]).map((c) => c.name);
for (const [column, ddl] of [
  ["wiki_subject", "TEXT NOT NULL DEFAULT ''"],
  ["wiki_style", "TEXT NOT NULL DEFAULT ''"],
  ["wiki_bold", "INTEGER NOT NULL DEFAULT 0"],
  ["wiki_playlist", "TEXT NOT NULL DEFAULT ''"],
] as const) {
  if (!templateColumns.includes(column)) db.exec(`ALTER TABLE templates ADD COLUMN ${column} ${ddl}`);
}
// A week where a regular post isn't happening, so it stops showing as "coming up".
db.exec("CREATE TABLE IF NOT EXISTS template_skips (template_id INTEGER NOT NULL, day TEXT NOT NULL, PRIMARY KEY (template_id, day))");
// The platform's own id for a published post (a Mastodon status id, a Facebook post id, an Instagram media id...).
if (!targetColumns.includes("external_id")) db.exec("ALTER TABLE targets ADD COLUMN external_id TEXT");
// For platforms with no API: when the person said they had scheduled the post themselves on the platform's own tool.
if (!targetColumns.includes("handed_off_at")) db.exec("ALTER TABLE targets ADD COLUMN handed_off_at TEXT");
// YouTube: use the first frame of the video as its thumbnail.
if (!targetColumns.includes("thumb_first_frame")) db.exec("ALTER TABLE targets ADD COLUMN thumb_first_frame INTEGER NOT NULL DEFAULT 0");

export type Row = Record<string, any>;

export function all(sql: string, ...params: any[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

export function get(sql: string, ...params: any[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}

export function getSetting(key: string, fallback = ""): string {
  const row = get("SELECT value FROM settings WHERE key = ?", key);
  return row ? String(row.value) : fallback;
}

export function setSetting(key: string, value: string): void {
  run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

/** JSON settings hold sign-in details (app secrets, the image host's keys), so they are stored encrypted. */
export function getJsonSetting<T>(key: string, fallback: T): T {
  const raw = getSetting(key);
  if (!raw) return fallback;
  try {
    return openJson<T>(raw);
  } catch (error) {
    if (error instanceof SecretBoxError) throw error; // a wrong key must be loud, not an empty setting
    return fallback;
  }
}

export function setJsonSetting(key: string, value: unknown): void {
  setSetting(key, sealJson(value));
}

/** A single secret string (such as the Anthropic API key), stored encrypted. */
export function getSecretSetting(key: string): string {
  const raw = getSetting(key);
  return raw ? open(raw) : "";
}

export function setSecretSetting(key: string, value: string): void {
  setSetting(key, value ? seal(value) : "");
}

/** An account's saved sign-in details, as stored. Accounts hold tokens, so they are stored encrypted. */
export const readConfig = (stored: string): Record<string, any> => openJson(stored);
export const writeConfig = (value: unknown): string => sealJson(value);

const SECRET_STRING_SETTINGS = ["anthropic_api_key"];

/**
 * Encrypts anything still stored as plain text (from before a DATA_KEY was set, or from a restored backup
 * made elsewhere). Safe to run on every start: values that are already encrypted are left alone.
 */
export function sealStoredSecrets(): number {
  if (!config.dataKey) return 0;
  let changed = 0;
  for (const row of all("SELECT id, config FROM accounts")) {
    if (!isSealed(String(row.config))) {
      run("UPDATE accounts SET config = ? WHERE id = ?", seal(String(row.config)), row.id);
      changed++;
    }
  }
  for (const row of all("SELECT id, anthropic_key FROM users WHERE anthropic_key != ''")) {
    if (!isSealed(String(row.anthropic_key))) {
      run("UPDATE users SET anthropic_key = ? WHERE id = ?", seal(String(row.anthropic_key)), row.id);
      changed++;
    }
  }
  for (const row of all("SELECT key, value FROM settings")) {
    const secret = SECRET_STRING_SETTINGS.includes(String(row.key)) || String(row.key).startsWith("app:") || row.key === "public_host";
    if (secret && row.value && !isSealed(String(row.value))) {
      setSetting(String(row.key), seal(String(row.value)));
      changed++;
    }
  }
  return changed;
}

/** Stops the app starting with the wrong key, which would otherwise show up later as mysterious failures. */
export function checkDataKey(): void {
  const sample = get("SELECT config FROM accounts WHERE config LIKE 'enc1:%' LIMIT 1");
  if (sample) open(String(sample.config)); // throws a plain-English SecretBoxError if the key is wrong
}

export const DEFAULT_STYLE_GUIDE = `WikiTree is a free, collaborative genealogy community building one shared family tree that stays free and accessible forever.
Voice: warm, welcoming and plain-spoken. No hype, no clickbait, no guilt-tripping.
Describe what the image shows and invite people to take part or learn more. Never invent facts that aren't in the image or the brief.
At most 2-3 relevant hashtags (for example #genealogy #familyhistory #WikiTree), and use emoji sparingly.`;

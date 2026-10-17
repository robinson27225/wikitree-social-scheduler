import { METRICS } from "../public/stats-sum.js";
import { all, get, getSetting, readConfig, run, setSetting, writeConfig } from "./db.ts";
import { providerFor } from "./providers/index.ts";
import { withTotals } from "./providers/insights.ts";
import type { Config, MetricKey, ProviderContext } from "./providers/types.ts";
import { errMsg } from "./util.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Numbers are taken about a day, a week and a month after a post goes out, then left alone. */
const STAGES = [
  { name: "d1", afterMs: DAY },
  { name: "d7", afterMs: 7 * DAY },
  { name: "d30", afterMs: 30 * DAY },
] as const;
const STOP_AFTER_MS = 45 * DAY;
/** A failed attempt is tried again after this long, so a missing permission isn't hammered every few minutes. */
const RETRY_FAILED_AFTER_MS = 6 * HOUR;
const MAX_PER_PASS = 40;
const MAX_PER_REFRESH = 200;

let collecting = false;

function contextFor(accountId: number): ProviderContext {
  return {
    saveConfig(patch: Config) {
      const row = get("SELECT config FROM accounts WHERE id = ?", accountId);
      if (!row) return;
      const merged = { ...readConfig(row.config), ...patch };
      run("UPDATE accounts SET config = ? WHERE id = ?", writeConfig(merged), accountId);
    },
  };
}

interface Candidate {
  id: number;
  external_id: string;
  url: string | null;
  posted_at: string;
  account_id: number;
  kind: string;
}

function candidates(now: Date): Candidate[] {
  return all(
    `SELECT t.id, t.external_id, t.url, t.posted_at, t.account_id, a.kind
       FROM targets t JOIN accounts a ON a.id = t.account_id
      WHERE t.status = 'posted' AND t.external_id IS NOT NULL AND t.external_id != '' AND t.posted_at >= ?
      ORDER BY t.posted_at`,
    new Date(now.getTime() - STOP_AFTER_MS).toISOString(),
  ) as Candidate[];
}

function save(targetId: number, stage: string, takenAt: Date, metrics: object, notes: string[], error: string | null, source = "api"): void {
  run(
    `INSERT INTO target_stats (target_id, stage, taken_at, metrics, notes, error, source) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(target_id, stage) DO UPDATE SET taken_at = excluded.taken_at, metrics = excluded.metrics,
       notes = excluded.notes, error = excluded.error, source = excluded.source`,
    targetId,
    stage,
    takenAt.toISOString(),
    JSON.stringify(metrics),
    JSON.stringify(notes),
    error,
    source,
  );
}

async function readOne(c: Candidate, stage: string, now: Date): Promise<boolean> {
  try {
    const provider = providerFor(c.kind);
    const account = get("SELECT config FROM accounts WHERE id = ?", c.account_id);
    if (!provider.fetchStats || !account) return false;
    const result = await provider.fetchStats(
      readConfig(account.config),
      { externalId: c.external_id, url: c.url, postedAt: c.posted_at },
      contextFor(c.account_id),
    );
    save(c.id, stage, now, result.metrics, result.notes, null);
    return true;
  } catch (e) {
    save(c.id, stage, now, {}, [], errMsg(e));
    return false;
  }
}

/**
 * Reads the numbers for posts that are due for a reading: one per post at about a day, a week and a month after it went out.
 * `force` instead re-reads every recent post now (the Refresh button). Only ever reads from the platforms.
 */
export async function collectStats(now: Date = new Date(), options: { force?: boolean } = {}): Promise<{ read: number; failed: number }> {
  if (collecting) return { read: 0, failed: 0 };
  collecting = true;
  let read = 0;
  let failed = 0;
  try {
    let done = 0;
    for (const c of candidates(now)) {
      if (done >= (options.force ? MAX_PER_REFRESH : MAX_PER_PASS)) break;
      let provider;
      try {
        provider = providerFor(c.kind);
      } catch {
        continue;
      }
      if (!provider.fetchStats || isCleared(c.posted_at)) continue;
      const age = now.getTime() - Date.parse(c.posted_at);
      if (!Number.isFinite(age)) continue;

      let stage: string | undefined;
      if (options.force) {
        if (age < 10 * 60_000) continue; // platforms need a few minutes before they can say anything
        stage = "now";
      } else {
        // Only the latest stage that has come due: a post that is 10 days old and never read gets its week reading, not a day one.
        stage = [...STAGES].reverse().find((s) => age >= s.afterMs)?.name;
        if (!stage) continue;
        const existing = get("SELECT taken_at, error FROM target_stats WHERE target_id = ? AND stage = ?", c.id, stage);
        if (existing && (!existing.error || now.getTime() - Date.parse(existing.taken_at) < RETRY_FAILED_AFTER_MS)) continue;
      }
      done++;
      if (await readOne(c, stage, now)) read++;
      else failed++;
    }
  } finally {
    collecting = false;
  }
  return { read, failed };
}

// ---------------------------------------------------------------- what the Stats tab shows

export interface StatsRow {
  targetId: number;
  postId: number;
  accountId: number;
  channel: string;
  platform: string;
  postedAt: string;
  url: string | null;
  text: string;
  template: string | null;
  /** When the numbers were read, or null if none have been. */
  takenAt: string | null;
  stage: string | null;
  source: string | null;
  metrics: Partial<Record<MetricKey, number>>;
  notes: string[];
  /** Why the latest attempt failed, if it did. */
  error: string | null;
  /** False for channels that give no numbers (X, Reddit and so on): they are left out of the tab. */
  tracked: boolean;
}

/** Whether a manual account is the TikTok one (its numbers come from the monthly file, not an API). */
export function isTikTokAccount(config: Config): boolean {
  return /tiktok\.com/i.test(String(config.url ?? ""));
}

export function statsRows(sinceIso: string): StatsRow[] {
  const rows = all(
    `SELECT t.id AS target_id, t.posted_at, t.url, p.id AS post_id, COALESCE(t.text_override, p.text) AS text,
            a.id AS account_id, a.label, a.kind, a.config, tp.name AS template,
            s.stage, s.taken_at, s.metrics, s.notes, s.source,
            (SELECT error FROM target_stats WHERE target_id = t.id AND error IS NOT NULL ORDER BY taken_at DESC LIMIT 1) AS last_error
       FROM targets t
       JOIN posts p ON p.id = t.post_id
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN templates tp ON tp.id = p.template_id
       LEFT JOIN target_stats s ON s.target_id = t.id AND s.error IS NULL
            AND s.taken_at = (SELECT MAX(taken_at) FROM target_stats WHERE target_id = t.id AND error IS NULL)
      WHERE t.status = 'posted' AND t.posted_at >= ?
      ORDER BY t.posted_at DESC, t.id DESC`,
    sinceIso,
  );
  const out: StatsRow[] = [];
  for (const r of rows) {
    let tracked = false;
    try {
      const provider = providerFor(r.kind);
      tracked = Boolean(provider.fetchStats) || (provider.manual !== undefined && isTikTokAccount(readConfig(r.config)));
    } catch {
      /* unknown kind: not tracked */
    }
    if (!tracked) continue;
    out.push({
      targetId: r.target_id,
      postId: r.post_id,
      accountId: r.account_id,
      channel: r.label,
      platform: r.kind,
      postedAt: r.posted_at,
      url: r.url,
      text: String(r.text ?? ""),
      template: r.template ?? null,
      takenAt: r.taken_at ?? null,
      stage: r.stage ?? null,
      source: r.source ?? null,
      metrics: r.metrics ? JSON.parse(r.metrics) : {},
      notes: r.notes ? JSON.parse(r.notes) : [],
      // An old failure doesn't matter once numbers have since arrived.
      error: r.taken_at ? null : (r.last_error ?? null),
      tracked,
    });
  }
  return out;
}

// ---------------------------------------------------------------- the monthly export, and clearing out what has been exported

const pad = (n: number) => String(n).padStart(2, "0");
/** The calendar day (in the server's own time zone, Pacific on Fly) a moment falls on, as YYYY-MM-DD. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The month before last as YYYY-MM: on 5 October that is August. By then every August post has had its month-old reading. */
export function monthBeforeLast(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

/** The last day of a month, as YYYY-MM-DD. */
const lastDayOf = (month: string): string => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${pad(new Date(y, m, 0).getDate())}`;
};

/** A month the person may export or clear: the month before last, or an earlier one. Throws a message for anything else. */
export function checkArchivableMonth(month: unknown, now: Date = new Date()): string {
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Choose a month like 2026-08.");
  const latest = monthBeforeLast(now);
  if (month > latest) throw new Error(`Only ${monthLabel(latest)} and earlier can be exported or cleared. More recent posts are still having their numbers read.`);
  return month;
}

/** Posts that went out in a month, and are on a channel that gives numbers. */
function postsInMonth(month: string): StatsRow[] {
  const [y, m] = month.split("-").map(Number);
  // A day either side, then the exact test in local time.
  const since = new Date(y, m - 1, 1, 0, 0, 0).getTime() - DAY;
  return statsRows(new Date(since).toISOString()).filter((r) => localDay(r.postedAt).startsWith(month));
}

/** What the Stats tab says about the month before last: how many posts and readings it covers, and whether it's already cleared. */
export function archiveInfo(now: Date = new Date()) {
  const month = monthBeforeLast(now);
  const rows = postsInMonth(month);
  return {
    month,
    label: monthLabel(month),
    posts: rows.length,
    withNumbers: rows.filter((r) => Object.keys(r.metrics).length > 0).length,
    clearedThrough: getSetting("stats_cleared_through", "") || null,
  };
}

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * One row per day per channel for a month: the day's posts added up, using each post's latest reading.
 * A number is left blank when none of that day's posts on that channel reported it (blank is "not reported", not zero).
 * Returns null when nothing was posted that month.
 */
export function monthlyCsv(month: string): string | null {
  const rows = postsInMonth(month);
  if (!rows.length) return null;
  const groups = new Map<string, { day: string; channel: string; platform: string; posts: number; withNumbers: number; totals: Record<string, number> }>();
  for (const r of rows) {
    const day = localDay(r.postedAt);
    const key = `${day}\t${r.channel}`;
    let g = groups.get(key);
    if (!g) {
      g = { day, channel: r.channel, platform: r.platform, posts: 0, withNumbers: 0, totals: {} };
      groups.set(key, g);
    }
    g.posts++;
    if (Object.keys(r.metrics).length) g.withNumbers++;
    for (const [k, v] of Object.entries(r.metrics)) if (typeof v === "number") g.totals[k] = (g.totals[k] ?? 0) + v;
  }
  const head = ["date", "channel", "platform", "posts", "posts_with_numbers", ...METRICS.map((m: { key: string }) => m.key)];
  const lines = [...groups.values()]
    .sort((a, b) => a.day.localeCompare(b.day) || a.channel.localeCompare(b.channel))
    .map((g) => [g.day, g.channel, g.platform, g.posts, g.withNumbers, ...METRICS.map((m: { key: string }) => g.totals[m.key])].map(csvCell).join(","));
  return `\uFEFF${[head.join(","), ...lines].join("\r\n")}\r\n`;
}

/**
 * Deletes the numbers for posts that went out in a month (never the posts themselves), and remembers the month is
 * cleared so they aren't read again or re-imported. The caller has already checked the month with checkArchivableMonth.
 */
export function clearMonth(month: string): { readings: number; posts: number } {
  const rows = postsInMonth(month);
  let readings = 0;
  for (const r of rows) readings += Number(run("DELETE FROM target_stats WHERE target_id = ?", r.targetId).changes);
  const through = lastDayOf(month);
  if (through > getSetting("stats_cleared_through", "")) setSetting("stats_cleared_through", through);
  return { readings, posts: rows.length };
}

/** True for a post on a day that has been cleared out. */
const isCleared = (iso: string): boolean => {
  const through = getSetting("stats_cleared_through", "");
  return Boolean(through) && localDay(iso) <= through;
};

// ---------------------------------------------------------------- TikTok's monthly file

/** Splits CSV text into rows of cells. Handles quoted cells, doubled quotes, and either line ending. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const COLUMN_RULES: { metric: MetricKey; match: RegExp; not?: RegExp }[] = [
  { metric: "views", match: /\b(video )?views?\b|\bplays?\b/, not: /profile/ },
  { metric: "reach", match: /reach/ },
  { metric: "viewers", match: /(unique )?viewers/ },
  { metric: "likes", match: /\blikes?\b/ },
  { metric: "comments", match: /\bcomments?\b/ },
  { metric: "shares", match: /\bshares?\b/ },
  { metric: "saves", match: /\b(saves?|favou?rites?|bookmarks?)\b/ },
  { metric: "visits", match: /profile views?|profile visits?/ },
  { metric: "follows", match: /new followers?|follows?\b|followers gained/ },
  { metric: "link_clicks", match: /link clicks?|\bclicks?\b/ },
];

const norm = (header: string) => header.toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();

export interface ImportResult {
  rows: number;
  matched: number;
  unmatched: number;
  /** Rows for posts from a month that has already been exported and cleared, which are left out. */
  alreadyCleared: number;
  /** Titles of rows that matched none of the TikTok posts made here (a few, to show). */
  unmatchedExamples: string[];
  /** The numbers found in the file. */
  found: string[];
  /** Headers that weren't recognised, so a file in an unexpected shape can be explained. */
  ignoredHeaders: string[];
  /** Set when the file can't be tied to posts at all. */
  problem?: string;
}

const numberOf = (cell: string | undefined): number | undefined => {
  if (cell === undefined) return undefined;
  const t = cell.trim().replace(/,/g, "");
  if (!t || t === "-" || /^n\/?a$/i.test(t)) return undefined;
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!m) return undefined;
  const base = Number(m[1]);
  return Math.round(m[2] ? base * (m[2].toLowerCase() === "k" ? 1e3 : 1e6) : base);
};

const dayOf = (cell: string | undefined): string | undefined => {
  if (!cell) return undefined;
  const t = cell.trim();
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // 10/14/2026
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  const parsed = Date.parse(t);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : undefined;
};

/**
 * Reads TikTok Studio's content download (one row per video) and attaches the numbers to the TikTok posts made here.
 * A row is matched by the video's link if the file has one, otherwise by the day it was posted (and, if several went out
 * that day, by the start of its text). Numbers from a later download replace earlier ones.
 */
export function importTikTokCsv(text: string, now: Date = new Date()): ImportResult {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t"].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const table = parseCsv(text, delimiter);
  const empty: ImportResult = { rows: 0, matched: 0, unmatched: 0, alreadyCleared: 0, unmatchedExamples: [], found: [], ignoredHeaders: [] };
  if (table.length < 2) return { ...empty, problem: "That file has no rows in it." };

  const headers = table[0].map(norm);
  const columnOf = (re: RegExp, not?: RegExp) => headers.findIndex((h) => re.test(h) && !(not && not.test(h)));
  const linkCol = columnOf(/link|url/);
  const dateCol = columnOf(/post (time|date)|publish|created|^date\b|^time\b/);
  const titleCol = columnOf(/title|caption|description|video name/);

  const metricCols: { metric: MetricKey; col: number }[] = [];
  const used = new Set<number>([linkCol, dateCol, titleCol]);
  for (const rule of COLUMN_RULES) {
    // Prefer "total ..." columns when the file has both a total and a per-period figure.
    const exact = headers.findIndex((h, i) => !used.has(i) && rule.match.test(h) && !(rule.not && rule.not.test(h)) && /^total/.test(h));
    const col = exact >= 0 ? exact : headers.findIndex((h, i) => !used.has(i) && rule.match.test(h) && !(rule.not && rule.not.test(h)));
    if (col >= 0) {
      metricCols.push({ metric: rule.metric, col });
      used.add(col);
    }
  }
  const ignoredHeaders = table[0].filter((_, i) => !used.has(i));
  const found = metricCols.map((c) => METRICS.find((m: { key: string }) => m.key === c.metric)?.label ?? c.metric);
  if (metricCols.length === 0) {
    return { ...empty, rows: table.length - 1, ignoredHeaders, problem: "I couldn't find any numbers I recognise (views, likes, comments, shares…) in that file's column headings." };
  }
  if (linkCol < 0 && dateCol < 0) {
    return { ...empty, rows: table.length - 1, found, ignoredHeaders, problem: "That file has no video link or post date, so I can't tell which post each row is. It may be the account-wide summary rather than the per-video one." };
  }

  const posts = all(
    `SELECT t.id, t.url, t.posted_at, a.config, COALESCE(t.text_override, p.text) AS text, p.scheduled_at
       FROM targets t JOIN posts p ON p.id = t.post_id JOIN accounts a ON a.id = t.account_id
      WHERE t.status = 'posted' AND a.kind = 'manual'`,
  ).filter((r) => isTikTokAccount(readConfig(r.config)));

  const result: ImportResult = { ...empty, rows: table.length - 1, found, ignoredHeaders };
  for (const row of table.slice(1)) {
    const link = linkCol >= 0 ? (row[linkCol] ?? "").trim() : "";
    const videoId = link.match(/\/video\/(\d+)/)?.[1];
    const day = dayOf(dateCol >= 0 ? row[dateCol] : undefined);
    const title = (titleCol >= 0 ? row[titleCol] : "")?.trim() ?? "";

    let match = videoId ? posts.find((p) => p.url && String(p.url).includes(videoId)) : undefined;
    if (!match && day) {
      const sameDay = posts.filter((p) => String(p.posted_at ?? p.scheduled_at).slice(0, 10) === day || String(p.scheduled_at).slice(0, 10) === day);
      if (sameDay.length === 1) match = sameDay[0];
      else if (sameDay.length > 1 && title) {
        const key = title.toLowerCase().slice(0, 30);
        match = sameDay.find((p) => String(p.text).toLowerCase().includes(key) || key.includes(String(p.text).toLowerCase().slice(0, 30)));
      }
    }
    if (!match) {
      result.unmatched++;
      if (result.unmatchedExamples.length < 5) result.unmatchedExamples.push(title || link || day || "(row)");
      continue;
    }
    const metrics: Partial<Record<MetricKey, number>> = {};
    for (const { metric, col } of metricCols) {
      const n = numberOf(row[col]);
      if (n !== undefined) metrics[metric] = n;
    }
    if (isCleared(String(match.posted_at ?? match.scheduled_at))) {
      result.alreadyCleared++;
      continue;
    }
    save(match.id, "import", now, withTotals(metrics), [], null, "csv");
    result.matched++;
  }
  return result;
}

import { placeholdersOf, fillTemplate } from "../public/template-text.js";
import { all, getJsonSetting, setJsonSetting } from "./db.ts";
import { providerFor } from "./providers/index.ts";
import { getTemplate } from "./templates.ts";
import { HttpError } from "./util.ts";

/**
 * The rows of WikiTree's social media posts table (Space:Social_Media_Posts), in wiki markup. One post is one row:
 *
 *   |- style="background:#F59122;"             (only for a template that has a row color)
 *   |Mon                                       the day
 *   !{{Tag Link|Question_of_the_Week}} ...     the subject (! for the table's bold style, | otherwise)
 *   |[https://www.facebook.com/.../123/ Link]  one cell per platform, empty when the post didn't go there
 *   ...nine of them, then
 *   |[https://www.youtube.com/post/.../ Link]<br>{{YouTube|id|playlist=X}}<br>{{G2GLink|2095616}}
 */

export const WIKI_COLUMNS = [
  { key: "facebook", label: "Facebook" },
  { key: "twitter", label: "Twitter" },
  { key: "mastodon", label: "Mastodon" },
  { key: "bluesky", label: "Bluesky" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "instagram", label: "Instagram" },
  { key: "threads", label: "Threads" },
  { key: "tiktok", label: "TikTok" },
  { key: "reddit", label: "Reddit" },
] as const;

/** Not in the table today; can be added at the end for a post that went to YouTube. */
export const YOUTUBE_COLUMN = { key: "youtube", label: "YouTube" } as const;

const ALL_KEYS = new Set<string>([...WIKI_COLUMNS.map((c) => c.key), YOUTUBE_COLUMN.key]);
const SETTING = "wiki_columns";

/** Which column an account's links go in when nobody has said otherwise. */
export function defaultColumn(account: { kind: string; label: string }): string | null {
  switch (account.kind) {
    case "facebook":
      // WikiTree's own Page has the column; the project and event Pages are separate Pages with their own links.
      return /project|symposium/i.test(account.label) ? null : "facebook";
    case "x":
      return "twitter";
    case "mastodon":
    case "bluesky":
    case "linkedin":
    case "instagram":
    case "threads":
    case "tiktok":
    case "reddit":
    case "youtube":
      return account.kind;
    case "manual":
      if (/twitter|(^|\W)x(\W|$)/i.test(account.label)) return "twitter";
      if (/reddit/i.test(account.label)) return "reddit";
      if (/tiktok/i.test(account.label)) return "tiktok";
      if (/linkedin/i.test(account.label)) return "linkedin";
      return null;
    default:
      return null;
  }
}

type ColumnMap = Record<string, string>;
const savedMap = () => getJsonSetting<ColumnMap>(SETTING, {});

/** The column for an account: what the team chose, else the default. "" means "none". */
export function columnFor(account: { id: number; kind: string; label: string }, map: ColumnMap = savedMap()): string | null {
  const chosen = map[String(account.id)];
  if (chosen !== undefined) return chosen === "" ? null : chosen;
  return defaultColumn(account);
}

export function listColumnSettings() {
  const map = savedMap();
  return {
    columns: [...WIKI_COLUMNS, YOUTUBE_COLUMN],
    accounts: all("SELECT id, kind, label FROM accounts ORDER BY id").map((a) => ({
      id: Number(a.id),
      label: String(a.label),
      kindLabel: providerFor(String(a.kind)).label,
      column: columnFor({ id: Number(a.id), kind: String(a.kind), label: String(a.label) }, map) ?? "",
    })),
  };
}

export function saveColumnSettings(input: unknown): void {
  if (!input || typeof input !== "object") throw new HttpError(400, "Send the choice for each account.");
  const next: ColumnMap = {};
  for (const [id, key] of Object.entries(input as Record<string, unknown>)) {
    if (!/^\d+$/.test(id) || typeof key !== "string" || (key !== "" && !ALL_KEYS.has(key))) {
      throw new HttpError(400, "That isn't a column in the table.");
    }
    next[id] = key;
  }
  setJsonSetting(SETTING, next);
}

// ---------------------------------------------------------------- building the rows

/** Wiki table cells break on | and read [ ] { } as markup, so show them as the plain characters they are. */
const plain = (text: string) => text.replace(/[|[\]{}]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\s+/g, " ").trim();
/** A link's address can't hold spaces or ] in wiki markup. */
const safeUrl = (url: string) => url.replace(/ /g, "%20").replace(/\]/g, "%5D").replace(/\|/g, "%7C");

/**
 * Makes a link look like the ones already on the page: twitter.com rather than x.com, Reddit without the title, and a
 * closing slash.
 */
export function wikiLink(column: string, raw: string): string {
  let url = raw.trim();
  if (column === "twitter") url = url.replace(/^https?:\/\/(www\.)?x\.com\//i, "https://twitter.com/");
  if (column === "reddit") url = url.replace(/^(https?:\/\/[^/]+\/r\/[^/]+\/comments\/[^/?#]+)\/.*$/i, "$1");
  if (!/[?#]/.test(url) && !url.endsWith("/")) url += "/";
  return safeUrl(url);
}

const VIDEO_ID = /(?:youtube\.com\/(?:shorts\/|watch\?v=|live\/|embed\/)|youtu\.be\/)([\w-]{6,})/i;
const G2G_ID = /wikitree\.com\/g2g\/(\d+)/i;

export interface WikiOptions {
  /** The time zone the day of the week is read in. Defaults to the server's. */
  tz?: string;
  /** Answers for the subject cell's blanks (the profile id, the image...), over what was saved with the post. */
  values?: Record<string, string>;
}

export interface WikiRow {
  postId: number;
  scheduledAt: string;
  text: string;
  /** Channels the post went to by hand with no link pasted in, so their cell is empty. */
  missingLinks: string[];
  /** Blanks in the subject cell that still need an answer (they stay showing as {{name}} until given). */
  blanks: string[];
}

interface PostFilter {
  postId?: number;
  from?: number;
  to?: number;
}

function weekday(iso: string, tz?: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", { weekday: "short", ...(tz ? { timeZone: tz } : {}) });
  } catch {
    throw new HttpError(400, "That isn't a time zone.");
  }
}

export function wikiRows(filter: PostFilter, options: WikiOptions = {}): WikiRow[] {
  const map = savedMap();
  const given = Object.fromEntries(Object.entries(options.values ?? {}).map(([k, v]) => [k.trim().toLowerCase(), String(v)]));
  const rows = all(
    `SELECT p.id AS post_id, p.scheduled_at, p.title, p.text, p.template_id, p.template_values,
            t.id AS target_id, t.url, t.external_id, t.posted_at, a.id AS account_id, a.kind, a.label
       FROM posts p
       JOIN targets t ON t.post_id = p.id
       JOIN accounts a ON a.id = t.account_id
      WHERE t.status = 'posted'
      ORDER BY p.scheduled_at, p.id, t.id`,
  );
  const byPost = new Map<number, typeof rows>();
  for (const r of rows) {
    const id = Number(r.post_id);
    if (filter.postId !== undefined && id !== filter.postId) continue;
    const when = Date.parse(String(r.posted_at ?? r.scheduled_at));
    if (filter.from !== undefined && when < filter.from) continue;
    if (filter.to !== undefined && when > filter.to) continue;
    if (!byPost.has(id)) byPost.set(id, []);
    byPost.get(id)!.push(r);
  }

  const out: WikiRow[] = [];
  for (const [postId, targets] of byPost) {
    const first = targets[0];
    const text = String(first.text ?? "");
    const template = first.template_id == null ? null : getTemplate(Number(first.template_id));
    const cells: Record<string, string> = {};
    const missing = new Set<string>();
    const lastParts: string[] = [];
    let videoFromAccount: string | null = null;

    for (const t of targets) {
      const key = columnFor({ id: Number(t.account_id), kind: String(t.kind), label: String(t.label) }, map);
      if (!key) continue;
      const url = String(t.url ?? "");
      const hasLink = /^https?:\/\//i.test(url);
      if (key === "youtube") {
        // The last cell: a Community post (a link you pasted), and/or the video itself.
        if (String(t.kind) === "youtube") videoFromAccount ??= t.external_id ? String(t.external_id) : null;
        else if (hasLink) lastParts.push(`[${wikiLink("youtube", url)} Link]`);
        else missing.add("YouTube");
        continue;
      }
      if (cells[key] !== undefined) continue; // an earlier account already filled this column
      if (hasLink) cells[key] = `|[${wikiLink(key, url)} Link]`;
      else missing.add(WIKI_COLUMNS.find((c) => c.key === key)?.label ?? key);
    }

    // The video and the G2G post are named in the post's own text.
    const videoId = videoFromAccount ?? VIDEO_ID.exec(text)?.[1] ?? "";
    const playlist = template?.wikiPlaylist ?? "";
    if (videoId || playlist) lastParts.push(`{{YouTube|${videoId}${playlist ? `|playlist=${playlist}` : ""}}}`);
    lastParts.push(`{{G2GLink|${G2G_ID.exec(text)?.[1] ?? ""}}}`);

    // The subject cell: the template's own wording, filled from what was typed when the post was made.
    let subject: string;
    let blanks: string[] = [];
    if (template?.wikiSubject) {
      let saved: Record<string, string> = {};
      try {
        saved = JSON.parse(String(first.template_values ?? "{}"));
      } catch {
        /* none saved */
      }
      const values = { ...saved, ...given };
      subject = fillTemplate(template.wikiSubject, values);
      blanks = placeholdersOf(template.wikiSubject)
        .filter((p) => !p.optional && !p.default && !String(values[p.key] ?? "").trim())
        .map((p) => p.name);
    } else {
      subject = plain(String(first.title || text.split("\n").find((l) => l.trim()) || ""));
    }

    const lines = [`|-${template?.wikiStyle ? ` style="${template.wikiStyle}"` : ""}`];
    lines.push(`|${weekday(String(first.scheduled_at), options.tz)}`);
    lines.push(`${template?.wikiBold ? "!" : "|"}${subject}`);
    for (const c of WIKI_COLUMNS) lines.push(cells[c.key] ?? "|");
    lines.push(`|${lastParts.join("<br>")}`);
    out.push({ postId, scheduledAt: String(first.scheduled_at), text: lines.join("\n"), missingLinks: [...missing], blanks });
  }
  return out.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.postId - b.postId);
}

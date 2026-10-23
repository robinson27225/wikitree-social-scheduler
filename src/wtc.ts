import { all, getJsonSetting, setJsonSetting } from "./db.ts";
import { columnFor, wikiLink } from "./wiki.ts";
import { HttpError } from "./util.ts";

/**
 * The WikiTree Challenge's own table of posts. It is turned the other way round from the everyday table: one row for each
 * channel and one column for each stage of the challenge (Open, Week out, Two days, Kick-Off...). A post is marked with the
 * challenge it belongs to and the stage it is for; the table fills each cell from the posted links and leaves the usual
 * "posts// Link" blank where nothing has gone out yet, ready to paste the id into.
 */

export const WTC_PHASES = [
  { key: "open", label: "Open", header: "Open" },
  { key: "week_out", label: "Week out", header: "Week<br>out" },
  { key: "two_days", label: "Two days", header: "Two<br>days" },
  { key: "kickoff", label: "Kick-Off", header: "Kick-Off" },
  { key: "chat", label: "Chat", header: "Chat" },
  { key: "halfway", label: "Halfway", header: "Halfway" },
  { key: "winding_down", label: "Winding Down", header: "Winding<br>Down" },
  { key: "wrapup", label: "Wrap-Up", header: "Wrap-Up" },
  { key: "reveal", label: "Reveal", header: "Reveal" },
  { key: "highlights", label: "Highlights", header: "Highlights" },
] as const;

const PHASE_KEYS = new Set<string>(WTC_PHASES.map((p) => p.key));
export const phaseLabel = (key: string) => WTC_PHASES.find((p) => p.key === key)?.label ?? key;

/** What the first cell of a channel's row says, and what an unfilled cell in that row looks like. */
export interface WtcRow {
  /** The wiki table column this row collects links from (facebook, twitter...). */
  column: string;
  /** The picture file shown in the first cell. */
  image: string;
  /** Where the picture links to. */
  link: string;
  /** The text under the picture: the account's name and the host's. May contain <br>. */
  label: string;
  /** What a link with no post id yet looks like, so the id can be typed in. */
  placeholder: string;
  /** Only accounts whose name matches this (a regular expression) go in the row. Empty: every account of that column. */
  match?: string;
}

/** The layout from the last challenge. Hosts' names change from one challenge to the next, so these are editable. */
export const DEFAULT_ROWS: WtcRow[] = [
  { column: "facebook", image: "PFWC-1.png", link: "https://www.facebook.com/WikiTreeOfficial", label: "@WikiTreeOfficial<br>@bbettinger", placeholder: "https://www.facebook.com/WikiTreeOfficial/posts//" },
  { column: "twitter", image: "PFWC-23.png", link: "https://twitter.com/WTChallenge", label: "@WTChallenge<br>", placeholder: "https://x.com/WTChallenge/status//", match: "challenge|wtc" },
  { column: "mastodon", image: "PFWC-12.png", link: "https://genealysis.social/@wikitree", label: "@WikiTree<br>@blainebettinger", placeholder: "https://genealysis.social/@wikitree//" },
  { column: "bluesky", image: "PFWC-30.png", link: "https://bsky.app/profile/wikitree.bsky.social", label: "@WikiTree<br>@blainebettinger.bsky.social", placeholder: "https://bsky.app/profile/wikitree.bsky.social/post//" },
  { column: "linkedin", image: "PFWC-4.png", link: "https://www.linkedin.com/company/wikitree/", label: "@WikiTree<br>@blainebettinger", placeholder: "https://www.linkedin.com/feed/update/urn:li:activity:/" },
  { column: "instagram", image: "PFWC-2.png", link: "https://www.instagram.com/wikitreers/", label: "@WikiTreers<br>@blainebettinger", placeholder: "https://www.instagram.com/p//" },
  { column: "threads", image: "PFWC-31.png", link: "https://www.threads.net/@wikitreers", label: "@WikiTreers<br>@blainebettinger", placeholder: "https://www.threads.net/@wikitreers/post//" },
  { column: "youtube", image: "PFWC-6.png", link: "https://www.youtube.com/wikitreers/", label: "@WikiTreers<br>@BlaineBettinger", placeholder: "https://www.youtube.com/post//" },
  { column: "reddit", image: "PFWC-39.png", link: "https://www.reddit.com/r/wikitree/", label: "r/wikitree<br>", placeholder: "https://www.reddit.com/r/wikitree/comments//" },
];

const SETTING = "wtc_rows";
const COLUMNS = new Set(DEFAULT_ROWS.map((r) => r.column));

/** The saved rows laid over the defaults, always in the table's order. */
export function wtcRows(): WtcRow[] {
  const saved = getJsonSetting<Partial<WtcRow>[]>(SETTING, []);
  return DEFAULT_ROWS.map((base) => ({ ...base, ...(saved.find((s) => s.column === base.column) ?? {}) }));
}

const text = (v: unknown, max: number, what: string): string => {
  if (typeof v !== "string") throw new HttpError(400, `${what} must be text.`);
  if (v.length > max) throw new HttpError(400, `${what} is too long.`);
  if (/[\r\n]/.test(v)) throw new HttpError(400, `${what} must be on one line.`);
  return v.trim();
};

export function saveWtcRows(input: unknown): void {
  if (!Array.isArray(input)) throw new HttpError(400, "Send the rows as a list.");
  const rows: Partial<WtcRow>[] = [];
  for (const raw of input) {
    const column = String((raw as WtcRow)?.column ?? "");
    if (!COLUMNS.has(column)) throw new HttpError(400, `${column || "A row"} isn't a row of the table.`);
    const r = raw as WtcRow;
    const match = text(r.match ?? "", 200, "The account filter");
    try {
      if (match) new RegExp(match, "i");
    } catch {
      throw new HttpError(400, "The account filter isn't a valid pattern. Leave it empty to use every account.");
    }
    rows.push({
      column,
      image: text(r.image, 120, "The picture file"),
      link: text(r.link, 300, "The link"),
      label: text(r.label, 300, "The label"),
      placeholder: text(r.placeholder, 300, "The blank link"),
      match,
    });
  }
  setJsonSetting(SETTING, rows);
}

/** A post's challenge and stage, checked. Both or neither. */
export function checkWtc(input: unknown): { challenge: string; phase: string } {
  if (input === null || input === undefined) return { challenge: "", phase: "" };
  const { challenge, phase } = input as { challenge?: unknown; phase?: unknown };
  if (!challenge && !phase) return { challenge: "", phase: "" };
  if (typeof challenge !== "string" || !challenge.trim()) throw new HttpError(400, "Say which challenge this post is for, for example WTC 12.");
  if (challenge.trim().length > 40 || /[\r\n]/.test(challenge)) throw new HttpError(400, "The challenge name is limited to 40 characters on one line.");
  if (typeof phase !== "string" || !PHASE_KEYS.has(phase)) throw new HttpError(400, "Choose which stage of the challenge this post is for.");
  return { challenge: challenge.trim(), phase };
}

/** The challenges that have posts, newest first, with how many of their posts have gone out. */
export function listChallenges(): { name: string; posts: number; posted: number }[] {
  return all(
    `SELECT p.wtc_challenge AS name, COUNT(DISTINCT p.id) AS posts,
            COUNT(DISTINCT CASE WHEN t.status = 'posted' THEN p.id END) AS posted, MAX(p.scheduled_at) AS latest
       FROM posts p LEFT JOIN targets t ON t.post_id = p.id
      WHERE p.wtc_challenge != ''
      GROUP BY p.wtc_challenge ORDER BY latest DESC`,
  ).map((r) => ({ name: String(r.name), posts: Number(r.posts), posted: Number(r.posted) }));
}

const safeUrl = (url: string) => url.replace(/ /g, "%20").replace(/\]/g, "%5D").replace(/\|/g, "%7C");
/** A link the way this table writes it: as given, with a closing slash (Reddit without the post's title). */
function tidy(column: string, raw: string): string {
  const url = column === "reddit" ? wikiLink("reddit", raw) : safeUrl(raw.trim());
  return !/[?#]/.test(url) && !url.endsWith("/") ? `${url}/` : url;
}

export interface WtcTable {
  markup: string;
  /** Cells that have a post that went out, and cells that are still blanks to fill in by hand. */
  filled: number;
  blank: number;
  /** Hand-posted channels where the post went out but no link was pasted in, so the cell is a blank. */
  missingLinks: string[];
}

export function wtcTable(challenge: string): WtcTable {
  if (!challenge.trim()) throw new HttpError(400, "Choose a challenge.");
  const rows = wtcRows();
  const posted = all(
    `SELECT p.wtc_phase AS phase, t.url, t.external_id, a.id AS account_id, a.kind, a.label
       FROM posts p JOIN targets t ON t.post_id = p.id JOIN accounts a ON a.id = t.account_id
      WHERE p.wtc_challenge = ? AND t.status = 'posted'
      ORDER BY p.scheduled_at, p.id, t.id`,
    challenge,
  );
  let filled = 0;
  let blank = 0;
  const missing = new Set<string>();
  const lines = ['{| border="1" ', `!Channel!!${WTC_PHASES.map((p) => p.header).join("!!")}`];

  rows.forEach((row, i) => {
    const filter = row.match ? new RegExp(row.match, "i") : null;
    lines.push("|-");
    lines.push(`|align=center${i === 0 ? " width=65" : ""}|{{Image|file=${row.image}|size=50`);
    lines.push(`|link=${row.link}}}<!---${row.column}--->${row.label}`);
    for (const phase of WTC_PHASES) {
      const cell: string[] = [];
      for (const t of posted) {
        if (t.phase !== phase.key) continue;
        const label = String(t.label);
        // In this table a hand-posted YouTube account (the Community tab) is simply the YouTube row.
        const column = columnFor({ id: Number(t.account_id), kind: String(t.kind), label }) ?? (String(t.kind) === "manual" && /youtube/i.test(label) ? "youtube" : null);
        if (column !== row.column) continue;
        if (filter && !filter.test(label)) continue;
        const url = String(t.url ?? "");
        if (String(t.kind) === "youtube" && t.external_id) cell.push(`{{YouTube|${String(t.external_id)}}}`);
        else if (/^https?:\/\//i.test(url)) cell.push(`[${tidy(row.column, url)} Link]`);
        else missing.add(`${label} (${phase.label})`);
      }
      if (cell.length) {
        filled++;
        lines.push(`|${cell.join("<br>")}`);
      } else {
        blank++;
        lines.push(`|[${row.placeholder} Link]`);
      }
    }
  });
  lines.push("|}");
  return { markup: lines.join("\n"), filled, blank, missingLinks: [...missing] };
}

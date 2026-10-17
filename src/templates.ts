import { all, get, getSetting, run, setSetting } from "./db.ts";
import { HttpError } from "./util.ts";

/**
 * Reusable post text for things that come round again. A template holds the wording with {{placeholders}} for the parts
 * that change each time, when it usually goes out, and which accounts it usually goes to. The browser fills the
 * placeholders in; the server only stores templates and makes sure a post never goes out with one still unfilled.
 *
 * Placeholder syntax:  {{name}}  {{name=default text}}  {{name?}} (optional: may be left blank)  {{name|upper}}  {{name|lower}}
 */

export interface Rule {
  /** "weekly": every week on this weekday. "monthly": the nth weekday of each month (5 means the last). */
  kind: "weekly" | "monthly";
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
  nth?: number;
  /** When the post usually goes out, in the viewer's own time zone. */
  time: string;
  /** Pre-filled answers for this occurrence, for when the same template differs between its occurrences. */
  defaults?: Record<string, string>;
}

export interface Template {
  id: number;
  name: string;
  body: string;
  title: string;
  rules: Rule[];
  accountIds: number[];
  active: boolean;
  /** The row's subject cell on the wiki table. May use the template's {{blanks}} and other {{wiki blanks}}. */
  wikiSubject: string;
  /** A row style such as background:#F59122; (blank for none). */
  wikiStyle: string;
  /** Show the subject cell in bold (the table's header cell style). */
  wikiBold: boolean;
  /** The YouTube playlist this feature's videos belong to, for {{YouTube|id|playlist=...}}. */
  wikiPlaylist: string;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateInput {
  name?: unknown;
  body?: unknown;
  title?: unknown;
  rules?: unknown;
  accountIds?: unknown;
  active?: unknown;
  wikiSubject?: unknown;
  wikiStyle?: unknown;
  wikiBold?: unknown;
  wikiPlaylist?: unknown;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanRule(raw: unknown, index: number): Rule {
  const where = `Schedule line ${index + 1}`;
  const r = (raw ?? {}) as Record<string, unknown>;
  const kind = r.kind;
  if (kind !== "weekly" && kind !== "monthly") throw new HttpError(400, `${where}: choose "every week" or "a certain week of the month".`);
  const weekday = Number(r.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new HttpError(400, `${where}: choose a day of the week.`);
  const time = String(r.time ?? "");
  if (!TIME.test(time)) throw new HttpError(400, `${where}: the time must look like 09:00.`);
  const rule: Rule = { kind, weekday, time };
  if (kind === "monthly") {
    const nth = Number(r.nth);
    if (!Number.isInteger(nth) || nth < 1 || nth > 5) throw new HttpError(400, `${where}: choose which week of the month (1st to 4th, or last).`);
    rule.nth = nth;
  }
  if (r.defaults && typeof r.defaults === "object") {
    const entries = Object.entries(r.defaults as Record<string, unknown>)
      .filter(([k, v]) => k.trim() && typeof v === "string" && v !== "")
      .slice(0, 20)
      .map(([k, v]) => [k.trim().slice(0, 40), String(v).slice(0, 200)] as const);
    if (entries.length) rule.defaults = Object.fromEntries(entries);
  }
  return rule;
}

function clean(input: TemplateInput, existing?: Template) {
  const name = String(input.name ?? existing?.name ?? "").trim();
  if (!name) throw new HttpError(400, "Give the template a name.");
  if (name.length > 80) throw new HttpError(400, "The name can be at most 80 characters.");
  const body = String(input.body ?? existing?.body ?? "").replace(/\r\n/g, "\n");
  if (!body.trim()) throw new HttpError(400, "The template needs some text.");
  if (body.length > 5000) throw new HttpError(400, "The text can be at most 5,000 characters.");
  const title = String(input.title ?? existing?.title ?? "").trim();
  if (title.length > 300) throw new HttpError(400, "The title can be at most 300 characters.");

  const rawRules = input.rules ?? existing?.rules ?? [];
  if (!Array.isArray(rawRules)) throw new HttpError(400, "The schedule must be a list.");
  if (rawRules.length > 10) throw new HttpError(400, "A template can have at most 10 schedule lines.");
  const rules = rawRules.map(cleanRule);

  const rawAccounts = input.accountIds ?? existing?.accountIds ?? [];
  if (!Array.isArray(rawAccounts)) throw new HttpError(400, "The accounts must be a list.");
  const accountIds = [...new Set(rawAccounts.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const active = input.active === undefined ? (existing?.active ?? true) : Boolean(input.active);

  const wikiSubject = String(input.wikiSubject ?? existing?.wikiSubject ?? "").replace(/\r\n/g, "\n").trim();
  if (wikiSubject.length > 2000) throw new HttpError(400, "The wiki subject cell can be at most 2,000 characters.");
  const wikiStyle = String(input.wikiStyle ?? existing?.wikiStyle ?? "").trim();
  // This goes inside style="..." on a table row, so keep out anything that could break out of it.
  if (wikiStyle.length > 200 || /["<>{}\n\r|]/.test(wikiStyle)) throw new HttpError(400, "The row style should look like background:#F59122;");
  const wikiPlaylist = String(input.wikiPlaylist ?? existing?.wikiPlaylist ?? "").trim();
  if (wikiPlaylist && !/^[\w-]{1,60}$/.test(wikiPlaylist)) throw new HttpError(400, "The playlist name can only use letters, numbers, - and _.");
  const wikiBold = input.wikiBold === undefined ? (existing?.wikiBold ?? false) : Boolean(input.wikiBold);
  return { name, body, title, rules, accountIds, active, wikiSubject, wikiStyle, wikiBold, wikiPlaylist };
}

function templateOf(row: Record<string, any>): Template {
  const parse = <T>(text: string, fallback: T): T => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: Number(row.id),
    name: String(row.name),
    body: String(row.body),
    title: String(row.title ?? ""),
    rules: parse<Rule[]>(String(row.rules), []),
    accountIds: parse<number[]>(String(row.account_ids), []),
    active: Number(row.active) === 1,
    wikiSubject: String(row.wiki_subject ?? ""),
    wikiStyle: String(row.wiki_style ?? ""),
    wikiBold: Number(row.wiki_bold ?? 0) === 1,
    wikiPlaylist: String(row.wiki_playlist ?? ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export const listTemplates = (): Template[] => all("SELECT * FROM templates ORDER BY active DESC, name COLLATE NOCASE").map(templateOf);

export function getTemplate(id: number): Template | null {
  const row = Number.isInteger(id) ? get("SELECT * FROM templates WHERE id = ?", id) : undefined;
  return row ? templateOf(row) : null;
}

function guardUnique(error: unknown): never {
  if (error instanceof Error && /UNIQUE/i.test(error.message)) throw new HttpError(409, "A template with that name already exists.");
  throw error;
}

export function createTemplate(input: TemplateInput): Template {
  const t = clean(input);
  const now = new Date().toISOString();
  try {
    const result = run(
      "INSERT INTO templates (name, body, title, rules, account_ids, active, wiki_subject, wiki_style, wiki_bold, wiki_playlist, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      t.name,
      t.body,
      t.title,
      JSON.stringify(t.rules),
      JSON.stringify(t.accountIds),
      t.active ? 1 : 0,
      t.wikiSubject,
      t.wikiStyle,
      t.wikiBold ? 1 : 0,
      t.wikiPlaylist,
      now,
      now,
    );
    return getTemplate(Number(result.lastInsertRowid))!;
  } catch (error) {
    return guardUnique(error);
  }
}

export function updateTemplate(id: number, input: TemplateInput): Template {
  const existing = getTemplate(id);
  if (!existing) throw new HttpError(404, "No such template.");
  const t = clean(input, existing);
  try {
    run(
      "UPDATE templates SET name = ?, body = ?, title = ?, rules = ?, account_ids = ?, active = ?, wiki_subject = ?, wiki_style = ?, wiki_bold = ?, wiki_playlist = ?, updated_at = ? WHERE id = ?",
      t.name,
      t.body,
      t.title,
      JSON.stringify(t.rules),
      JSON.stringify(t.accountIds),
      t.active ? 1 : 0,
      t.wikiSubject,
      t.wikiStyle,
      t.wikiBold ? 1 : 0,
      t.wikiPlaylist,
      new Date().toISOString(),
      id,
    );
  } catch (error) {
    guardUnique(error);
  }
  return getTemplate(id)!;
}

export function deleteTemplate(id: number): Template {
  const existing = getTemplate(id);
  if (!existing) throw new HttpError(404, "No such template.");
  run("DELETE FROM templates WHERE id = ?", id);
  run("DELETE FROM template_skips WHERE template_id = ?", id);
  run("UPDATE posts SET template_id = NULL WHERE template_id = ?", id); // the posts stay; they just no longer say where they came from
  return existing;
}

// ---------------------------------------------------------------- the weekly and monthly features

const at = (weekday: number, time = "09:00"): Rule => ({ kind: "weekly", weekday, time });

interface Seed {
  name: string;
  body: string;
  rules: Rule[];
  wikiSubject?: string;
  wikiStyle?: string;
  wikiBold?: boolean;
  wikiPlaylist?: string;
}

const SEEDS: Seed[] = [
  {
    name: "QoW: Question of the Week",
    rules: [at(1)],
    wikiSubject: "{{Tag Link|Question_of_the_Week}} {{subject}}<br>[[Image:{{image}}|125px]]",
    wikiBold: true,
    wikiPlaylist: "QuestionOfTheWeek",
    body: `❓#QuestionOfTheWeek {{question}}

{{video link?}}

{{details}}

{{G2G link}}

#Genealogy #CollaborativeGenealogy #WhereGenealogistsCollaborate`,
  },
  {
    name: "ONS: One Name Tuesday showcase",
    rules: [at(2)],
    wikiSubject: "{{Tag Link|One_Name _Studies}} <br>\'\'\'[[Project:{{surname}}|{{surname}}]]\'\'\'<br>[[Image:Steve_s_Tools-50.png|125px]]",
    wikiBold: true,
    body: `#OneNameTuesday showcase: {{surname}}
{{blurb}} #WhereGenealogistsCollaborate
https://www.wikitree.com/genealogy/{{surname|upper}}
#OneNameStudy #CollaborativeGenealogy`,
  },
  {
    name: "CC: Connection Checkers",
    rules: [at(2)],
    wikiSubject: "{{Tag Link|Connection_Checkers}} {{theme}}<br>[[{{profile id}}]]<br>[[Image:{{image}}|100px]]",
    wikiBold: true,
    wikiPlaylist: "ConnectionCombat",
    body: `🧩This Week's #ConnectionCheckers — {{headline}}
{{video link?}}
{{G2G link}} #WhereGenealogistsCollaborate #CollaborativeGenealogy`,
  },
  {
    name: "OPS: One Place Wednesday showcase",
    rules: [at(3)],
    wikiSubject: "{{Tag Link|One_Place_Studies}}<br>\'\'\'[[Space:{{place}} One Place Study|{{place}}]]\'\'\'<br>[[Image:{{image}}|150px]]",
    wikiBold: true,
    body: `#OnePlaceWednesday showcase: {{place}}

Explore the lives & stories of residents in this community through #CollaborativeGenealogy research!
📍 {{link}}

#OnePlaceStudy`,
  },
  {
    name: "Project Showcase",
    rules: [at(4)],
    wikiSubject: "{{Tag Link|Projects}}<br>\'\'\'[[Project:{{project name}}|{{project name}}]]\'\'\'<br>[[Image:{{image}}|125px]]",
    body: `Project Showcase: {{project name}}
{{blurb}}
{{link}}

#CollaborativeGenealogy`,
  },
  {
    name: "Member of the Week",
    rules: [at(6)],
    wikiSubject: "{{Tag Link|Meet_Our_Members}} \'\'\'[[{{profile id}}]]\'\'\'<br>[[Image:{{image}}|100px]]",
    body: `#WikiTreeMeetOurMembers: {{member name}}
We're celebrating {{first name}} this week for their awesome contributions to our #CollaborativeGenealogy community. 👏
Read more about {{his/her/their}} WikiTree journey: {{G2G link}}
#WonderfulWikiTreers`,
  },
  {
    name: "Saturday Roundup",
    rules: [at(6)],
    wikiSubject: "{{Tag Link|Saturday_Roundup}}<br>[[Help:LiveCasts|LiveCasts]]<br>[[Space:Saturday Roundup|Saturday Roundup]]<br>[[Image:Saturday Roundup.png|100px]]",
    wikiStyle: "background:#90C73F;",
    wikiBold: true,
    wikiPlaylist: "SaturdayRoundup",
    body: `🌳 Tune in at 10am ET for another #SaturdayRoundup
{{YouTube link}}

#WhereGenealogistsCollaborate 46M+ profiles 16M+ DNA connections 17+ years collaborating

#CollaborativeGenealogy`,
  },
  {
    name: "GCH: Genealogy Collaboration Hour",
    rules: [at(6)],
    wikiSubject: "{{Tag Link|Genealogy Collaboration Hour}}<br>[[Space:Genealogy_Collaboration_Hour|Zoom]]<br>[[Image:Genealogy_Collaboration_Hour-2.png|200px]]<br>",
    wikiBold: true,
    body: `🌳 Genealogy is better together!
#GenealogyCollaborationHour TODAY at 17:00 ET
Get help, share finds, & enjoy friendly company

Everyone is welcome & it is free to join
{{G2G link}}

#WhereGenealogistsCollaborate #CollaborativeGenealogy`,
  },
  {
    // The wiki page shows it on the 2nd Friday and not the 1st, so it is set to the 2nd and 4th. Check this and edit if it is wrong.
    name: "FDN: Friday Date Night",
    rules: [
      { kind: "monthly", nth: 2, weekday: 5, time: "09:00" },
      { kind: "monthly", nth: 4, weekday: 5, time: "09:00" },
    ],
    wikiSubject: "{{Tag Link|Friday_Date_Night}}<br>\'\'\'[[Space:WikiTree_Friday_Date_Night|Zoom]]\'\'\'<br>[[Image:WikiTree_Friday_Date_Night.png|100px]]",
    wikiStyle: "background:#fad158;",
    body: `No need to swipe right! #FridayDateNight is hunting profiles with no dates
Join us today, 4 pm ET
Everyone welcome — no date required
https://wikitree.com/wiki/Space:WikiTree_Friday_Date_Night
#CollaborativeGenealogy #WhereGenealogistsCollaborate`,
  },
  {
    name: "Mbr Q&A: Member Q&A Session",
    wikiSubject: "{{Tag Link|New_Members}}<br>\'\'\'[[Space:New_Member_Q_and_A_via_Zoom|Q & A via Zoom]]\'\'\'<br>[[Image:Social Media Livecasts-47.png|150px]]",
    wikiStyle: "background:#fad158;",
    rules: [
      { kind: "monthly", nth: 2, weekday: 4, time: "09:00", defaults: { time: "8pm ET" } },
      { kind: "monthly", nth: 4, weekday: 0, time: "09:00", defaults: { time: "11am ET" } },
    ],
    body: `🌳 WikiTree Member Q&A Session: TODAY at {{time=8pm ET}}
✔️ Navigating the website
✔️ Creating and maintaining profiles
✔️ Growing your family branches

Details: {{G2G link}}

#CollaborativeGenealogy #WhereGenealogistsCollaborate`,
  },
];

/**
 * Adds the team's usual templates the first time, and never again: after that the list belongs to the team, so
 * deleting a template for good doesn't bring it back.
 */
export function seedTemplates(): number {
  if (getSetting("templates_seeded") === "true") return 0;
  setSetting("templates_seeded", "true");
  if (listTemplates().length > 0) return 0;
  for (const seed of SEEDS) createTemplate({ ...seed });
  setSetting("templates_wiki_seeded", "true");
  return SEEDS.length;
}

/**
 * Templates made before the wiki settings existed get them once (only filling in what is empty), and the Friday Date
 * Night schedule if it still has none. After that they belong to the team.
 */
export function seedWikiSettings(): number {
  if (getSetting("templates_wiki_seeded") === "true") return 0;
  setSetting("templates_wiki_seeded", "true");
  let changed = 0;
  for (const seed of SEEDS) {
    const existing = all("SELECT * FROM templates WHERE name = ?", seed.name).map(templateOf)[0];
    if (!existing) continue;
    const patch: TemplateInput = {};
    if (!existing.wikiSubject && seed.wikiSubject) patch.wikiSubject = seed.wikiSubject;
    if (!existing.wikiStyle && seed.wikiStyle) patch.wikiStyle = seed.wikiStyle;
    if (!existing.wikiBold && seed.wikiBold) patch.wikiBold = true;
    if (!existing.wikiPlaylist && seed.wikiPlaylist) patch.wikiPlaylist = seed.wikiPlaylist;
    if (existing.rules.length === 0 && seed.rules.length) patch.rules = seed.rules;
    if (Object.keys(patch).length) {
      updateTemplate(existing.id, patch);
      changed++;
    }
  }
  return changed;
}

// ---------------------------------------------------------------- weeks where a regular post isn't happening

/** The days (YYYY-MM-DD) each template has been skipped, from yesterday on. */
export function listSkips(): Record<number, string[]> {
  const since = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const out: Record<number, string[]> = {};
  for (const r of all("SELECT template_id, day FROM template_skips WHERE day >= ? ORDER BY day", since)) {
    (out[Number(r.template_id)] ??= []).push(String(r.day));
  }
  return out;
}

export function setSkip(templateId: number, day: unknown, skipped: boolean): void {
  if (!getTemplate(templateId)) throw new HttpError(404, "No such template.");
  const d = String(day ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new HttpError(400, "Choose a day.");
  if (skipped) run("INSERT OR IGNORE INTO template_skips (template_id, day) VALUES (?, ?)", templateId, d);
  else run("DELETE FROM template_skips WHERE template_id = ? AND day = ?", templateId, d);
}

/** The names of any {{placeholders}} still in some text. A post must never go out with one. */
export function leftoverPlaceholders(text: string): string[] {
  return [...text.matchAll(/\{\{[^{}]*\}\}/g)].map((m) => m[0]);
}

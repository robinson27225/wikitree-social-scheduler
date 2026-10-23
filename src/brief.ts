import fs from "node:fs";
import path from "node:path";
import { claudeConfiguredFor } from "./claude.ts";
import { all, readConfig } from "./db.ts";
import { providerFor } from "./providers/index.ts";
import { backupStatus } from "./autobackup.ts";
import { config } from "./config.ts";
import { DATA_DIR } from "./db.ts";
import { getHostConfig } from "./publicHost.ts";

/**
 * A plain-English digest of what's scheduled and what needs a person, for a daily brief or for
 * Claude to read. Everything in it is already visible in the app; it just puts it in one place.
 */

export const BACKUP_DIR = path.resolve(process.env.SOCIAL_SCHEDULER_BACKUPS ?? "backups");
const DAY = 24 * 3_600_000;

export interface BriefLine {
  account: string;
  post: string;
  due: string;
  detail?: string;
}

export interface Brief {
  generatedAt: string;
  needsAttention: BriefLine[];
  upcoming: { due: string; post: string; channels: { account: string; how: string }[]; appMustBeRunning: boolean }[];
  laterCount: number;
  postedLast24h: { account: string; post: string; url: string | null }[];
  warnings: string[];
  text: string;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

const preview = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 70 ? `${flat.slice(0, 67)}...` : flat;
};

export function newestBackup(): { file: string; at: Date } | null {
  try {
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith(".ssbackup"))
      .map((f) => ({ file: f, at: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
      .sort((a, b) => b.at.getTime() - a.at.getTime());
    return files[0] ?? null;
  } catch {
    return null;
  }
}

export function buildBrief(now: Date = new Date()): Brief {
  const rows = all(
    `SELECT t.id, t.status, t.mode, t.error, t.url, t.posted_at, t.title_override, t.text_override,
            t.handed_off_at, p.text, p.title, p.scheduled_at, a.label, a.kind, a.config
       FROM targets t
       JOIN posts p ON p.id = t.post_id
       JOIN accounts a ON a.id = t.account_id
      ORDER BY p.scheduled_at, t.id`,
  );

  const needsAttention: BriefLine[] = [];
  const upcomingByPost = new Map<string, Brief["upcoming"][number]>();
  let laterCount = 0;
  const posted: Brief["postedLast24h"] = [];
  const horizon = now.getTime() + 2 * DAY;
  const seenLater = new Set<string>();

  for (const r of rows) {
    const provider = providerFor(r.kind);
    const config = readConfig(r.config);
    const text = String(r.text_override ?? r.text);
    const title = String(r.title_override ?? r.title ?? "");
    const need = provider.needsTitleFor ? provider.needsTitleFor(config) : provider.needsTitle;
    const line = { account: r.label, post: preview(text), due: when(r.scheduled_at) };

    if (r.status === "failed") needsAttention.push({ ...line, detail: `Failed: ${r.error ?? "no reason given"}` });
    else if (r.status === "missed") needsAttention.push({ ...line, detail: "Missed: it was due while the app wasn't running. Post it now or reschedule it." });
    else if (r.status === "ready") {
      needsAttention.push({ ...line, detail: r.handed_off_at ? "You scheduled this there yourself. Check that it went out, then mark it as posted." : "Ready: time to post this one by hand." });
    } else if (r.status === "scheduled" && need === "required" && title.trim() === "" && !r.handed_off_at) {
      needsAttention.push({ ...line, detail: "Needs a title before it can be posted." });
    }

    if (r.status === "posted" && r.posted_at && now.getTime() - Date.parse(r.posted_at) < DAY) {
      posted.push({ account: r.label, post: preview(text), url: r.url });
    }

    if (r.status === "scheduled") {
      const due = Date.parse(r.scheduled_at);
      if (due <= horizon) {
        const key = `${r.scheduled_at}|${r.text}`;
        const entry =
          upcomingByPost.get(key) ??
          { due: line.due, post: preview(String(r.text)), channels: [], appMustBeRunning: false };
        const how = provider.manual
          ? r.handed_off_at
            ? "you scheduled it there yourself; check it went out"
            : "a reminder, you post it by hand"
          : r.mode === "remote"
            ? `held by ${provider.label}, goes out even if this Mac is off`
            : "posted by this app, so the Mac must be on";
        entry.channels.push({ account: r.label, how });
        if (!provider.manual && r.mode !== "remote") entry.appMustBeRunning = true;
        upcomingByPost.set(key, entry);
      } else {
        const key = `${r.scheduled_at}|${r.text}`;
        if (!seenLater.has(key)) {
          seenLater.add(key);
          laterCount++;
        }
      }
    }
  }

  // Things that will quietly stop working if nobody notices.
  const warnings: string[] = [];
  for (const a of all("SELECT label, kind, config FROM accounts")) {
    const c = readConfig(a.config);
    const expiries: [string, unknown][] = [
      ["its sign-in token", c.tokenExpiresAt],
      ["its lasting sign-in", c.refreshTokenExpiresAt],
    ];
    for (const [what, iso] of expiries) {
      const days = (Date.parse(String(iso ?? "")) - now.getTime()) / DAY;
      if (Number.isFinite(days) && days < 14) {
        warnings.push(
          days < 0
            ? `${a.label}: ${what} has expired. Reconnect it in Settings.`
            : a.kind === "linkedin" && !c.refreshToken
              ? `${a.label}: ${what} expires in ${Math.ceil(days)} day(s). LinkedIn sign-ins can't renew themselves: press Connect for LinkedIn in Settings before then.`
              : `${a.label}: ${what} expires in ${Math.ceil(days)} day(s). The app renews it automatically while running, so keep it running.`,
        );
      }
    }
  }
  const needsImageHost = all("SELECT 1 FROM accounts WHERE kind IN ('instagram', 'threads', 'tiktok')").length > 0;
  if (needsImageHost && !getHostConfig()) warnings.push("The image host isn't set up, so Instagram, Threads and TikTok photos will fail.");
  // On the shared server each person has their own key, so there is nothing to warn about for the team as a whole.
  if (config.authMode !== "google" && !claudeConfiguredFor(null)) warnings.push("No Anthropic API key is saved, so Draft with Claude is off (posting is unaffected).");

  if (config.authMode === "google") {
    // On the server, backups are automatic and go to a private bucket.
    const b = backupStatus();
    if (!b.configured) warnings.push("Automatic backups aren't set up, so nothing protects the queue if the server's disk is lost. See docs/DEPLOY.md.");
    else if (b.lastOk === null) warnings.push("No automatic backup has finished yet. The first runs tonight.");
    else if (b.lastOk === false) warnings.push(`The last automatic backup failed: ${b.lastError}. It retries every half hour.`);
    else if (now.getTime() - Date.parse(String(b.lastAt)) > 2 * DAY) warnings.push(`The newest automatic backup is ${Math.floor((now.getTime() - Date.parse(String(b.lastAt))) / DAY)} days old.`);
    try {
      const disk = fs.statfsSync(DATA_DIR);
      const pct = Math.round((1 - Number(disk.bavail) / Number(disk.blocks)) * 100);
      if (pct >= 85) warnings.push(`The server's data disk is ${pct}% full. Remove old files from the media library before it fills up.`);
    } catch { /* the system wouldn't say; nothing to report */ }
  } else {
    const backup = newestBackup();
    if (!backup) warnings.push("There is no backup yet. Run `npm run backup` so someone else can take over the queue.");
    else if (now.getTime() - backup.at.getTime() > 14 * DAY) {
      warnings.push(`The newest backup is ${Math.floor((now.getTime() - backup.at.getTime()) / DAY)} days old. Run \`npm run backup\` again.`);
    }
  }

  const upcoming = [...upcomingByPost.values()];
  const lines: string[] = [`Social scheduler, ${now.toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`];

  lines.push("", `NEEDS ATTENTION (${needsAttention.length})`);
  if (!needsAttention.length) lines.push("  Nothing.");
  for (const n of needsAttention) lines.push(`  - ${n.account}: "${n.post}" (due ${n.due}). ${n.detail}`);

  lines.push("", `COMING UP IN THE NEXT 48 HOURS (${upcoming.length} post${upcoming.length === 1 ? "" : "s"})`);
  if (!upcoming.length) lines.push("  Nothing scheduled.");
  for (const u of upcoming) {
    lines.push(`  - ${u.due}: "${u.post}"${u.appMustBeRunning ? "  [the scheduler app must be running for some of these]" : ""}`);
    for (const c of u.channels) lines.push(`      ${c.account}: ${c.how}`);
  }
  if (laterCount) lines.push(`  Plus ${laterCount} more post${laterCount === 1 ? "" : "s"} scheduled further ahead.`);

  lines.push("", `POSTED IN THE LAST 24 HOURS (${posted.length})`);
  if (!posted.length) lines.push("  Nothing.");
  for (const p of posted) lines.push(`  - ${p.account}: "${p.post}"${p.url ? ` ${p.url}` : ""}`);

  if (warnings.length) {
    lines.push("", "HEADS-UP");
    for (const w of warnings) lines.push(`  - ${w}`);
  }

  return { generatedAt: now.toISOString(), needsAttention, upcoming, laterCount, postedLast24h: posted, warnings, text: lines.join("\n") };
}

import path from "node:path";
import { extraImagesOf } from "./library.ts";
import { all, get, getSetting, MEDIA_DIR, readConfig, run, writeConfig } from "./db.ts";
import { mediaKindOf } from "./media.ts";
import { providerFor } from "./providers/index.ts";
import type { Config, ProviderContext, PublishInput } from "./providers/types.ts";
import { collectStats } from "./stats.ts";
import { errMsg, notify } from "./util.ts";

const TICK_MS = 20_000;
const DEFAULT_GRACE_MINUTES = 30;
/** Mastodon needs 5 minutes' notice; leave a margin for upload time and clock skew. */
export const MIN_SERVER_LEAD_MS = 6 * 60_000;
/** A server-held post still pending this long after its time means something is wrong there. */
const SERVER_OVERDUE_MS = 60 * 60_000;
const MAINTAIN_EVERY_MS = 6 * 60 * 60_000;

let ticking = false;
let timer: NodeJS.Timeout | undefined;
let statsTimer: NodeJS.Timeout | undefined;
const STATS_EVERY_MS = 15 * 60_000;
let lastMaintained = 0;

/** How long after its scheduled time a post may still go out automatically. */
function graceMs(): number {
  const minutes = Number(getSetting("missed_grace_minutes", String(DEFAULT_GRACE_MINUTES)));
  return (Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_GRACE_MINUTES) * 60_000;
}

/** Lets a provider save refreshed credentials back onto its own account. */
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

function loadTarget(targetId: number) {
  return get(
    `SELECT t.id, t.status, t.mode, t.remote, t.account_id,
            t.text_override, t.title_override, t.alt_override, t.no_media, t.thumb_first_frame,
            p.text, p.title, p.alt_text, p.media_file, p.extra_media, p.scheduled_at,
            a.kind, a.label
       FROM targets t
       JOIN posts p ON p.id = t.post_id
       JOIN accounts a ON a.id = t.account_id
      WHERE t.id = ?`,
    targetId,
  );
}

/** Always read the current config: a refresh during an earlier step may have changed it. */
function currentConfig(accountId: number): Config {
  return readConfig(get("SELECT config FROM accounts WHERE id = ?", accountId)!.config);
}

/** What this one channel posts: the post's own text, title, alt text and media, unless the channel has its own. */
function inputFor(row: Record<string, any>, idempotencyKey: string): PublishInput {
  // An empty media_file means a text-only post, and so does a channel set to skip the media.
  const mediaFile = row.no_media ? "" : row.media_file;
  const mediaPath = mediaFile ? path.join(MEDIA_DIR, mediaFile) : null;
  const mediaKind = mediaPath ? mediaKindOf(mediaPath) : null;
  // More pictures after the first, as many as this platform takes (the rest are left off this channel).
  let extraImages: PublishInput["extraImages"];
  if (mediaKind === "image") {
    const room = Math.max((providerFor(row.kind).maxImages?.(currentConfig(row.account_id)) ?? 1) - 1, 0);
    const extras = extraImagesOf(row.extra_media).slice(0, room);
    if (extras.length) extraImages = extras.map((e) => ({ path: path.join(MEDIA_DIR, e.file), altText: e.alt }));
  }
  return {
    text: row.text_override ?? row.text,
    title: row.title_override ?? row.title ?? "",
    altText: row.alt_override ?? row.alt_text,
    mediaPath,
    mediaKind,
    ...(extraImages ? { extraImages } : {}),
    idempotencyKey,
    thumbnailFromVideo: Boolean(row.thumb_first_frame),
  };
}

/**
 * Decides who will publish a target and sets that up. If the platform can hold the schedule
 * (and there's enough notice), the post is handed to it so it goes out even if this Mac is off.
 * Otherwise this app posts it at the scheduled time. Safe to call again after an edit: any copy
 * already held by the platform is cancelled first. Throws only if that cancellation fails.
 */
export async function placeTarget(targetId: number): Promise<void> {
  const row = loadTarget(targetId);
  if (!row) return;
  const provider = providerFor(row.kind);
  const ctx = contextFor(row.account_id);

  if (row.remote) {
    await provider.cancelOnServer!(currentConfig(row.account_id), JSON.parse(row.remote), ctx);
    run("UPDATE targets SET mode = 'local', remote = NULL WHERE id = ?", targetId);
  }

  const config = currentConfig(row.account_id);
  const window = provider.serverScheduleWindow?.(config) ?? { minMs: MIN_SERVER_LEAD_MS, maxMs: Infinity };
  const lead = Date.parse(row.scheduled_at) - Date.now();
  const canHold =
    provider.scheduleOnServer &&
    provider.supportsServerSchedule?.(config) &&
    lead >= window.minMs &&
    lead <= window.maxMs;
  if (!canHold) {
    run("UPDATE targets SET mode = 'local', remote = NULL WHERE id = ?", targetId);
    return;
  }

  try {
    // A fresh key each time: a reused key would make the platform return the old, cancelled post.
    const remote = await provider.scheduleOnServer!(
      config,
      inputFor(row, `social-scheduler-target-${targetId}-sched-${Date.now()}`),
      row.scheduled_at,
      ctx,
    );
    run(
      "UPDATE targets SET mode = 'remote', remote = ?, status = 'scheduled', error = NULL WHERE id = ?",
      JSON.stringify(remote),
      targetId,
    );
  } catch (e) {
    run(
      "UPDATE targets SET mode = 'local', remote = NULL, error = ? WHERE id = ?",
      `Couldn't hand this to ${row.label} to schedule (${errMsg(e)}). This app will post it at the scheduled time instead, so keep it running.`,
      targetId,
    );
  }
}

/**
 * Cancels the platform-held copy of a target (if it has one) and hands the target back to this app.
 * Returns false if the platform no longer had it, which may mean it was already published.
 * Throws if the platform couldn't be reached, in which case nothing has changed.
 */
export async function releaseServerCopy(targetId: number): Promise<boolean> {
  const row = loadTarget(targetId);
  if (!row?.remote) return true;
  const provider = providerFor(row.kind);
  const cancelled = await provider.cancelOnServer!(
    currentConfig(row.account_id),
    JSON.parse(row.remote),
    contextFor(row.account_id),
  );
  if (cancelled) run("UPDATE targets SET mode = 'local', remote = NULL WHERE id = ?", targetId);
  return cancelled;
}

/** Marks a manual-platform target as ready for the person to post by hand. */
function markReady(targetId: number, label: string): void {
  const handedOff = Boolean(get("SELECT handed_off_at FROM targets WHERE id = ?", targetId)?.handed_off_at);
  run("UPDATE targets SET status = 'ready', error = NULL WHERE id = ? AND status IN ('scheduled', 'missed', 'failed')", targetId);
  if (handedOff) notify("Check a post you scheduled", `${label}: you scheduled this there yourself. Check that it went out, then mark it as posted in the Queue.`);
  else notify("Time to post by hand", `${label}: the text and image are ready in the app's Queue.`);
}

/**
 * Takes back "I posted it" for a hand-posted target (a slip: it was marked on the wrong post). It goes back to waiting
 * for its time, or, if that has passed, to ready for you to post. Never for a platform the app posts to itself, because
 * the post really exists there.
 */
export function unmarkPosted(targetId: number): { ok: true } | { ok: false; reason: string } {
  const row = get(
    `SELECT t.status, p.scheduled_at, a.kind FROM targets t JOIN posts p ON p.id = t.post_id JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`,
    targetId,
  );
  if (!row) return { ok: false, reason: "No such post." };
  if (!providerFor(String(row.kind)).manual) return { ok: false, reason: "That was posted by the app itself, so it can't be taken back here." };
  if (row.status !== "posted") return { ok: false, reason: "That one isn't marked as posted." };
  const next = Date.parse(String(row.scheduled_at)) > Date.now() ? "scheduled" : "ready";
  run("UPDATE targets SET status = ?, url = NULL, error = NULL, posted_at = NULL, external_id = NULL WHERE id = ?", next, targetId);
  return { ok: true };
}

/** Changes (or clears) the link recorded for a hand-posted target that is marked posted. */
export function setPostedLink(targetId: number, url: string): { ok: true } | { ok: false; reason: string } {
  const row = get("SELECT t.status, a.kind FROM targets t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?", targetId);
  if (!row) return { ok: false, reason: "No such post." };
  if (!providerFor(String(row.kind)).manual) return { ok: false, reason: "That was posted by the app itself, so its link can't be changed." };
  if (row.status !== "posted") return { ok: false, reason: "That one isn't marked as posted." };
  const clean = url.trim();
  if (clean && !/^https?:\/\//i.test(clean)) return { ok: false, reason: "The link must start with https://" };
  run("UPDATE targets SET url = ? WHERE id = ?", clean || null, targetId);
  return { ok: true };
}

/**
 * For a platform with no API, the person can schedule the post on the platform's own tool (X has one) and tell us.
 * The post then stops asking for attention until its time, when it asks them to check it went out.
 */
export function setHandedOff(targetId: number, on: boolean): { ok: true } | { ok: false; reason: string } {
  const row = get(
    `SELECT t.status, p.scheduled_at, a.kind FROM targets t JOIN posts p ON p.id = t.post_id JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`,
    targetId,
  );
  if (!row) return { ok: false, reason: "No such post." };
  if (!providerFor(String(row.kind)).manual) return { ok: false, reason: "That's only for accounts you post to by hand." };
  if (!["scheduled", "ready", "missed", "failed"].includes(String(row.status))) return { ok: false, reason: "That one has already been posted." };
  if (!on) {
    run("UPDATE targets SET handed_off_at = NULL WHERE id = ?", targetId);
    return { ok: true };
  }
  if (Date.parse(String(row.scheduled_at)) <= Date.now()) {
    return { ok: false, reason: "Its time has already passed. Post it, then mark it as posted." };
  }
  run("UPDATE targets SET status = 'scheduled', error = NULL, handed_off_at = ? WHERE id = ?", new Date().toISOString(), targetId);
  return { ok: true };
}

/** The person says they posted a manual target themselves. */
export function markPosted(targetId: number, url?: string): boolean {
  const done = run(
    "UPDATE targets SET status = 'posted', url = ?, error = NULL, posted_at = ? WHERE id = ? AND status IN ('scheduled', 'ready', 'failed', 'missed')",
    url?.trim() || null,
    new Date().toISOString(),
    targetId,
  );
  return done.changes > 0;
}

/**
 * Publishes one target from this app right now. Safe to call twice: only one caller can claim it.
 * Returns false if it was already claimed or no longer exists.
 */
export async function publishTarget(targetId: number): Promise<boolean> {
  const peek = loadTarget(targetId);
  if (peek && providerFor(peek.kind).manual) {
    // No API to call: "post now" just brings it to the front for the person to do by hand.
    if (!["scheduled", "missed", "failed"].includes(peek.status)) return false;
    markReady(targetId, peek.label);
    return true;
  }

  const claimed = run(
    "UPDATE targets SET status = 'posting', error = NULL WHERE id = ? AND status IN ('scheduled', 'missed', 'failed')",
    targetId,
  );
  if (claimed.changes === 0) return false;

  const row = loadTarget(targetId);
  if (!row) return false;
  const provider = providerFor(row.kind);
  const ctx = contextFor(row.account_id);

  try {
    if (row.mode === "remote" && row.remote) {
      // Take it off the platform's schedule first, or it would be published twice.
      const ref = JSON.parse(row.remote);
      let cancelled: boolean;
      try {
        cancelled = await provider.cancelOnServer!(currentConfig(row.account_id), ref, ctx);
      } catch (e) {
        run(
          "UPDATE targets SET status = 'failed', error = ? WHERE id = ?",
          `Nothing was posted: couldn't cancel the copy scheduled on ${row.label} (${errMsg(e)}).`,
          targetId,
        );
        return true;
      }
      if (!cancelled) {
        // It's no longer on the schedule. The platform may have just published it: never post a duplicate.
        const state = await provider.checkOnServer!(currentConfig(row.account_id), ref, row.scheduled_at, ctx);
        if (state.state === "published") {
          run(
            "UPDATE targets SET status = 'posted', url = ?, error = NULL, posted_at = ?, external_id = ? WHERE id = ?",
            state.url ?? null,
            new Date().toISOString(),
            state.id ?? null,
            targetId,
          );
        } else {
          run(
            "UPDATE targets SET status = 'failed', mode = 'local', remote = NULL, error = ? WHERE id = ?",
            `This post is no longer on ${row.label}'s schedule and I couldn't find it published. Check the account first, then use Retry to post it from here.`,
            targetId,
          );
        }
        return true;
      }
      run("UPDATE targets SET mode = 'local', remote = NULL WHERE id = ?", targetId);
    }

    const result = await provider.publish(
      currentConfig(row.account_id),
      inputFor(row, `social-scheduler-target-${targetId}`),
      ctx,
    );
    run(
      "UPDATE targets SET status = 'posted', url = ?, error = ?, posted_at = ?, external_id = ? WHERE id = ?",
      result.url,
      result.note ?? null, // a caveat, shown beside a successful post
      new Date().toISOString(),
      result.id ?? null,
      targetId,
    );
  } catch (e) {
    run("UPDATE targets SET status = 'failed', error = ? WHERE id = ?", errMsg(e), targetId);
    notify("Post failed", `${row.label}: ${errMsg(e)}`);
  }
  return true;
}

/** Finds out what happened to posts that are being held by a platform. */
async function reconcileServerHeld(now: Date): Promise<void> {
  const rows = all(
    `SELECT t.id, t.remote, t.account_id, p.scheduled_at, a.kind, a.label
       FROM targets t
       JOIN posts p ON p.id = t.post_id
       JOIN accounts a ON a.id = t.account_id
      WHERE t.mode = 'remote' AND t.status = 'scheduled' AND p.scheduled_at <= ?`,
    new Date(now.getTime() - 20_000).toISOString(),
  );
  for (const row of rows) {
    try {
      const provider = providerFor(row.kind);
      const state = await provider.checkOnServer!(
        currentConfig(row.account_id),
        JSON.parse(row.remote),
        row.scheduled_at,
        contextFor(row.account_id),
      );
      if (state.state === "published") {
        run(
          "UPDATE targets SET status = 'posted', url = ?, error = ?, posted_at = ?, external_id = ? WHERE id = ? AND status = 'scheduled'",
          state.url ?? null,
          (JSON.parse(row.remote) as { note?: string }).note ?? null, // a caveat saved when it was handed over, shown beside the post
          row.scheduled_at,
          state.id ?? null,
          row.id,
        );
      } else if (state.state === "gone") {
        run(
          "UPDATE targets SET status = 'failed', error = ? WHERE id = ? AND status = 'scheduled'",
          `This post is no longer on ${row.label}'s schedule and I couldn't find it published. It may have been deleted there. Check the account before using Retry.`,
          row.id,
        );
        notify("Scheduled post not found", `${row.label}: check whether it was published.`);
      } else if (now.getTime() - Date.parse(row.scheduled_at) > SERVER_OVERDUE_MS) {
        run(
          "UPDATE targets SET status = 'failed', error = ? WHERE id = ? AND status = 'scheduled'",
          `${row.label} still hasn't published this, over an hour after its time. Retry cancels the scheduled copy and posts it from here.`,
          row.id,
        );
        notify("Scheduled post overdue", `${row.label} hasn't published it yet.`);
      }
    } catch {
      // Offline or the platform is down. Try again next tick.
    }
  }
}

/** Renews credentials that expire (for example Threads tokens, which last 60 days). */
export async function maintainAccounts(): Promise<void> {
  for (const account of all("SELECT id, kind, label FROM accounts")) {
    try {
      const provider = providerFor(account.kind);
      if (!provider.maintain) continue;
      await provider.maintain(currentConfig(account.id), contextFor(account.id));
    } catch (e) {
      console.warn(`Couldn't renew credentials for ${account.label}: ${errMsg(e)}`);
      notify("Account needs attention", `${account.label}: ${errMsg(e)}`);
    }
  }
}

/** One pass over everything that is due. Exported for tests. */
export async function tick(now: Date = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const due = all(
      `SELECT t.id, p.scheduled_at, a.kind, a.label
         FROM targets t
         JOIN posts p ON p.id = t.post_id
         JOIN accounts a ON a.id = t.account_id
        WHERE t.status = 'scheduled' AND t.mode = 'local' AND p.scheduled_at <= ?
        ORDER BY p.scheduled_at, t.id`,
      now.toISOString(),
    );
    let missed = 0;
    for (const target of due) {
      if (providerFor(target.kind).manual) {
        // Nothing to call and nothing stale to avoid: just tell the person it's time.
        markReady(target.id, target.label);
        continue;
      }
      const lateBy = now.getTime() - Date.parse(target.scheduled_at);
      if (lateBy > graceMs()) {
        // The app wasn't running (or the Mac was asleep). Don't surprise-post something stale.
        run("UPDATE targets SET status = 'missed' WHERE id = ? AND status = 'scheduled'", target.id);
        missed++;
      } else {
        await publishTarget(target.id);
      }
    }
    if (missed > 0) {
      notify("Scheduled posts missed", `${missed} post(s) were due while the app wasn't running. Open the Queue to review.`);
    }
    await reconcileServerHeld(now);

    if (now.getTime() - lastMaintained >= MAINTAIN_EVERY_MS) {
      lastMaintained = now.getTime();
      await maintainAccounts();
    }
  } finally {
    ticking = false;
  }
}

export function startScheduler(): void {
  // A target left in 'posting' means we died mid-publish. It may or may not have gone out,
  // so never retry it automatically (that could double-post).
  run(
    "UPDATE targets SET status = 'failed', error = ? WHERE status = 'posting'",
    "Interrupted while posting. Check the account before retrying, it may have been published.",
  );
  void tick();
  timer = setInterval(() => void tick(), TICK_MS);
  // Reading post numbers is slow and optional, so it runs on its own timer and never holds up a post.
  const readStats = () => void collectStats().catch((e) => console.warn(`Couldn't read post numbers: ${errMsg(e)}`));
  setTimeout(readStats, 2 * 60_000).unref();
  statsTimer = setInterval(readStats, STATS_EVERY_MS);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  if (statsTimer) clearInterval(statsTimer);
}

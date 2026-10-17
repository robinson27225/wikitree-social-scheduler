import { execFile } from "node:child_process";
import { config } from "./config.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Bluesky counts graphemes (what a person sees as one character). */
export function graphemeLength(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

const URL_RE = /https?:\/\/[^\s]+/g;

/** Mastodon counts every URL as 23 characters, whatever its real length. */
export function mastodonLength(text: string): number {
  return graphemeLength(text.replace(URL_RE, "x".repeat(23)));
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

const recentAlerts = new Map<string, number>();

/** Posts a short message to the team's chat webhook (Discord or Slack). Best effort; never throws. */
function sendWebhook(text: string): void {
  const url = config.alertWebhook;
  if (!url) return;
  // The same message again within ten minutes is almost certainly the same problem repeating.
  const now = Date.now();
  if ((recentAlerts.get(text) ?? 0) > now - 10 * 60_000) return;
  recentAlerts.set(text, now);
  if (recentAlerts.size > 200) for (const [k, t] of recentAlerts) if (t < now - 10 * 60_000) recentAlerts.delete(k);
  // "content" is what Discord reads, "text" is what Slack reads; each ignores the other.
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text.slice(0, 1800), text: text.slice(0, 1800) }),
    signal: AbortSignal.timeout(5000),
  }).catch((error) => console.error("Couldn't send the alert to the webhook:", errMsg(error)));
}

/** Tells a person something needs them: a Mac notification on a Mac, and the chat webhook if one is set up. Never throws. */
export function notify(title: string, message: string): void {
  sendWebhook(`Social Scheduler: ${title}. ${message}`);
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile(
    "osascript",
    ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`],
    () => {},
  );
}

const dailyAlerts = new Set<string>();

/** Like notify, but at most once per calendar day for the same key, for things that stay true for a while (a full disk). */
export function notifyDaily(key: string, title: string, message: string): void {
  const day = `${key}:${new Date().toISOString().slice(0, 10)}`;
  if (dailyAlerts.has(day)) return;
  dailyAlerts.add(day);
  notify(title, message);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

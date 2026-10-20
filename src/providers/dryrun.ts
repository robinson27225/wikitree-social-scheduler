import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../db.ts";
import { graphemeLength } from "../util.ts";
import { withTotals } from "./insights.ts";
import type { Provider } from "./types.ts";

const LOG = () => path.join(DATA_DIR, "dryrun.log");
const REMOTE = () => path.join(DATA_DIR, "dryrun-remote.json");

type Remote = Record<string, { whenIso: string; text: string }>;

async function readRemote(): Promise<Remote> {
  try {
    return JSON.parse(await fs.readFile(REMOTE(), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Pretends to post: appends to data/dryrun.log. For trying the app without a real account.
 * With "simulate server-side scheduling" on, it also plays the part of a platform that holds
 * scheduled posts (like Mastodon does), so that code path can be tried and tested.
 */
export const dryrun: Provider = {
  kind: "dryrun",
  label: "Test account (posts nowhere)",
  fields: [
    {
      name: "failWith",
      label: "Simulate an error (optional)",
      type: "text",
      help: "Leave empty for success. Any text here makes every post fail with that message.",
    },
    {
      name: "nativeSchedule",
      label: "Simulate server-side scheduling",
      type: "checkbox",
      default: false,
    },
  ],

  async connect(config) {
    return { config, detail: "Test account ready. Posts are only written to data/dryrun.log" };
  },

  maxImages: () => 10,
  textLimit: () => 280,
  countText: (text) => graphemeLength(text),
  accepts: () => null,

  async publish(config, input) {
    if (config.failWith) throw new Error(String(config.failWith));
    const line = JSON.stringify({
      at: new Date().toISOString(),
      text: input.text,
      alt: input.altText,
      image: input.mediaPath ? path.basename(input.mediaPath) : null,
      // The pictures after the first, each with its own description.
      more: (input.extraImages ?? []).map((e) => ({ image: path.basename(e.path), alt: e.altText })),
      key: input.idempotencyKey,
    });
    await fs.appendFile(LOG(), line + "\n");
    return { url: `dryrun://${input.idempotencyKey}`, id: input.idempotencyKey };
  },

  supportsServerSchedule: (config) => config.nativeSchedule === true || config.nativeSchedule === "true",

  async scheduleOnServer(config, input, whenIso) {
    if (config.failWith) throw new Error(String(config.failWith));
    const remote = await readRemote();
    const id = `remote-${crypto.randomUUID()}`; // unique even when a cancel and a re-place happen in the same millisecond
    remote[id] = { whenIso, text: input.text };
    await fs.writeFile(REMOTE(), JSON.stringify(remote));
    return { id };
  },

  async cancelOnServer(_config, ref) {
    const remote = await readRemote();
    if (!remote[ref.id]) return false;
    delete remote[ref.id];
    await fs.writeFile(REMOTE(), JSON.stringify(remote));
    return true;
  },

  async checkOnServer(_config, ref) {
    const remote = await readRemote();
    const entry = remote[ref.id];
    if (!entry) return { state: "gone" };
    if (Date.parse(entry.whenIso) > Date.now()) return { state: "pending" };
    return { state: "published", url: `dryrun://${ref.id}`, id: ref.id };
  },

  /** Made-up but steady numbers (they depend only on the post's id), so the Stats tab can be tried without a real account. */
  async fetchStats(_config, target) {
    let h = 7;
    for (const ch of target.externalId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const views = 200 + (h % 4800);
    return {
      metrics: withTotals({
        views,
        reach: Math.round(views * 0.7),
        likes: Math.round(views * 0.04),
        comments: h % 9,
        shares: h % 13,
        link_clicks: h % 40,
      }),
      notes: [],
    };
  },
};

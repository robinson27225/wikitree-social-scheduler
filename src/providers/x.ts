import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchJson, form, pollUntil } from "../http.ts";
import { prepareImage } from "../images.ts";
import { mimeOf } from "../media.ts";
import { oauth1Header, type OAuth1Credentials } from "../oauth1.ts";
import type { Config, Provider } from "./types.ts";

const DEFAULT_LIMIT = 280;
const PREMIUM_LIMIT = 25_000;
const CHUNK_BYTES = 4 * 1024 * 1024; // X recommends 5 MB or less, and allows up to 8 MB

function apiBase(config: Config): string {
  // `apiBase` exists so tests can point at a fake server.
  return String(config.apiBase || "https://api.x.com").replace(/\/+$/, "");
}

function creds(config: Config): OAuth1Credentials {
  return {
    consumerKey: String(config.consumerKey),
    consumerSecret: String(config.consumerSecret),
    token: String(config.token),
    tokenSecret: String(config.tokenSecret),
  };
}

type Body = { json?: unknown; multipart?: FormData };

async function xRequest<T = any>(config: Config, method: string, route: string, body: Body, what: string): Promise<T> {
  const url = `${apiBase(config)}${route}`;
  const headers: Record<string, string> = { Authorization: oauth1Header(method, url, creds(config)) };
  let payload: BodyInit | undefined;
  if (body.json !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body.json);
  } else if (body.multipart) {
    payload = body.multipart; // fetch sets the multipart boundary itself
  }
  return fetchJson<T>(url, { method, headers, body: payload }, what);
}

const WEIGHT_ONE: [number, number][] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * X's weighted length: every link counts as 23, Latin-style characters as 1, and everything else
 * (emoji, CJK...) as 2. Mirrors twitter-text closely enough to warn before X would reject a post.
 */
export function xLength(text: string): number {
  const withoutUrls = text.replace(/https?:\/\/[^\s]+/g, "");
  const urls = (text.match(/https?:\/\/[^\s]+/g) ?? []).length;
  let n = urls * 23;
  for (const { segment } of segmenter.segment(withoutUrls)) {
    const light = [...segment].every((ch) => {
      const cp = ch.codePointAt(0)!;
      return WEIGHT_ONE.some(([lo, hi]) => cp >= lo && cp <= hi);
    });
    n += light ? 1 : 2;
  }
  return n;
}

async function uploadImage(config: Config, file: string): Promise<string> {
  const isGif = path.extname(file).toLowerCase() === ".gif";
  const body = new FormData();
  if (isGif) {
    // Animated GIFs go up untouched (15 MB limit); re-encoding would flatten the animation.
    body.set("media", await openAsBlob(file), path.basename(file));
    body.set("media_category", "tweet_gif");
  } else {
    const image = await prepareImage(file, { maxBytes: 5 * 1024 * 1024, maxEdge: 4096 });
    body.set("media", new Blob([new Uint8Array(image.bytes)], { type: image.mime }), path.basename(file));
    body.set("media_category", "tweet_image");
  }
  const res = await xRequest<{ data: { id: string } }>(config, "POST", "/2/media/upload", { multipart: body }, "X image upload");
  return res.data.id;
}

async function uploadVideo(config: Config, file: string): Promise<string> {
  const size = (await fs.stat(file)).size;
  const init = await xRequest<{ data: { id: string } }>(
    config,
    "POST",
    "/2/media/upload/initialize",
    { json: { media_type: mimeOf(file), total_bytes: size, media_category: "tweet_video" } },
    "X video upload (start)",
  );
  const id = init.data.id;

  const blob = await openAsBlob(file);
  for (let index = 0, offset = 0; offset < size; index++, offset += CHUNK_BYTES) {
    const part = new FormData();
    part.set("segment_index", String(index));
    part.set("media", blob.slice(offset, Math.min(offset + CHUNK_BYTES, size)), `part-${index}`);
    await xRequest(config, "POST", `/2/media/upload/${id}/append`, { multipart: part }, `X video upload (part ${index + 1})`);
  }

  const done = await xRequest<{ data: { processing_info?: { state: string; check_after_secs?: number } } }>(
    config,
    "POST",
    `/2/media/upload/${id}/finalize`,
    {},
    "X video upload (finish)",
  );
  if (done.data.processing_info) {
    await pollUntil(
      "X to finish processing the video",
      async () => {
        const status = await xRequest<{ data: { processing_info?: { state: string; error?: { message?: string } } } }>(
          config,
          "GET",
          `/2/media/upload?${form({ command: "STATUS", media_id: id })}`,
          {},
          "X video processing check",
        );
        const info = status.data.processing_info;
        if (!info || info.state === "succeeded") return true;
        if (info.state === "failed") throw new Error(`X couldn't process the video (${info.error?.message ?? "failed"}).`);
        return undefined;
      },
      { everyMs: 3000, timeoutMs: 10 * 60_000 },
    );
  }
  return id;
}

export const x: Provider = {
  kind: "x",
  label: "X (Twitter)",
  fields: [],
  secretKeys: ["consumerKey", "consumerSecret", "token", "tokenSecret"],

  async connect(config) {
    // Premium accounts can write long posts; ask X rather than assume.
    let maxChars = DEFAULT_LIMIT;
    let username = String(config.username ?? "");
    try {
      const me = await xRequest<{ data: { username: string; id: string; subscription_type?: string } }>(
        config,
        "GET",
        `/2/users/me?${form({ "user.fields": "subscription_type" })}`,
        {},
        "X sign-in check",
      );
      username = me.data.username;
      if (me.data.subscription_type && me.data.subscription_type !== "None") maxChars = PREMIUM_LIMIT;
      return { config: { ...config, username, userId: me.data.id, maxChars }, detail: `Connected to @${username} (${maxChars} characters).` };
    } catch {
      const me = await xRequest<{ data: { username: string; id: string } }>(config, "GET", "/2/users/me", {}, "X sign-in check");
      return {
        config: { ...config, username: me.data.username, userId: me.data.id, maxChars },
        detail: `Connected to @${me.data.username} (${maxChars} characters).`,
      };
    }
  },

  textLimit: (config) => Number(config.maxChars) || DEFAULT_LIMIT,
  countText: (text) => xLength(text),
  accepts: () => null,

  async publish(config, input) {
    let mediaId: string | undefined;
    if (input.mediaPath) {
      mediaId = input.mediaKind === "video" ? await uploadVideo(config, input.mediaPath) : await uploadImage(config, input.mediaPath);
      if (input.altText && input.mediaKind !== "video") {
        // Alt text is important but shouldn't stop the post if X refuses it.
        await xRequest(
          config,
          "POST",
          "/2/media/metadata",
          { json: { id: mediaId, metadata: { alt_text: { text: input.altText.slice(0, 1000) } } } },
          "X alt text",
        ).catch(() => {});
      }
    }
    const tweet = await xRequest<{ data: { id: string } }>(
      config,
      "POST",
      "/2/tweets",
      { json: { text: input.text, ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) } },
      "X post",
    );
    return { url: `https://x.com/${config.username}/status/${tweet.data.id}`, id: String(tweet.data.id) };
  },
};

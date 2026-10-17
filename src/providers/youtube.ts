import fs from "node:fs/promises";
import { ApiError, fetchJson, form } from "../http.ts";
import { firstFrameJpeg } from "../images.ts";
import { mimeOf } from "../media.ts";
import { graphemeLength } from "../util.ts";
import type { Config, Provider, ProviderContext, PublishInput } from "./types.ts";
import { withTotals } from "./insights.ts";

const CHUNK_BYTES = 16 * 1024 * 1024; // must be a multiple of 256 KiB
const DAY = 24 * 3_600_000;

const apiBase = (c: Config) => String(c.apiBase || "https://www.googleapis.com").replace(/\/+$/, "");
const tokenUrl = (c: Config) => String(c.tokenUrl || "https://oauth2.googleapis.com/token");

/** Google access tokens last about an hour; the refresh token is what lasts. */
async function accessToken(config: Config, ctx?: ProviderContext): Promise<string> {
  const expires = Date.parse(String(config.accessTokenExpiresAt ?? ""));
  if (config.accessToken && Number.isFinite(expires) && expires - Date.now() > 60_000) return String(config.accessToken);
  const res = await fetchJson<{ access_token: string; expires_in: number }>(
    tokenUrl(config),
    {
      method: "POST",
      body: form({
        client_id: String(config.clientId),
        client_secret: String(config.clientSecret),
        refresh_token: String(config.refreshToken),
        grant_type: "refresh_token",
      }),
    },
    "Google sign-in refresh",
  );
  ctx?.saveConfig({
    accessToken: res.access_token,
    accessTokenExpiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
  });
  return res.access_token;
}

interface UploadResult {
  id: string;
  status?: { privacyStatus?: string };
}

/** Uploads with Google's resumable protocol, in chunks, so large videos work and a failure isn't silent. */
async function upload(
  config: Config,
  input: PublishInput & { mediaPath: string },
  ctx: ProviderContext | undefined,
  status: { privacyStatus: string; publishAt?: string },
): Promise<UploadResult> {
  const token = await accessToken(config, ctx);
  const size = (await fs.stat(input.mediaPath)).size;
  const title = (input.title || input.text.split("\n")[0]).slice(0, 100);

  const start = await fetch(`${apiBase(config)}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size),
      "X-Upload-Content-Type": mimeOf(input.mediaPath),
    },
    body: JSON.stringify({
      snippet: { title, description: input.text, categoryId: String(config.categoryId || "22") },
      status: { selfDeclaredMadeForKids: false, ...status },
    }),
  });
  if (!start.ok) {
    const body = await start.json().catch(() => ({}));
    throw new ApiError(`YouTube upload (start) failed (${start.status}): ${(body as any)?.error?.message ?? start.statusText}`, start.status, body);
  }
  const session = start.headers.get("location");
  if (!session) throw new Error("YouTube didn't return an upload address.");

  const handle = await fs.open(input.mediaPath, "r");
  try {
    for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
      const length = Math.min(CHUNK_BYTES, size - offset);
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, offset);
      const res = await fetch(session, {
        method: "PUT",
        redirect: "manual",
        headers: {
          "Content-Length": String(length),
          "Content-Type": mimeOf(input.mediaPath),
          "Content-Range": `bytes ${offset}-${offset + length - 1}/${size}`,
        },
        body: chunk,
      });
      if (res.status === 308) continue; // "Resume Incomplete": send the next part
      if (res.status === 200 || res.status === 201) return (await res.json()) as UploadResult;
      const body = await res.json().catch(() => ({}));
      throw new ApiError(`YouTube upload failed (${res.status}): ${(body as any)?.error?.message ?? res.statusText}`, res.status, body);
    }
  } finally {
    await handle.close();
  }
  throw new Error("YouTube finished receiving the file but didn't confirm the video.");
}

/**
 * Sets the video's thumbnail from its own first frame. The video is already uploaded by now, so this never fails the
 * post: it returns a short explanation instead, which is shown beside the post.
 */
async function setThumbnail(config: Config, videoId: string, file: string, ctx?: ProviderContext): Promise<string | undefined> {
  try {
    const jpeg = await firstFrameJpeg(file);
    if (!jpeg) return "The video went up, but the first frame couldn't be made into a thumbnail (this needs ffmpeg on the server).";
    const token = await accessToken(config, ctx);
    const res = await fetch(`${apiBase(config)}/upload/youtube/v3/thumbnails/set?${form({ videoId, uploadType: "media" })}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg", "Content-Length": String(jpeg.length) },
      body: new Uint8Array(jpeg),
    });
    if (res.ok) return undefined;
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const why = body.error?.message ?? res.statusText;
    return res.status === 403
      ? `The video went up, but YouTube wouldn't set its thumbnail (${why}). Custom thumbnails need the channel to be verified: youtube.com/verify.`
      : `The video went up, but its thumbnail couldn't be set (${res.status}: ${why}).`;
  } catch (error) {
    return `The video went up, but its thumbnail couldn't be set (${error instanceof Error ? error.message : String(error)}).`;
  }
}

export const youtube: Provider = {
  kind: "youtube",
  label: "YouTube",
  fields: [],
  secretKeys: ["clientSecret", "refreshToken", "accessToken"],

  async connect(config, ctx?: ProviderContext) {
    const token = await accessToken(config, ctx);
    const channels = await fetchJson<{ items?: { snippet: { title: string } }[] }>(
      `${apiBase(config)}/youtube/v3/channels?${form({ part: "snippet", mine: "true" })}`,
      { headers: { Authorization: `Bearer ${token}` } },
      "YouTube channel check",
    );
    const title = channels.items?.[0]?.snippet.title ?? String(config.channelTitle ?? "your channel");
    return {
      config,
      detail: `Connected to "${title}". Until Google audits your API project, YouTube keeps API uploads private.`,
    };
  },

  textLimit: () => 5000,
  countText: (text) => graphemeLength(text),
  needsTitle: "required",
  titleLimit: () => 100,

  accepts: (kind) =>
    kind === "video" ? null : "YouTube's API only accepts videos. It has no way to create Community posts (images or text).",

  async publish(config, input, ctx) {
    if (!input.mediaPath) throw new Error("YouTube needs a video.");
    const wanted = String(config.privacy || "public");
    const video = await upload(config, { ...input, mediaPath: input.mediaPath }, ctx, { privacyStatus: wanted });
    const kept =
      video.status?.privacyStatus && video.status.privacyStatus !== wanted
        ? `YouTube kept this video ${video.status.privacyStatus} instead of ${wanted}. Unaudited API projects are locked to private; apply for Google's audit to lift that.`
        : undefined;
    const thumb = input.thumbnailFromVideo ? await setThumbnail(config, video.id, input.mediaPath, ctx) : undefined;
    const note = [kept, thumb].filter(Boolean).join(" ") || undefined;
    return { url: `https://www.youtube.com/watch?v=${video.id}`, note, id: video.id };
  },

  // YouTube can hold a scheduled video itself (uploaded private, with a publish time).
  supportsServerSchedule: () => true,
  serverScheduleWindow: () => ({ minMs: 10 * 60_000, maxMs: 300 * DAY }),

  async scheduleOnServer(config, input, whenIso, ctx) {
    if (!input.mediaPath) throw new Error("YouTube needs a video.");
    const video = await upload(config, { ...input, mediaPath: input.mediaPath }, ctx, {
      privacyStatus: "private",
      publishAt: whenIso,
    });
    // A thumbnail can be set while the video waits; if it can't, the explanation is kept and shown once it is published.
    const note = input.thumbnailFromVideo ? await setThumbnail(config, video.id, input.mediaPath, ctx) : undefined;
    return { id: video.id, ...(note ? { note } : {}) };
  },

  async cancelOnServer(config, remote, ctx) {
    const token = await accessToken(config, ctx);
    const res = await fetch(`${apiBase(config)}/youtube/v3/videos?${form({ id: remote.id })}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Cancelling the scheduled YouTube video failed (${res.status}).`);
    return true;
  },

  async checkOnServer(config, remote, _whenIso, ctx) {
    const token = await accessToken(config, ctx);
    const res = await fetchJson<{ items?: { status: { privacyStatus: string } }[] }>(
      `${apiBase(config)}/youtube/v3/videos?${form({ part: "status", id: remote.id })}`,
      { headers: { Authorization: `Bearer ${token}` } },
      "Checking the scheduled YouTube video",
    );
    const item = res.items?.[0];
    if (!item) return { state: "gone" };
    return item.status.privacyStatus === "private"
      ? { state: "pending" }
      : { state: "published", url: `https://www.youtube.com/watch?v=${remote.id}`, id: remote.id };
  },

  async fetchStats(config, target, ctx) {
    const token = await accessToken(config, ctx);
    const res = await fetchJson<{ items?: { statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[] }>(
      `${apiBase(config)}/youtube/v3/videos?${form({ part: "statistics", id: target.externalId })}`,
      { headers: { Authorization: `Bearer ${token}` } },
      "Reading the YouTube video's counts",
    );
    const stats = res.items?.[0]?.statistics;
    if (!stats) throw new Error("YouTube doesn't show this video any more.");
    const n = (v?: string) => (v === undefined ? undefined : Number(v));
    return {
      metrics: withTotals(Object.fromEntries(Object.entries({ views: n(stats.viewCount), likes: n(stats.likeCount), comments: n(stats.commentCount) }).filter(([, v]) => v !== undefined))),
      notes: [],
    };
  },
};

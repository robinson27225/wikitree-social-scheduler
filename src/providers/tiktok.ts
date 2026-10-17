import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import sharp from "sharp";
import { fetchJson, form, pollUntil } from "../http.ts";
import { mimeOf } from "../media.ts";
import { withPublicUrl } from "../publicHost.ts";
import { graphemeLength } from "../util.ts";
import type { Config, Provider, ProviderContext } from "./types.ts";

const apiBase = (c: Config) => String(c.apiBase || "https://open.tiktokapis.com").replace(/\/+$/, "");

/** TikTok access tokens last about a day; the refresh token (a year) is renewed each time it's used. */
async function accessToken(config: Config, ctx?: ProviderContext, force = false): Promise<string> {
  const expires = Date.parse(String(config.accessTokenExpiresAt ?? ""));
  if (!force && config.accessToken && Number.isFinite(expires) && expires - Date.now() > 5 * 60_000) {
    return String(config.accessToken);
  }
  const res = await fetchJson<{ access_token: string; refresh_token: string; expires_in: number; refresh_expires_in: number }>(
    `${apiBase(config)}/v2/oauth/token/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        client_key: String(config.clientKey),
        client_secret: String(config.clientSecret),
        grant_type: "refresh_token",
        refresh_token: String(config.refreshToken),
      }),
    },
    "TikTok sign-in refresh",
  );
  ctx?.saveConfig({
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    accessTokenExpiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + res.refresh_expires_in * 1000).toISOString(),
  });
  return res.access_token;
}

interface TikTokReply<T> {
  data: T;
  error: { code: string; message: string; log_id?: string };
}

async function call<T>(config: Config, token: string, route: string, body: unknown, what: string): Promise<T> {
  const res = await fetchJson<TikTokReply<T>>(
    `${apiBase(config)}${route}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body ?? {}),
    },
    what,
  );
  // TikTok reports many failures as HTTP 200 with an error code other than "ok".
  if (res.error && res.error.code !== "ok") throw new Error(`${what} failed: ${res.error.message} (${res.error.code})`);
  return res.data;
}

async function chooseVisibility(config: Config, token: string): Promise<string> {
  const wanted = String(config.privacyLevel || "SELF_ONLY");
  const info = await call<{ privacy_level_options?: string[] }>(
    config,
    token,
    "/v2/post/publish/creator_info/query/",
    {},
    "TikTok account check",
  );
  const options = info.privacy_level_options ?? [];
  if (options.length && !options.includes(wanted)) {
    throw new Error(`TikTok doesn't offer "${wanted}" for this account right now. Available: ${options.join(", ")}.`);
  }
  return wanted;
}

/** Waits for TikTok to finish and returns the public post id when there is one. */
async function waitForPublish(config: Config, token: string, publishId: string): Promise<string | undefined> {
  return pollUntil(
    "TikTok to finish publishing",
    async () => {
      const s = await call<{ status: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }>(
        config,
        token,
        "/v2/post/publish/status/fetch/",
        { publish_id: publishId },
        "TikTok publish check",
      );
      if (s.status === "PUBLISH_COMPLETE") return { id: s.publicaly_available_post_id?.[0]?.toString() };
      if (s.status === "FAILED") throw new Error(`TikTok couldn't publish this (${s.fail_reason ?? "unknown reason"}).`);
      return undefined;
    },
    { everyMs: 4000, timeoutMs: 10 * 60_000 },
  ).then((r) => r.id);
}

export const tiktok: Provider = {
  kind: "tiktok",
  label: "TikTok",
  fields: [],
  secretKeys: ["clientSecret", "refreshToken", "accessToken"],

  async connect(config, ctx) {
    const token = await accessToken(config, ctx);
    const info = await call<{ privacy_level_options?: string[]; creator_nickname?: string }>(
      config,
      token,
      "/v2/post/publish/creator_info/query/",
      {},
      "TikTok account check",
    );
    const level = String(config.privacyLevel || "SELF_ONLY");
    return {
      config,
      detail:
        `Connected to ${info.creator_nickname ?? config.displayName ?? "your TikTok account"}. ` +
        (level === "SELF_ONLY"
          ? "Posts are private (only you can see them) until TikTok audits your app."
          : `Posts will be ${level}.`),
    };
  },

  textLimit: () => 2200,
  countText: (text) => graphemeLength(text),
  needsTitle: "optional", // photo posts have a short title (90 characters)
  titleLimit: () => 90,

  accepts: (kind) => (kind === null ? "TikTok posts need a video or an image." : null),

  async publish(config, input, ctx) {
    if (!input.mediaPath || !input.mediaKind) throw new Error("TikTok posts need a video or an image.");
    const token = await accessToken(config, ctx);
    const privacy = await chooseVisibility(config, token);
    let postId: string | undefined;

    if (input.mediaKind === "video") {
      const size = (await fs.stat(input.mediaPath)).size;
      // Chunks are 5-64 MB, except the last which may be larger. Small files go up in one piece.
      const chunk = size < 5 * 1024 * 1024 ? size : 10 * 1024 * 1024;
      const total = Math.max(1, Math.floor(size / chunk));
      const init = await call<{ publish_id: string; upload_url: string }>(
        config,
        token,
        "/v2/post/publish/video/init/",
        {
          post_info: { title: input.text.slice(0, 2200), privacy_level: privacy },
          source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunk, total_chunk_count: total },
        },
        "TikTok video upload (start)",
      );
      const blob = await openAsBlob(input.mediaPath);
      for (let i = 0; i < total; i++) {
        const start = i * chunk;
        const end = i === total - 1 ? size : start + chunk; // the last chunk takes any remainder
        const res = await fetch(init.upload_url, {
          method: "PUT",
          headers: {
            "Content-Type": mimeOf(input.mediaPath),
            "Content-Length": String(end - start),
            "Content-Range": `bytes ${start}-${end - 1}/${size}`,
          },
          body: Buffer.from(await blob.slice(start, end).arrayBuffer()),
        });
        if (!res.ok) throw new Error(`TikTok video upload (part ${i + 1}) failed (${res.status}).`);
      }
      postId = await waitForPublish(config, token, init.publish_id);
    } else {
      // Photos are pulled from a web address, which TikTok requires you to have verified as yours.
      const bytes = await sharp(input.mediaPath, { failOn: "none" })
        .rotate()
        .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
      postId = await withPublicUrl({ bytes, contentType: "image/jpeg", extension: "jpg" }, async (url) => {
        const init = await call<{ publish_id: string }>(
          config,
          token,
          "/v2/post/publish/content/init/",
          {
            post_info: {
              title: (input.title || input.text.split("\n")[0]).slice(0, 90),
              description: input.text.slice(0, 4000),
              privacy_level: privacy,
              disable_comment: false,
              auto_add_music: true,
            },
            source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: [url] },
            post_mode: "DIRECT_POST",
            media_type: "PHOTO",
          },
          "TikTok photo post",
        );
        // The image must stay online until TikTok has pulled it, so wait for the result before deleting.
        return waitForPublish(config, token, init.publish_id);
      });
    }

    const handle = String(config.username || config.displayName || "");
    const url = postId && handle ? `https://www.tiktok.com/@${handle}/video/${postId}` : `https://www.tiktok.com/@${handle}`;
    return {
      url,
      note: privacy === "SELF_ONLY" ? "Posted privately: TikTok only lets you see it until the app passes TikTok's audit." : undefined,
    };
  },

  async maintain(config, ctx) {
    const expires = Date.parse(String(config.accessTokenExpiresAt ?? ""));
    if (!Number.isFinite(expires) || expires - Date.now() < 6 * 3_600_000) await accessToken(config, ctx, true);
  },
};

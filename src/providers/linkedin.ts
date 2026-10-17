import fs from "node:fs/promises";
import path from "node:path";
import { ApiError, errorDetail, fetchJson, form, pollUntil } from "../http.ts";
import { prepareImage } from "../images.ts";
import { graphemeLength } from "../util.ts";
import type { Config, Provider, ProviderContext, PublishInput } from "./types.ts";
import { withTotals } from "./insights.ts";

/**
 * LinkedIn Pages, through the Posts API (the older ugcPosts API is being replaced by it).
 *
 * Things that shape this file, from LinkedIn's own documentation:
 *  - There is no way to ask LinkedIn to publish later. A post is created as PUBLISHED, so this app posts at the
 *    scheduled time, like Bluesky does.
 *  - Posting as a Page needs the w_organization_social permission, which comes from the Community Management API
 *    product (LinkedIn reviews applications for it).
 *  - Sign-ins last 60 days and, for ordinary apps, cannot be renewed in the background. Someone must press Connect again.
 *  - Every request carries a version (YYYYMM). LinkedIn retires each version after about a year, so update LINKEDIN_VERSION
 *    from time to time (the docs list the current ones).
 */

export const LINKEDIN_VERSION = "202609";
const TEXT_LIMIT = 3000;
const DAY = 24 * 3_600_000;
const MIN_VIDEO_BYTES = 75 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

const apiBase = (c: Config) => String(c.apiBase || "https://api.linkedin.com").replace(/\/+$/, "");
const authBase = (c: Config) => String(c.authBase || "https://www.linkedin.com").replace(/\/+$/, "");

/**
 * Post text uses LinkedIn's "little" format, where these characters have special meaning and must carry a backslash to
 * show as themselves. A bare ( or [ can silently cut a post short. A # that starts a word is left alone, so it stays a
 * real hashtag.
 */
export function linkedinText(text: string): string {
  return text.replace(/[|{}@[\]()<>#\\*_~]/g, (ch, offset: number, whole: string) => {
    if (ch === "#") {
      const startsWord = offset === 0 || /\s/.test(whole[offset - 1]);
      if (startsWord && /^[\p{L}\p{N}]/u.test(whole.slice(offset + 1, offset + 2))) return ch;
    }
    return `\\${ch}`;
  });
}

function headers(config: Config, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${String(config.accessToken)}`,
    "Linkedin-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    ...extra,
  };
}

/** A LinkedIn call that returns the whole response, because a new post's id is in a header, not the body. */
async function call(config: Config, route: string, init: RequestInit, what: string): Promise<{ res: Response; body: any }> {
  const res = await fetch(`${apiBase(config)}${route}`, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* keep the text */
  }
  if (!res.ok) {
    const hint =
      res.status === 401
        ? " Reconnect LinkedIn in Settings: its sign-in has expired or been revoked."
        : res.status === 403
          ? " The signed-in person may not be an administrator of the Page, or the app may not have posting permission yet."
          : "";
    throw new ApiError(`${what} failed (${res.status}): ${errorDetail(body, res.statusText)}.${hint}`, res.status, body);
  }
  return { res, body };
}

function assertSignedIn(config: Config): void {
  const expires = Date.parse(String(config.tokenExpiresAt ?? ""));
  if (Number.isFinite(expires) && expires <= Date.now()) {
    throw new Error("LinkedIn's sign-in has expired (they last 60 days). Press Connect for LinkedIn in Settings to renew it.");
  }
}

const owner = (config: Config) => `urn:li:organization:${String(config.organizationId)}`;

async function uploadImage(config: Config, file: string): Promise<string> {
  const image = await prepareImage(file, { maxBytes: 8 * 1024 * 1024, maxEdge: 4096 });
  const { body } = await call(
    config,
    "/rest/images?action=initializeUpload",
    {
      method: "POST",
      headers: headers(config, { "Content-Type": "application/json" }),
      body: JSON.stringify({ initializeUploadRequest: { owner: owner(config) } }),
    },
    "LinkedIn image upload",
  );
  const { uploadUrl, image: urn } = body.value ?? {};
  if (!uploadUrl || !urn) throw new Error("LinkedIn didn't say where to upload the image.");
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${String(config.accessToken)}`, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(image.bytes),
  });
  if (!put.ok) throw new ApiError(`LinkedIn image upload failed (${put.status}).`, put.status, await put.text().catch(() => ""));
  return String(urn);
}

async function uploadVideo(config: Config, file: string): Promise<string> {
  const size = (await fs.stat(file)).size;
  const { body } = await call(
    config,
    "/rest/videos?action=initializeUpload",
    {
      method: "POST",
      headers: headers(config, { "Content-Type": "application/json" }),
      body: JSON.stringify({ initializeUploadRequest: { owner: owner(config), fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } }),
    },
    "LinkedIn video upload",
  );
  const init = body.value ?? {};
  const parts: { firstByte: number; lastByte: number; uploadUrl: string }[] = init.uploadInstructions ?? [];
  if (!init.video || parts.length === 0) throw new Error("LinkedIn didn't say where to upload the video.");

  // The video goes up in the pieces LinkedIn asked for. Each answer carries an id (its ETag) that must be handed back in order.
  const etags: string[] = [];
  const handle = await fs.open(file, "r");
  try {
    for (const part of parts) {
      const length = part.lastByte - part.firstByte + 1;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, part.firstByte);
      const put = await fetch(part.uploadUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${String(config.accessToken)}`, "Content-Type": "application/octet-stream" },
        body: new Uint8Array(chunk.subarray(0, bytesRead)),
      });
      if (!put.ok) throw new ApiError(`LinkedIn video upload failed (${put.status}).`, put.status, await put.text().catch(() => ""));
      const etag = put.headers.get("etag");
      if (!etag) throw new Error("LinkedIn didn't acknowledge a piece of the video.");
      etags.push(etag.replace(/^"|"$/g, ""));
    }
  } finally {
    await handle.close();
  }

  await call(
    config,
    "/rest/videos?action=finalizeUpload",
    {
      method: "POST",
      headers: headers(config, { "Content-Type": "application/json" }),
      body: JSON.stringify({ finalizeUploadRequest: { video: init.video, uploadToken: init.uploadToken ?? "", uploadedPartIds: etags } }),
    },
    "LinkedIn video finish",
  );

  // Let LinkedIn finish processing if it will tell us. If it won't (some tokens can't read videos), go ahead: the post
  // is accepted while the video finishes.
  try {
    await pollUntil(
      "LinkedIn to process the video",
      async () => {
        const { body: v } = await call(config, `/rest/videos/${encodeURIComponent(String(init.video))}`, { headers: headers(config) }, "LinkedIn video check");
        if (v.status === "AVAILABLE") return true;
        if (v.status === "PROCESSING_FAILED") throw new Error(`LinkedIn couldn't process the video (${v.processingFailureReason ?? "unknown reason"}).`);
        return undefined;
      },
      { everyMs: 3000, timeoutMs: 5 * 60_000 },
    );
  } catch (error) {
    if (error instanceof Error && /couldn't process/.test(error.message)) throw error;
  }
  return String(init.video);
}

/** LinkedIn's sign-in check: is this token live, and does it include permission to post as a Page? */
async function introspect(config: Config): Promise<{ active: boolean; scope: string; expiresAt: string | null }> {
  const res = await fetchJson<{ active?: boolean; scope?: string; expires_at?: number }>(
    `${authBase(config)}/oauth/v2/introspectToken`,
    {
      method: "POST",
      body: form({ client_id: String(config.clientId), client_secret: String(config.clientSecret), token: String(config.accessToken) }),
    },
    "LinkedIn sign-in check",
  );
  return {
    active: res.active === true,
    scope: String(res.scope ?? ""),
    expiresAt: res.expires_at ? new Date(res.expires_at * 1000).toISOString() : null,
  };
}

export const linkedin: Provider = {
  kind: "linkedin",
  label: "LinkedIn Page",
  fields: [],
  secretKeys: ["accessToken", "refreshToken", "clientSecret"],

  async connect(config, ctx) {
    if (!config.accessToken || !config.organizationId) throw new Error("This LinkedIn account is missing its sign-in. Use Connect in Settings.");
    assertSignedIn(config);
    let patch: Config = {};
    if (config.clientId && config.clientSecret) {
      const check = await introspect(config);
      if (!check.active) throw new Error("LinkedIn says this sign-in is no longer active. Press Connect for LinkedIn in Settings.");
      if (!check.scope.split(/[\s,]+/).includes("w_organization_social")) {
        throw new Error(
          "This LinkedIn sign-in can't post as a Page. The app needs the Community Management API (permission w_organization_social); see docs/SETUP.md.",
        );
      }
      if (check.expiresAt) patch = { tokenExpiresAt: check.expiresAt };
      ctx?.saveConfig(patch);
    }
    return {
      config: { ...config, ...patch },
      detail: `Connected to ${config.organizationName ? `the LinkedIn Page "${config.organizationName}"` : `LinkedIn Page ${config.organizationId}`}. LinkedIn can't hold a schedule, so this app posts at the scheduled time.`,
    };
  },

  textLimit: () => TEXT_LIMIT,
  countText: (text) => graphemeLength(text),
  accepts: () => null,

  async validateMedia(file, kind) {
    if (kind !== "video") return null;
    if (path.extname(file).toLowerCase() === ".mov") return "LinkedIn takes MP4 video. Convert this .mov to .mp4 first.";
    const size = (await fs.stat(file)).size;
    if (size < MIN_VIDEO_BYTES) return "LinkedIn needs a video of at least 75 KB.";
    if (size > MAX_VIDEO_BYTES) return "LinkedIn videos can be at most 500 MB.";
    return null;
  },

  async publish(config, input: PublishInput) {
    assertSignedIn(config);
    const content: Record<string, unknown> = {};
    if (input.mediaPath && input.mediaKind === "video") {
      content.media = { id: await uploadVideo(config, input.mediaPath), title: (input.title || input.text.split("\n")[0]).slice(0, 200) };
    } else if (input.mediaPath) {
      const media: Record<string, string> = { id: await uploadImage(config, input.mediaPath) };
      if (input.altText) media.altText = input.altText.slice(0, 4000);
      content.media = media;
    }

    const { res } = await call(
      config,
      "/rest/posts",
      {
        method: "POST",
        headers: headers(config, { "Content-Type": "application/json" }),
        body: JSON.stringify({
          author: owner(config),
          commentary: linkedinText(input.text),
          visibility: "PUBLIC",
          distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
          ...(Object.keys(content).length ? { content } : {}),
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        }),
      },
      "LinkedIn post",
    );
    const urn = res.headers.get("x-restli-id");
    return {
      url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : `https://www.linkedin.com/company/${config.organizationId}/`,
      id: urn ?? undefined,
    };
  },

  /** Only apps LinkedIn has given refresh tokens to can renew themselves; for everyone else this does nothing. */
  async maintain(config, ctx?: ProviderContext) {
    if (!config.refreshToken || !config.clientId || !config.clientSecret) return;
    const expires = Date.parse(String(config.tokenExpiresAt ?? ""));
    if (Number.isFinite(expires) && expires - Date.now() > 14 * DAY) return;
    const res = await fetchJson<{ access_token: string; expires_in: number; refresh_token?: string; refresh_token_expires_in?: number }>(
      `${authBase(config)}/oauth/v2/accessToken`,
      {
        method: "POST",
        body: form({
          grant_type: "refresh_token",
          refresh_token: String(config.refreshToken),
          client_id: String(config.clientId),
          client_secret: String(config.clientSecret),
        }),
      },
      "LinkedIn sign-in renewal",
    );
    ctx?.saveConfig({
      accessToken: res.access_token,
      tokenExpiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
      ...(res.refresh_token ? { refreshToken: res.refresh_token } : {}),
      ...(res.refresh_token_expires_in ? { refreshTokenExpiresAt: new Date(Date.now() + res.refresh_token_expires_in * 1000).toISOString() } : {}),
    });
  },

  async fetchStats(config, target) {
    assertSignedIn(config);
    // The post's own kind of urn decides which list the statistics call wants it in.
    const urn = target.externalId;
    const param = urn.startsWith("urn:li:ugcPost:") ? "ugcPosts" : "shares";
    const route =
      `/rest/organizationalEntityShareStatistics?q=organizationalEntity` +
      `&organizationalEntity=${encodeURIComponent(owner(config))}&${param}=List(${encodeURIComponent(urn)})`;
    const { body } = await call(config, route, { headers: headers(config) }, "Reading the LinkedIn post's statistics");
    const stat = body.elements?.[0]?.totalShareStatistics;
    if (!stat) throw new Error("LinkedIn gave no statistics for this post yet.");
    return {
      metrics: withTotals({
        views: Number(stat.impressionCount ?? 0),
        reach: Number(stat.uniqueImpressionsCount ?? 0),
        link_clicks: Number(stat.clickCount ?? 0),
        likes: Number(stat.likeCount ?? 0),
        comments: Number(stat.commentCount ?? 0),
        shares: Number(stat.shareCount ?? 0),
      }),
      notes: [],
    };
  },
};

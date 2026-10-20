import sharp from "sharp";
import { fetchJson, form, pollUntil } from "../http.ts";
import { withPublicUrl } from "../publicHost.ts";
import { graphemeLength } from "../util.ts";
import { graphBase } from "./graph.ts";
import { eachMetric, insightValue, withTotals } from "./insights.ts";
import type { Config, PostStats, Provider } from "./types.ts";

const CAPTION_LIMIT = 2200;
/** Instagram accepts images between 4:5 (portrait) and 1.91:1 (landscape). */
const MIN_RATIO = 0.8;
const MAX_RATIO = 1.91;

/** Instagram only accepts JPEG, so everything (PNGs included) is converted. */
async function toJpeg(file: string): Promise<Buffer> {
  return sharp(file, { failOn: "none" })
    .rotate()
    .resize({ width: 1440, height: 1440, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

async function waitForContainer(config: Config, id: string, timeoutMs: number): Promise<void> {
  await pollUntil(
    "Instagram to finish processing the media",
    async () => {
      const status = await fetchJson<{ status_code?: string; status?: string }>(
        `${graphBase(config)}/${id}?${form({ fields: "status_code,status", access_token: String(config.pageToken) })}`,
        {},
        "Instagram processing check",
      );
      if (status.status_code === "FINISHED") return true;
      if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
        throw new Error(`Instagram couldn't process the media (${status.status ?? status.status_code}).`);
      }
      return undefined;
    },
    { everyMs: 3000, timeoutMs },
  );
}

export const instagram: Provider = {
  kind: "instagram",
  label: "Instagram",
  fields: [],
  secretKeys: ["pageToken"],

  async connect(config) {
    const me = await fetchJson<{ username: string }>(
      `${graphBase(config)}/${config.igUserId}?${form({ fields: "username", access_token: String(config.pageToken) })}`,
      {},
      "Instagram account check",
    );
    return { config, detail: `Connected to @${me.username}. Images go through your image host.` };
  },

  maxImages: () => 10,
  textLimit: () => CAPTION_LIMIT,
  countText: (text) => graphemeLength(text),

  accepts: (kind) => (kind === null ? "Instagram posts need an image or a video." : null),

  async validateMedia(file, kind) {
    if (kind === "video") return null;
    const { width, height } = await sharp(file, { failOn: "none" }).metadata();
    if (!width || !height) return "Instagram can't read this image.";
    const ratio = width / height;
    if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
      return `Instagram only accepts shapes between 4:5 and 1.91:1. This image is ${width}x${height}.`;
    }
    return null;
  },

  async publish(config, input) {
    if (!input.mediaPath || !input.mediaKind) throw new Error("Instagram posts need an image or a video.");
    const base = graphBase(config);
    const ig = String(config.igUserId);
    const token = String(config.pageToken);

    // The caption belongs on the post, not on the separate pictures of a carousel.
    const create = (params: Record<string, string | undefined>, caption: string | null = input.text) =>
      fetchJson<{ id: string }>(
        `${base}/${ig}/media`,
        { method: "POST", body: form({ ...params, caption, access_token: token }) },
        "Instagram media upload",
      );

    let containerId: string;
    if (input.mediaKind === "video") {
      // The video must stay reachable until Instagram has finished fetching and processing it.
      const ext = input.mediaPath.split(".").pop() ?? "mp4";
      containerId = await withPublicUrl(
        { file: input.mediaPath, contentType: ext === "mov" ? "video/quicktime" : "video/mp4", extension: ext },
        async (url) => {
          const container = await create({ media_type: "REELS", video_url: url, share_to_feed: "true" });
          await waitForContainer(config, container.id, 10 * 60_000);
          return container.id;
        },
      );
    } else if (input.extraImages?.length) {
      // Several pictures make a carousel: each picture becomes its own item, then one post holds them all.
      const pictures = [{ path: input.mediaPath, altText: input.altText }, ...input.extraImages];
      const items: string[] = [];
      for (const picture of pictures) {
        const bytes = await toJpeg(picture.path);
        items.push(
          await withPublicUrl({ bytes, contentType: "image/jpeg", extension: "jpg" }, async (url) => {
            const item = await create({ image_url: url, is_carousel_item: "true", alt_text: picture.altText || undefined }, null);
            await waitForContainer(config, item.id, 2 * 60_000);
            return item.id;
          }),
        );
      }
      const carousel = await create({ media_type: "CAROUSEL", children: items.join(",") });
      await waitForContainer(config, carousel.id, 2 * 60_000);
      containerId = carousel.id;
    } else {
      const bytes = await toJpeg(input.mediaPath);
      containerId = await withPublicUrl({ bytes, contentType: "image/jpeg", extension: "jpg" }, async (url) => {
        const container = await create({ image_url: url, alt_text: input.altText || undefined });
        await waitForContainer(config, container.id, 2 * 60_000);
        return container.id;
      });
    }

    const published = await fetchJson<{ id: string }>(
      `${base}/${ig}/media_publish`,
      { method: "POST", body: form({ creation_id: containerId, access_token: token }) },
      "Instagram publish",
    );
    const info = await fetchJson<{ permalink?: string }>(
      `${base}/${published.id}?${form({ fields: "permalink", access_token: token })}`,
      {},
      "Instagram link lookup",
    ).catch(() => ({}) as { permalink?: string });
    return { url: info.permalink ?? `https://www.instagram.com/${config.username ?? ""}`, id: published.id };
  },

  async fetchStats(config, target) {
    const base = graphBase(config);
    const token = String(config.pageToken);
    const id = target.externalId;
    const metrics: PostStats["metrics"] = {};
    const notes: string[] = [];

    const node = await fetchJson<{ like_count?: number; comments_count?: number }>(
      `${base}/${id}?${form({ fields: "like_count,comments_count", access_token: token })}`,
      {},
      "Reading the Instagram post's counts",
    );
    if (typeof node.like_count === "number") metrics.likes = node.like_count;
    if (typeof node.comments_count === "number") metrics.comments = node.comments_count;

    const { values, permissionDenied, unavailable } = await eachMetric(
      ["views", "reach", "shares", "saved", "total_interactions", "follows", "profile_visits"],
      async (name) => insightValue(await fetchJson(`${base}/${id}/insights?${form({ metric: name, access_token: token })}`, {}, `Reading Instagram ${name}`)),
    );
    if (permissionDenied) {
      notes.push("Instagram: views and reach need the instagram_manage_insights permission. Press Connect for Facebook and Instagram in Settings to add it.");
    }
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    metrics.views = num(values.views);
    metrics.reach = num(values.reach);
    metrics.shares = num(values.shares);
    metrics.saves = num(values.saved);
    metrics.interactions = num(values.total_interactions);
    metrics.follows = num(values.follows);
    metrics.visits = num(values.profile_visits);
    if (!permissionDenied && metrics.views === undefined && unavailable.includes("views")) {
      notes.push("Instagram didn't give views for this post.");
    }
    return { metrics: withTotals(Object.fromEntries(Object.entries(metrics).filter(([, v]) => v !== undefined))), notes };
  },
};

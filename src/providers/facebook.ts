import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchJson, form } from "../http.ts";
import { prepareImage } from "../images.ts";
import { graphemeLength } from "../util.ts";
import { firstUrl, graphBase, isGone, isNoSuchField } from "./graph.ts";
import { eachMetric, insightValue, withTotals } from "./insights.ts";
import type { Config, PostStats, Provider, PublishInput, RemoteRef } from "./types.ts";

const POST_LIMIT = 63_206;
/** Facebook's simple (single request) video upload tops out around 1 GB. */
const MAX_VIDEO_BYTES = 1_000_000_000;

interface Created {
  id: string;
  post_id?: string;
}

/** Creates a post on the Page, immediately or (when `whenIso` is given) as a Facebook-held scheduled post. */
async function createPost(config: Config, input: PublishInput, whenIso?: string): Promise<{ created: Created; kind: string }> {
  const base = graphBase(config);
  const page = String(config.pageId);
  const token = String(config.pageToken);
  const schedule = whenIso
    ? { published: "false", scheduled_publish_time: String(Math.floor(Date.parse(whenIso) / 1000)) }
    : {};

  if (!input.mediaPath) {
    // Passing the first link as `link` makes Facebook show a preview card for it.
    const created = await fetchJson<Created>(
      `${base}/${page}/feed`,
      { method: "POST", body: form({ message: input.text, link: firstUrl(input.text), access_token: token, ...schedule }) },
      "Facebook post",
    );
    return { created, kind: "post" };
  }

  const body = new FormData();
  body.set("access_token", token);
  if (!whenIso) for (const [k, v] of Object.entries(schedule)) body.set(k, v);

  if (input.mediaKind === "video") {
    body.set("source", await openAsBlob(input.mediaPath), path.basename(input.mediaPath));
    body.set("description", input.text);
    body.set("title", input.title || input.text.split("\n")[0].slice(0, 100));
    const created = await fetchJson<Created>(`${base}/${page}/videos`, { method: "POST", body }, "Facebook video upload");
    return { created, kind: "video" };
  }

  const image = await prepareImage(input.mediaPath, { maxBytes: 8 * 1024 * 1024, maxEdge: 4096 });
  body.set("source", new Blob([new Uint8Array(image.bytes)], { type: image.mime }), path.basename(input.mediaPath));
  if (input.altText) body.set("alt_text_custom", input.altText);

  if (whenIso) {
    // A scheduled photo can't be scheduled through /photos: the Photo it makes can't say whether it has been published,
    // so there'd be no way to tell. Facebook's documented route is to upload the photo unpublished (temporary, so an
    // unused one is cleaned up by Facebook) and schedule a normal post that carries it. That post can be asked.
    body.set("published", "false");
    body.set("temporary", "true");
    const photo = await fetchJson<Created>(`${base}/${page}/photos`, { method: "POST", body }, "Facebook photo upload");
    const created = await fetchJson<Created>(
      `${base}/${page}/feed`,
      {
        method: "POST",
        body: form({
          message: input.text,
          "attached_media[0]": JSON.stringify({ media_fbid: photo.id }),
          access_token: token,
          ...schedule,
          unpublished_content_type: "SCHEDULED",
        }),
      },
      "Scheduling the Facebook post",
    );
    return { created, kind: "post" };
  }

  body.set("caption", input.text);
  const created = await fetchJson<Created>(`${base}/${page}/photos`, { method: "POST", body }, "Facebook photo upload");
  return { created, kind: "photo" };
}

async function permalink(config: Config, id: string, kind: string): Promise<string> {
  try {
    const info = await fetchJson<{ permalink_url?: string }>(
      `${graphBase(config)}/${id}?${form({ fields: "permalink_url", access_token: String(config.pageToken) })}`,
      {},
      "Facebook link lookup",
    );
    if (info.permalink_url) {
      return info.permalink_url.startsWith("http") ? info.permalink_url : `https://www.facebook.com${info.permalink_url}`;
    }
  } catch {
    /* fall through to a constructed link */
  }
  return kind === "video" ? `https://www.facebook.com/${config.pageId}/videos/${id}` : `https://www.facebook.com/${id}`;
}

export const facebook: Provider = {
  kind: "facebook",
  label: "Facebook Page",
  fields: [],
  secretKeys: ["pageToken"],

  async connect(config) {
    const page = await fetchJson<{ name: string }>(
      `${graphBase(config)}/${config.pageId}?${form({ fields: "name", access_token: String(config.pageToken) })}`,
      {},
      "Facebook Page check",
    );
    return { config, detail: `Connected to the Page "${page.name}". Facebook will hold the schedule.` };
  },

  textLimit: () => POST_LIMIT,
  countText: (text) => graphemeLength(text),
  accepts: () => null,

  async validateMedia(file, kind) {
    if (kind !== "video") return null;
    const size = (await fs.stat(file)).size;
    return size > MAX_VIDEO_BYTES ? "Facebook videos over 1 GB aren't supported yet." : null;
  },

  async publish(config, input) {
    const { created, kind } = await createPost(config, input);
    return { url: await permalink(config, created.post_id ?? created.id, kind), id: created.post_id ?? created.id };
  },

  // Facebook can hold a scheduled post itself, so it goes out even if this Mac is off.
  supportsServerSchedule: () => true,
  serverScheduleWindow: () => ({ minMs: 11 * 60_000, maxMs: 29 * 24 * 3_600_000 }), // Facebook: 10 minutes to 30 days

  async scheduleOnServer(config, input, whenIso) {
    const { created, kind } = await createPost(config, input, whenIso);
    return { id: created.post_id ?? created.id, kind };
  },

  async cancelOnServer(config, remote: RemoteRef) {
    try {
      await fetchJson(
        `${graphBase(config)}/${remote.id}?${form({ access_token: String(config.pageToken) })}`,
        { method: "DELETE" },
        "Cancelling the scheduled Facebook post",
      );
      return true;
    } catch (e) {
      if (isGone(e)) return false;
      throw e;
    }
  },

  async checkOnServer(config, remote: RemoteRef) {
    const fields = remote.kind === "video" ? "published,permalink_url" : "is_published,permalink_url";
    try {
      const info = await fetchJson<{ is_published?: boolean; published?: boolean; permalink_url?: string }>(
        `${graphBase(config)}/${remote.id}?${form({ fields, access_token: String(config.pageToken) })}`,
        {},
        "Checking the scheduled Facebook post",
      );
      if (info.is_published === true || info.published === true) {
        const url = info.permalink_url
          ? info.permalink_url.startsWith("http")
            ? info.permalink_url
            : `https://www.facebook.com${info.permalink_url}`
          : undefined;
        return { state: "published", url, id: remote.id };
      }
      return { state: "pending" };
    } catch (e) {
      if (isGone(e)) return { state: "gone" };
      // A question Facebook can't answer (e.g. asking a Photo if it's published) says nothing about the post.
      // Treat it as still pending so the app's "overdue" check, not a false "gone", is what eventually flags it.
      if (isNoSuchField(e)) return { state: "pending" };
      throw e;
    }
  },

  async fetchStats(config, target) {
    const base = graphBase(config);
    const token = String(config.pageToken);
    const id = target.externalId;
    // A video's id has no Page prefix; a post's is "PAGE_POST".
    const isVideo = !id.includes("_");
    const metrics: PostStats["metrics"] = {};
    const notes: string[] = [];

    // Reactions, comments and shares: allowed by the permission posting already needs.
    const node = await fetchJson<any>(
      `${base}/${id}?${form({
        fields: isVideo
          ? "likes.summary(true).limit(0),comments.summary(true).limit(0)"
          : "reactions.summary(true).limit(0),comments.summary(true).limit(0),shares",
        access_token: token,
      })}`,
      {},
      "Reading the Facebook post's counts",
    );
    // A count Facebook didn't send is left out, not turned into a zero: "0 likes" and "no answer" are different things.
    const total = (edge: any): number | undefined => (typeof edge?.summary?.total_count === "number" ? edge.summary.total_count : undefined);
    metrics.likes = total(node.reactions) ?? total(node.likes);
    metrics.comments = total(node.comments);
    if (metrics.likes === undefined && metrics.comments === undefined) {
      notes.push("Facebook sent no reaction or comment counts for this post.");
    } else if (!isVideo) {
      // Facebook leaves `shares` out when there are none.
      metrics.shares = Number(node.shares?.count ?? 0);
    }

    // Views and reach come from Insights, which needs the read_insights permission.
    const names = isVideo
      ? ["total_video_views", "total_video_impressions_unique"]
      : ["post_media_view", "post_total_media_view_unique", "post_clicks_by_type"];
    const route = isVideo ? "video_insights" : "insights";
    const { values, permissionDenied, unavailable } = await eachMetric(names, async (name) =>
      insightValue(await fetchJson(`${base}/${id}/${route}?${form({ metric: name, access_token: token })}`, {}, `Reading Facebook ${name}`)),
    );
    if (permissionDenied) {
      notes.push("Facebook: views and reach need the read_insights permission. Press Connect for Facebook in Settings to add it.");
    }
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    metrics.views = num(values.post_media_view) ?? num(values.total_video_views);
    metrics.viewers = num(values.post_total_media_view_unique) ?? num(values.total_video_impressions_unique);
    const clicks = values.post_clicks_by_type;
    if (clicks && typeof clicks === "object") metrics.link_clicks = Number((clicks as Record<string, number>)["link clicks"] ?? 0);
    const empty = names.filter((n) => n in values && values[n] === undefined);
    if (!permissionDenied && empty.length) notes.push(`Facebook returned no data for ${empty.join(", ")}.`);
    if (!permissionDenied && metrics.views === undefined && unavailable.length) {
      notes.push(`Facebook didn't give views for this post (${unavailable.join(", ")} unavailable).`);
    }
    return { metrics: withTotals(Object.fromEntries(Object.entries(metrics).filter(([, v]) => v !== undefined))), notes };
  },
};

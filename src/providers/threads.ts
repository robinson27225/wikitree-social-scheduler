import { fetchJson, form, pollUntil } from "../http.ts";
import { withPublicUrl } from "../publicHost.ts";
import sharp from "sharp";
import { eachMetric, insightValue, withTotals } from "./insights.ts";
import type { Config, PostStats, Provider } from "./types.ts";

const TEXT_LIMIT = 500;
const DAY = 24 * 3_600_000;

function threadsBase(config: Config): string {
  // `threadsBase` exists so tests can point at a fake server.
  return String(config.threadsBase || "https://graph.threads.net/v1.0").replace(/\/+$/, "");
}

/** Threads counts emoji and other non-BMP characters by their UTF-8 size, so count them as 4. */
export function threadsLength(text: string): number {
  let n = 0;
  for (const ch of text) n += (ch.codePointAt(0) ?? 0) > 0xffff ? 4 : 1;
  return n;
}

/** Threads' long-lived tokens last 60 days; refreshing resets the clock (the token must be 24h+ old). */
async function refreshToken(config: Config): Promise<Partial<Config>> {
  const base = String(config.threadsRefreshBase || "https://graph.threads.net");
  const res = await fetchJson<{ access_token: string; expires_in: number }>(
    `${base}/refresh_access_token?${form({ grant_type: "th_refresh_token", access_token: String(config.accessToken) })}`,
    {},
    "Threads token refresh",
  );
  return {
    accessToken: res.access_token,
    tokenExpiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
    tokenRefreshedAt: new Date().toISOString(),
  };
}

export const threads: Provider = {
  kind: "threads",
  label: "Threads",
  fields: [],
  secretKeys: ["accessToken"],

  async connect(config) {
    const me = await fetchJson<{ username: string }>(
      `${threadsBase(config)}/me?${form({ fields: "username", access_token: String(config.accessToken) })}`,
      {},
      "Threads account check",
    );
    return { config, detail: `Connected to @${me.username}.` };
  },

  textLimit: () => TEXT_LIMIT,
  countText: (text) => threadsLength(text),
  accepts: () => null,

  async publish(config, input, ctx) {
    // Don't let an almost-expired token break a post.
    const expires = Date.parse(String(config.tokenExpiresAt ?? ""));
    if (Number.isFinite(expires) && expires - Date.now() < 7 * DAY) {
      try {
        const patch = await refreshToken(config);
        ctx?.saveConfig(patch);
        config = { ...config, ...patch };
      } catch {
        /* the existing token may still work; the post will say if not */
      }
    }

    const base = threadsBase(config);
    const user = String(config.threadsUserId);
    const token = String(config.accessToken);

    const create = (params: Record<string, string | undefined>) =>
      fetchJson<{ id: string }>(
        `${base}/${user}/threads`,
        { method: "POST", body: form({ ...params, access_token: token }) },
        "Threads post",
      );
    const publish = async (creationId: string) =>
      fetchJson<{ id: string }>(
        `${base}/${user}/threads_publish`,
        { method: "POST", body: form({ creation_id: creationId, access_token: token }) },
        "Threads publish",
      );
    const waitFor = (id: string, timeoutMs: number) =>
      pollUntil(
        "Threads to finish processing the media",
        async () => {
          const s = await fetchJson<{ status?: string; error_message?: string }>(
            `${base}/${id}?${form({ fields: "status,error_message", access_token: token })}`,
            {},
            "Threads processing check",
          );
          if (s.status === "FINISHED") return true;
          if (s.status === "ERROR" || s.status === "EXPIRED") {
            throw new Error(`Threads couldn't process the media (${s.error_message ?? s.status}).`);
          }
          return undefined;
        },
        { everyMs: 3000, timeoutMs },
      );

    let postId: string;
    if (!input.mediaPath) {
      postId = (await publish((await create({ media_type: "TEXT", text: input.text })).id)).id;
    } else if (input.mediaKind === "video") {
      const ext = input.mediaPath.split(".").pop() ?? "mp4";
      postId = await withPublicUrl(
        { file: input.mediaPath, contentType: ext === "mov" ? "video/quicktime" : "video/mp4", extension: ext },
        async (url) => {
          const container = await create({ media_type: "VIDEO", video_url: url, text: input.text });
          await waitFor(container.id, 10 * 60_000);
          return (await publish(container.id)).id;
        },
      );
    } else {
      const bytes = await sharp(input.mediaPath, { failOn: "none" })
        .rotate()
        .resize({ width: 1440, height: 1440, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
      postId = await withPublicUrl({ bytes, contentType: "image/jpeg", extension: "jpg" }, async (url) => {
        const container = await create({
          media_type: "IMAGE",
          image_url: url,
          text: input.text,
          alt_text: input.altText || undefined,
        });
        await waitFor(container.id, 2 * 60_000);
        return (await publish(container.id)).id;
      });
    }

    const info = await fetchJson<{ permalink?: string }>(
      `${base}/${postId}?${form({ fields: "permalink", access_token: token })}`,
      {},
      "Threads link lookup",
    ).catch(() => ({}) as { permalink?: string });
    return { url: info.permalink ?? `https://www.threads.net/@${config.username ?? ""}`, id: postId };
  },

  async maintain(config, ctx) {
    const refreshedAt = Date.parse(String(config.tokenRefreshedAt ?? ""));
    const expiresAt = Date.parse(String(config.tokenExpiresAt ?? ""));
    const stale = !Number.isFinite(refreshedAt) || Date.now() - refreshedAt > 30 * DAY;
    const expiringSoon = Number.isFinite(expiresAt) && expiresAt - Date.now() < 20 * DAY;
    if (!stale && !expiringSoon) return;
    ctx?.saveConfig(await refreshToken(config));
  },

  async fetchStats(config, target) {
    const base = threadsBase(config);
    const token = String(config.accessToken);
    const { values, permissionDenied } = await eachMetric(["views", "likes", "replies", "reposts", "quotes", "shares"], async (name) =>
      insightValue(await fetchJson(`${base}/${target.externalId}/insights?${form({ metric: name, access_token: token })}`, {}, `Reading Threads ${name}`)),
    );
    const notes: string[] = [];
    if (permissionDenied && Object.keys(values).length === 0) {
      notes.push("Threads: numbers need the threads_manage_insights permission. Press Connect for Threads in Settings to add it.");
    }
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    const metrics: PostStats["metrics"] = { views: num(values.views), likes: num(values.likes), comments: num(values.replies) };
    // Reposts and quotes are other people sharing the post onward.
    const shared = [values.reposts, values.quotes, values.shares].filter((v) => typeof v === "number") as number[];
    if (shared.length) metrics.shares = shared.reduce((a, b) => a + b, 0);
    return { metrics: withTotals(Object.fromEntries(Object.entries(metrics).filter(([, v]) => v !== undefined))), notes };
  },
};

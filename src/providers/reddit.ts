import { ApiError, fetchJson, form, pollUntil } from "../http.ts";
import { prepareImage } from "../images.ts";
import { graphemeLength } from "../util.ts";
import type { Config, Provider, ProviderContext } from "./types.ts";

const authBase = (c: Config) => String(c.authBase || "https://www.reddit.com").replace(/\/+$/, "");
const oauthBase = (c: Config) => String(c.oauthBase || "https://oauth.reddit.com").replace(/\/+$/, "");
/** Reddit blocks generic user agents, and wants one that says who is calling. */
const userAgent = (c: Config) => `social-scheduler/0.1 (by /u/${c.username || "unknown"})`;

async function accessToken(config: Config, ctx?: ProviderContext): Promise<string> {
  const expires = Date.parse(String(config.accessTokenExpiresAt ?? ""));
  if (config.accessToken && Number.isFinite(expires) && expires - Date.now() > 60_000) return String(config.accessToken);
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const res = await fetchJson<{ access_token: string; expires_in: number }>(
    `${authBase(config)}/api/v1/access_token`,
    {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "User-Agent": userAgent(config) },
      body: form({ grant_type: "refresh_token", refresh_token: String(config.refreshToken) }),
    },
    "Reddit sign-in refresh",
  );
  ctx?.saveConfig({
    accessToken: res.access_token,
    accessTokenExpiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
  });
  return res.access_token;
}

async function api<T = any>(config: Config, token: string, route: string, init: RequestInit, what: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("User-Agent", userAgent(config));
  return fetchJson<T>(`${oauthBase(config)}${route}`, { ...init, headers }, what);
}

/** Reddit's submit endpoint answers 200 even for failures, with the reasons inside. */
function checkSubmit(res: { json?: { errors?: string[][]; data?: any } }, what: string) {
  const errors = res.json?.errors ?? [];
  if (errors.length) throw new Error(`${what} failed: ${errors.map((e) => e.slice(0, 2).join(": ")).join("; ")}`);
  return res.json?.data ?? {};
}

export const reddit: Provider = {
  kind: "reddit",
  label: "Reddit",
  fields: [],
  secretKeys: ["clientSecret", "refreshToken", "accessToken"],

  async connect(config, ctx) {
    const token = await accessToken(config, ctx);
    const me = await api<{ name: string }>(config, token, "/api/v1/me", {}, "Reddit account check");
    return { config, detail: `Connected as u/${me.name}, posting to r/${config.subreddit}.` };
  },

  textLimit: () => 40_000,
  countText: (text) => graphemeLength(text),
  needsTitle: "required",
  titleLimit: () => 300,

  accepts: (kind) => (kind === "video" ? "Reddit video uploads aren't supported yet." : null),

  async publish(config, input, ctx) {
    const token = await accessToken(config, ctx);
    const sr = String(config.subreddit);
    const title = (input.title || input.text.split("\n")[0]).slice(0, 300);
    if (!title) throw new Error("Reddit posts need a title.");
    const common = { api_type: "json", sr, title, resubmit: "true", flair_id: config.flairId ? String(config.flairId) : undefined };

    // A text post: the text is the body.
    if (!input.mediaPath) {
      const res = await api(config, token, "/api/submit", { method: "POST", body: form({ ...common, kind: "self", text: input.text }) }, "Reddit post");
      const data = checkSubmit(res, "Reddit post");
      return { url: String(data.url ?? `https://www.reddit.com/r/${sr}/`), id: data.id ? String(data.id) : undefined };
    }

    // An image post: upload to Reddit's media storage first, then submit it by address.
    const image = await prepareImage(input.mediaPath, { maxBytes: 18 * 1024 * 1024, maxEdge: 6000 });
    const filename = `image.${image.mime === "image/png" ? "png" : "jpg"}`;
    const lease = await api<{ args: { action: string; fields: { name: string; value: string }[] } }>(
      config,
      token,
      "/api/media/asset.json",
      { method: "POST", body: form({ filepath: filename, mimetype: image.mime }) },
      "Reddit image upload (start)",
    );
    const upload = new FormData();
    for (const f of lease.args.fields) upload.set(f.name, f.value);
    upload.set("file", new Blob([new Uint8Array(image.bytes)], { type: image.mime }), filename);
    const action = lease.args.action.startsWith("//") ? `https:${lease.args.action}` : lease.args.action;
    const sent = await fetch(action, { method: "POST", body: upload });
    if (!sent.ok) throw new Error(`Reddit image upload failed (${sent.status}).`);
    const key = lease.args.fields.find((f) => f.name === "key")?.value;
    if (!key) throw new Error("Reddit didn't say where the image was stored.");

    const res = await api(
      config,
      token,
      "/api/submit",
      { method: "POST", body: form({ ...common, kind: "image", url: `${action.replace(/\/+$/, "")}/${key}` }) },
      "Reddit post",
    );
    checkSubmit(res, "Reddit post");

    // Image posts return no address until Reddit has processed them, so find the new post in the account's list.
    const found = await pollUntil(
      "the new Reddit post to appear",
      async () => {
        const list = await api<{ data: { children: { data: { title: string; permalink: string; name: string; created_utc: number } }[] } }>(
          config,
          token,
          `/user/${config.username}/submitted?${form({ limit: 10, raw_json: 1 })}`,
          {},
          "Reddit post lookup",
        );
        return list.data.children.map((c) => c.data).find((p) => p.title === title && Date.now() / 1000 - p.created_utc < 600);
      },
      { everyMs: 4000, timeoutMs: 90_000 },
    );

    // Image posts can't carry body text, so any text goes in as the first comment.
    let note: string | undefined;
    if (input.text.trim()) {
      try {
        await api(config, token, "/api/comment", { method: "POST", body: form({ api_type: "json", thing_id: found.name, text: input.text }) }, "Reddit comment");
      } catch (e) {
        note = `The image posted, but adding the text as a comment failed: ${e instanceof ApiError ? e.message : String(e)}`;
      }
    }
    return { url: `https://www.reddit.com${found.permalink}`, note, id: String(found.name ?? "").replace(/^t3_/, "") || undefined };
  },
};

import { AtpAgent, RichText } from "@atproto/api";
import { prepareImage } from "../images.ts";
import { graphemeLength } from "../util.ts";
import { fetchJson, form } from "../http.ts";
import { withTotals } from "./insights.ts";
import type { Config, Provider } from "./types.ts";

const DEFAULT_SERVICE = "https://bsky.social";
const POST_LIMIT = 300;
// Bluesky rejects image blobs over 1,000,000 bytes.
const IMAGE_LIMITS = { maxBytes: 950_000, maxEdge: 2000 };

async function login(config: Config): Promise<AtpAgent> {
  const agent = new AtpAgent({ service: String(config.service || DEFAULT_SERVICE) });
  await agent.login({
    identifier: String(config.handle),
    password: String(config.appPassword),
  });
  return agent;
}

export const bluesky: Provider = {
  kind: "bluesky",
  label: "Bluesky",
  fields: [
    {
      name: "handle",
      label: "Handle",
      type: "text",
      placeholder: "wikitree.bsky.social",
      required: true,
    },
    {
      name: "appPassword",
      label: "App password",
      type: "password",
      placeholder: "xxxx-xxxx-xxxx-xxxx",
      help: "Create one in Bluesky under Settings > Privacy and security > App passwords. Never use your main password.",
      required: true,
    },
  ],

  async connect(config) {
    const agent = await login(config);
    const handle = agent.session?.handle ?? String(config.handle);
    return { config: { ...config, handle }, detail: `Signed in as @${handle}` };
  },

  maxImages: () => 4,
  textLimit: () => POST_LIMIT,
  countText: (text) => graphemeLength(text),
  accepts: (kind) => (kind === "video" ? "Video isn't supported for Bluesky yet." : null),

  async publish(config, input) {
    const agent = await login(config);
    let embed;
    if (input.mediaPath) {
      // The first picture, then the others: up to four in one post.
      const pictures = [{ path: input.mediaPath, altText: input.altText }, ...(input.extraImages ?? [])];
      const images = [];
      for (const picture of pictures) {
        const image = await prepareImage(picture.path, IMAGE_LIMITS);
        const upload = await agent.uploadBlob(image.bytes, { encoding: image.mime });
        images.push({ image: upload.data.blob, alt: picture.altText, aspectRatio: { width: image.width, height: image.height } });
      }
      embed = { $type: "app.bsky.embed.images" as const, images };
    }

    const rt = new RichText({ text: input.text });
    await rt.detectFacets(agent); // makes links, @mentions and #hashtags clickable

    const res = await agent.post({
      text: rt.text,
      facets: rt.facets,
      ...(embed ? { embed } : {}),
      createdAt: new Date().toISOString(),
    });

    const rkey = res.uri.split("/").pop();
    const handle = agent.session?.handle ?? String(config.handle);
    return { url: `https://bsky.app/profile/${handle}/post/${rkey}`, id: res.uri };
  },

  async fetchStats(config, target) {
    // Likes, reposts and replies are public: no sign-in is needed to read them.
    const base = String(config.statsBase || "https://public.api.bsky.app").replace(/\/+$/, "");
    const res = await fetchJson<{ posts?: { likeCount?: number; repostCount?: number; replyCount?: number; quoteCount?: number }[] }>(
      `${base}/xrpc/app.bsky.feed.getPosts?${form({ uris: target.externalId })}`,
      {},
      "Reading the Bluesky post's counts",
    );
    const post = res.posts?.[0];
    if (!post) throw new Error("Bluesky doesn't show this post any more.");
    return {
      metrics: withTotals({
        likes: post.likeCount ?? 0,
        shares: (post.repostCount ?? 0) + (post.quoteCount ?? 0),
        comments: post.replyCount ?? 0,
      }),
      notes: [],
    };
  },
};

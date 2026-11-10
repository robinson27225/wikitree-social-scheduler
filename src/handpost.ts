import type { Config } from "./providers/types.ts";

/**
 * Where to go to post by hand on a platform the app normally posts to itself. Any channel can be switched to "I'll post
 * this one by hand" (the platform is refusing, its sign-in has lapsed, or you just want to do it there), and the Queue then
 * offers this page beside the text and the picture.
 */
export function handPostUrl(kind: string, config: Config): string {
  const clean = (v: unknown) => String(v ?? "").trim();
  switch (kind) {
    case "facebook":
      return clean(config.pageId) ? `https://www.facebook.com/${encodeURIComponent(clean(config.pageId))}` : "https://www.facebook.com/";
    case "instagram":
      return "https://www.instagram.com/";
    case "threads":
      return "https://www.threads.net/";
    case "bluesky":
      return "https://bsky.app/";
    case "mastodon": {
      const instance = clean(config.instance).replace(/\/+$/, "");
      return /^https?:\/\//i.test(instance) ? `${instance}/publish` : "https://joinmastodon.org/";
    }
    case "linkedin":
      return clean(config.organizationId) ? `https://www.linkedin.com/company/${encodeURIComponent(clean(config.organizationId))}/admin/` : "https://www.linkedin.com/";
    case "youtube":
      return "https://studio.youtube.com/";
    case "x":
      return "https://x.com/compose/post";
    case "reddit":
      return clean(config.subreddit) ? `https://www.reddit.com/r/${encodeURIComponent(clean(config.subreddit))}/submit` : "https://www.reddit.com/submit";
    case "tiktok":
      return "https://www.tiktok.com/tiktokstudio/upload";
    default:
      return "";
  }
}

import { graphemeLength } from "../util.ts";
import type { Config, Provider } from "./types.ts";
import { xLength } from "./x.ts";

const DEFAULT_LIMIT = 5000;

/** Fills {text} and {title} in the address, so the platform's "new post" page opens already written. */
export function manualUrl(config: Config, post?: { text: string; title: string }): string {
  const url = String(config.url ?? "");
  if (!post) return url;
  return url.replaceAll("{text}", encodeURIComponent(post.text)).replaceAll("{title}", encodeURIComponent(post.title));
}

/**
 * For places you'd rather post by hand, or that have no way to post automatically: a YouTube
 * channel's Community tab (YouTube's API can't create those), X (per-post fees), Reddit (needs approval).
 * At the scheduled time the app doesn't post: it tells you, and the Queue offers the text, the image,
 * and a link to the platform's page (pre-filled where the platform allows it). You mark it posted afterwards.
 */
export const manual: Provider = {
  kind: "manual",
  label: "Manual: a reminder, you post it yourself",
  fields: [
    {
      name: "url",
      label: "Where you post it",
      type: "url",
      placeholder: "https://x.com/intent/post?text={text}",
      required: true,
      help:
        "The Queue shows an Open button for this address. {text} and {title} are replaced with the post's text and title, so the page opens already filled in. " +
        "X: https://x.com/intent/post?text={text}  |  Reddit: https://www.reddit.com/r/wikitree/submit?type=TEXT&title={title}&text={text}  |  YouTube Community: https://www.youtube.com/@WikiTreers/community  |  TikTok: https://www.tiktok.com/tiktokstudio/upload  |  LinkedIn: https://www.linkedin.com/company/1360133/admin/",
    },
    {
      name: "maxChars",
      label: "Character limit (optional)",
      type: "text",
      placeholder: "280",
      help: "Warns you while writing if the post is too long for that place, for example 280 for X.",
    },
    {
      name: "countLikeX",
      label: "Count links as 23 characters, like X does",
      type: "checkbox",
      default: false,
    },
    {
      name: "usesTitle",
      label: "This place needs a title (Reddit)",
      type: "checkbox",
      default: false,
      help: "Adds a required Title box when you pick this account.",
    },
  ],

  async connect(config) {
    const url = String(config.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("Enter a web address starting with https://");
    const rawLimit = String(config.maxChars ?? "").trim();
    let maxChars: number | undefined;
    if (rawLimit) {
      maxChars = Number(rawLimit);
      if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("The character limit must be a whole number such as 280.");
    }
    return {
      config: { ...config, url, ...(maxChars ? { maxChars } : { maxChars: undefined }) },
      detail: "Saved. At the scheduled time you'll get a notification and the post will be ready in the Queue.",
    };
  },

  textLimit: (config) => Number(config.maxChars) || DEFAULT_LIMIT,
  countText: (text, config) => (config.countLikeX ? xLength(text) : graphemeLength(text)),
  accepts: () => null,
  needsTitleFor: (config) => (config.usesTitle ? "required" : undefined),
  titleLimit: () => 300,
  manual: { openUrl: manualUrl },

  async publish() {
    throw new Error("Manual accounts are posted by hand; the app never posts to them itself.");
  },
};

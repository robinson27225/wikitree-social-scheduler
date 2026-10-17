import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_STYLE_GUIDE, getSecretSetting, getSetting } from "./db.ts";
import { prepareImage, thumbnail } from "./images.ts";
import { mediaKindOf } from "./media.ts";
import { HttpError } from "./util.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";

export function apiKey(): string {
  return process.env.ANTHROPIC_API_KEY || getSecretSetting("anthropic_api_key");
}

export function claudeConfigured(): boolean {
  return apiKey() !== "";
}

export interface DraftRequest {
  kind: "text" | "alt";
  /** Absolute path of the image, or null for a text-only post. */
  mediaPath: string | null;
  brief: string;
  /** Characters available on the tightest selected account. */
  charLimit: number;
  platforms: string[];
  currentText?: string;
}

function systemPrompt(kind: DraftRequest["kind"]): string {
  if (kind === "alt") {
    return [
      "You write alt text for images in social media posts, for people who use screen readers.",
      "Describe what is actually visible, objectively and concisely (usually one or two sentences, under 250 characters).",
      "Transcribe any important text in the image. Do not start with 'Image of'. Do not guess names or facts that aren't visible or given.",
      "Output only the alt text.",
    ].join("\n");
  }
  const styleGuide = getSetting("style_guide", DEFAULT_STYLE_GUIDE);
  return [
    "You write social media posts for an organisation. Follow this style guide:",
    "",
    styleGuide,
    "",
    "Rules: output only the posts, no commentary. Never invent facts, names, dates or links that aren't in the image or the brief.",
  ].join("\n");
}

/** Asks Claude to look at the image and draft either post options or alt text. */
export async function draft(req: DraftRequest): Promise<string[]> {
  const key = apiKey();
  if (!key) {
    throw new HttpError(400, "Add an Anthropic API key in Settings to use Draft with Claude.");
  }
  if (!req.mediaPath && req.kind === "alt") throw new HttpError(400, "There's no image to describe.");
  if (!req.mediaPath && !req.brief.trim() && !req.currentText?.trim()) {
    throw new HttpError(400, "Tell Claude what the post is about first (there's no image to work from).");
  }
  const client = new Anthropic({ apiKey: key });

  // Claude doesn't need more than ~1.5k px, and smaller uploads are faster and cheaper.
  // Claude can't watch a video, so for one it sees a still frame.
  const image = !req.mediaPath
    ? null
    : mediaKindOf(req.mediaPath) === "video"
      ? { bytes: await thumbnail(req.mediaPath, 1568), mime: "image/jpeg" }
      : await prepareImage(req.mediaPath, { maxBytes: 3_500_000, maxEdge: 1568 });

  const instructions =
    req.kind === "alt"
      ? "Write alt text for this image." + (req.brief ? `\n\nContext from the author: ${req.brief}` : "")
      : [
          req.brief
            ? `Brief from the author: ${req.brief}`
            : image
              ? "No brief was given, so base the post on the image."
              : "",
          image ? "" : "This post has no image, so write it from the brief alone.",
          req.currentText ? `The author's current draft, to improve or build on:\n${req.currentText}` : "",
          `This will be posted to: ${req.platforms.join(", ")}.`,
          `Every option must be at most ${req.charLimit} characters, counting hashtags and any URL.`,
          "Write 3 distinct options with different angles or openings.",
          "Separate the options with a line containing only ---",
        ]
          .filter(Boolean)
          .join("\n");

  const response = await client.messages.create({
    model: getSetting("claude_model", DEFAULT_MODEL) || DEFAULT_MODEL,
    max_tokens: 16000,
    output_config: { effort: "low" },
    system: systemPrompt(req.kind),
    messages: [
      {
        role: "user",
        content: [
          ...(image
            ? [
                {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: image.mime as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                    data: image.bytes.toString("base64"),
                  },
                },
              ]
            : []),
          { type: "text" as const, text: instructions },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new HttpError(422, "Claude declined to write this one. Try rewording the brief or write it by hand.");
  }
  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  if (!text) throw new HttpError(502, "Claude returned no text. Try again.");

  if (req.kind === "alt") return [text];
  return text
    .split(/^\s*---\s*$/m)
    .map((option) => option.trim())
    .filter(Boolean);
}

/** Turns SDK errors into messages a person can act on. */
export function explainClaudeError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof Anthropic.AuthenticationError) {
    return new HttpError(401, "The Anthropic API key was rejected. Check it in Settings.");
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new HttpError(429, "Claude is rate limiting requests. Wait a moment and try again.");
  }
  if (e instanceof Anthropic.NotFoundError) {
    return new HttpError(400, "That Claude model wasn't found. Check the model name in Settings.");
  }
  if (e instanceof Anthropic.APIError) {
    return new HttpError(502, `Claude API error (${e.status}): ${e.message}`);
  }
  return new HttpError(500, e instanceof Error ? e.message : String(e));
}

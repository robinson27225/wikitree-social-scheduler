import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";
import { DEFAULT_STYLE_GUIDE, get, getSecretSetting, getSetting, run, setSecretSetting } from "./db.ts";
import { open, seal } from "./secretbox.ts";
import { prepareImage, thumbnail } from "./images.ts";
import { mediaKindOf } from "./media.ts";
import { HttpError } from "./util.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * The Anthropic key to use for one person. On the shared server (Google sign-in) every person uses their own, so nobody's
 * drafts are charged to someone else. On a single computer (no sign-in) there is just the one saved key.
 */
export function apiKeyFor(userId: number | null | undefined): string {
  if (config.authMode !== "google") return process.env.ANTHROPIC_API_KEY || getSecretSetting("anthropic_api_key");
  if (!userId) return "";
  const row = get("SELECT anthropic_key FROM users WHERE id = ?", userId);
  return row?.anthropic_key ? open(String(row.anthropic_key)) : "";
}

export function claudeConfiguredFor(userId: number | null | undefined): boolean {
  return apiKeyFor(userId) !== "";
}

/** Saves (or, when empty, removes) a person's own key. Without a person (a single computer), it is the one saved key. */
export function setApiKeyFor(userId: number | null | undefined, key: string): void {
  const trimmed = key.trim();
  if (trimmed && !/^sk-ant-[A-Za-z0-9_-]{16,}$/.test(trimmed)) {
    throw new HttpError(400, "That doesn't look like an Anthropic API key. It starts with sk-ant- and is a single line, with no spaces.");
  }
  if (config.authMode !== "google") {
    setSecretSetting("anthropic_api_key", trimmed);
    return;
  }
  if (!userId) throw new HttpError(400, "Sign in with your own account to save a key.");
  run("UPDATE users SET anthropic_key = ? WHERE id = ?", trimmed ? seal(trimmed) : "", userId);
}

/**
 * From when one key was shared by everyone: the key moves to the person who saved it (the last person the activity log
 * shows saving one, or else the longest-standing administrator), and the shared copy is deleted. Runs at start; does
 * nothing once there is no shared key. Returns who it went to.
 */
export function moveSharedKeyToItsOwner(): string | null {
  if (config.authMode !== "google") return null;
  const shared = getSecretSetting("anthropic_api_key");
  if (!shared) return null;
  const saver = get("SELECT email FROM audit WHERE action = 'settings.change' AND detail LIKE '%apiKey%' ORDER BY id DESC LIMIT 1")?.email;
  const owner =
    (saver ? get("SELECT id, email, anthropic_key FROM users WHERE email = ? AND status = 'active'", String(saver)) : undefined) ??
    get("SELECT id, email, anthropic_key FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1");
  if (!owner) return null; // nobody to give it to yet: leave it until someone has signed in
  if (!owner.anthropic_key) run("UPDATE users SET anthropic_key = ? WHERE id = ?", seal(shared), owner.id);
  setSecretSetting("anthropic_api_key", "");
  run("INSERT INTO audit (at, user_id, email, action, detail) VALUES (?, NULL, 'system', 'claude.key-moved', ?)", new Date().toISOString(), `The shared Anthropic key now belongs to ${owner.email}; everyone uses their own.`);
  return String(owner.email);
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
export async function draft(req: DraftRequest, userId: number | null | undefined): Promise<string[]> {
  const key = apiKeyFor(userId);
  if (!key) {
    throw new HttpError(400, config.authMode === "google"
      ? "Add your own Anthropic API key to use Draft with Claude: click “Claude: add API key” at the top of the page."
      : "Add an Anthropic API key to use Draft with Claude: click “Claude: add API key” at the top of the page.");
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
    return new HttpError(401, "Anthropic rejected your API key. Click the Claude button at the top of the page to replace it.");
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

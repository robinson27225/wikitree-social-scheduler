import type { MediaKind } from "../media.ts";

export type { MediaKind };

export type Config = Record<string, string | number | boolean | undefined>;

export interface FieldSpec {
  name: string;
  label: string;
  type: "text" | "password" | "url" | "checkbox";
  placeholder?: string;
  help?: string;
  required?: boolean;
  /** Initial value. */
  default?: boolean | string;
}

export interface PublishInput {
  text: string;
  /** Used by platforms that have a separate title (Reddit, YouTube, TikTok photos). */
  title: string;
  altText: string;
  /** Absolute path of the image or video, or null for a text-only post. */
  mediaPath: string | null;
  mediaKind: MediaKind | null;
  /** Stable per-target key so a retry can't create a duplicate post (where supported). */
  idempotencyKey: string;
  /** YouTube: use the first frame of the video as its thumbnail. */
  thumbnailFromVideo?: boolean;
  /**
   * More pictures after the first (which is `mediaPath`, with `altText`). Only ever present for a post of pictures, and
   * already cut down to what this platform takes (see Provider.maxImages).
   */
  extraImages?: { path: string; altText: string }[];
}

/** Lets a provider save changed credentials (for example a refreshed token) back to its account. */
export interface ProviderContext {
  saveConfig(patch: Config): void;
}

/** What we keep so a platform-held scheduled post can be found, cancelled or matched later. */
export type RemoteRef = Record<string, string>;

export type RemoteState =
  | { state: "pending" }
  | { state: "published"; url?: string; id?: string }
  | { state: "gone" }; // no longer scheduled, and we couldn't find the published post

/** The numbers the Stats tab knows about. A platform fills in only the ones it reports. */
export type MetricKey =
  | "views"
  | "reach"
  | "viewers"
  | "engagements"
  | "interactions"
  | "link_clicks"
  | "visits"
  | "follows"
  | "shares"
  | "comments"
  | "likes"
  | "saves";

export interface PostStats {
  metrics: Partial<Record<MetricKey, number>>;
  /** Plain-English reasons some numbers are missing (for example a permission to add). Shown in the Stats tab. */
  notes: string[];
}

/** A post that is live on a platform, as far as asking about its numbers goes. */
export interface StatsTarget {
  /** The platform's own id for the post (what publishing returned). */
  externalId: string;
  url: string | null;
  postedAt: string;
}

export interface Provider {
  kind: string;
  label: string;
  /** Fields shown when adding an account by hand. OAuth platforms leave this empty. */
  fields: FieldSpec[];
  /** Config keys that hold secrets and must never be sent to the browser. */
  secretKeys?: string[];

  /** Verifies the credentials and returns the config to store (plus a human-readable detail). */
  connect(config: Config, ctx?: ProviderContext): Promise<{ config: Config; detail: string }>;
  textLimit(config: Config): number;
  countText(text: string, config: Config): number;

  /** How many pictures one post can carry here. Left out means one. A post with more has the extras dropped for this channel. */
  maxImages?(config: Config): number;

  /** null if this account can post that kind of media (or text only, when kind is null), else the reason it can't. */
  accepts(kind: MediaKind | null, config: Config): string | null;
  /** Optional deeper check of a specific file, run when the post is scheduled. null means fine. */
  validateMedia?(file: string, kind: MediaKind, config: Config): Promise<string | null>;

  /** The platform has a separate title: required (Reddit, YouTube) or optional. */
  needsTitle?: "required" | "optional";
  /** Like needsTitle, but decided per account (for example a manual account that is for Reddit). */
  needsTitleFor?(config: Config): "required" | "optional" | undefined;
  titleLimit?(config: Config): number;

  /**
   * Posts now. `note` is for a caveat worth showing even though it worked, such as a platform
   * quietly keeping an unaudited app's post private.
   */
  publish(config: Config, input: PublishInput, ctx?: ProviderContext): Promise<{ url: string; note?: string; id?: string }>;
  /** Runs now and then (about every 6 hours) so credentials that expire can be renewed. */
  maintain?(config: Config, ctx?: ProviderContext): Promise<void>;

  /**
   * Manual platforms have no API. At the scheduled time the app doesn't post: it tells you
   * and gets the text and image ready, and you mark it posted once you've done it.
   */
  manual?: { openUrl(config: Config, post?: { text: string; title: string }): string };

  /**
   * Optional: let the platform hold the schedule, so the post goes out even if this
   * computer is off. All of these must be implemented together.
   */
  supportsServerSchedule?(config: Config): boolean;
  /** How far ahead the platform accepts a scheduled post. Defaults to 6 minutes and no maximum. */
  serverScheduleWindow?(config: Config): { minMs: number; maxMs: number };
  scheduleOnServer?(config: Config, input: PublishInput, whenIso: string, ctx?: ProviderContext): Promise<RemoteRef>;
  /** Returns true if it was cancelled, false if it no longer existed. Throws on any other failure. */
  cancelOnServer?(config: Config, remote: RemoteRef, ctx?: ProviderContext): Promise<boolean>;
  checkOnServer?(config: Config, remote: RemoteRef, whenIso: string, ctx?: ProviderContext): Promise<RemoteState>;

  /**
   * Reads the numbers for one post that is already published. Only reads. Throws if the post can't be read at all
   * (deleted, no network); a number the platform won't give is left out, with a note saying why.
   */
  fetchStats?(config: Config, target: StatsTarget, ctx?: ProviderContext): Promise<PostStats>;
}

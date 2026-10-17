import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { prepareImage } from "../images.ts";
import { mastodonLength } from "../util.ts";
import type { Config, Provider, PublishInput, RemoteRef } from "./types.ts";
import { withTotals } from "./insights.ts";

const DEFAULT_CHARS = 500;
const DEFAULT_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_VIDEO_BYTES = 40 * 1024 * 1024;

function baseUrl(config: Config): string {
  let url = String(config.instance ?? "").trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, "");
}

async function api(config: Config, route: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.accessToken}`);
  return fetch(`${baseUrl(config)}${route}`, { ...init, headers });
}

async function failure(res: Response, what: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: string };
    detail = body.error ?? "";
  } catch {
    /* body wasn't JSON */
  }
  return new Error(`Mastodon ${what} failed (${res.status})${detail ? `: ${detail}` : ""}`);
}

/** Uploads the image (with alt text) and waits until Mastodon has finished processing it. */
async function uploadMedia(config: Config, input: PublishInput & { mediaPath: string }): Promise<string> {
  const form = new FormData();
  const isVideo = input.mediaKind === "video";
  if (isVideo) {
    // Streamed from disk, so a large video isn't read into memory.
    form.append("file", await openAsBlob(input.mediaPath), path.basename(input.mediaPath));
  } else {
    const image = await prepareImage(input.mediaPath, {
      maxBytes: Math.min(Number(config.imageBytes) || DEFAULT_IMAGE_BYTES, 8 * 1024 * 1024),
      maxEdge: 3000,
    });
    form.append(
      "file",
      new Blob([new Uint8Array(image.bytes)], { type: image.mime }),
      path.basename(input.mediaPath),
    );
  }
  if (input.altText) form.append("description", input.altText);

  const upload = await api(config, "/api/v2/media", { method: "POST", body: form });
  if (!upload.ok && upload.status !== 202) throw await failure(upload, "image upload");
  const media = (await upload.json()) as { id: string };

  // 202 means the server is still processing the image; wait until it is ready.
  if (upload.status === 202) {
    let ready = false;
    const attempts = isVideo ? 300 : 30; // videos can take minutes to process
    for (let i = 0; i < attempts && !ready; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const poll = await api(config, `/api/v1/media/${media.id}`);
      if (poll.status === 200) ready = true;
      else if (poll.status !== 206) throw await failure(poll, "image processing");
    }
    if (!ready) throw new Error(`Mastodon is still processing the ${isVideo ? "video" : "image"} after ${attempts}s`);
  }
  return media.id;
}

function statusBody(config: Config, input: PublishInput, mediaId: string | undefined, extra: object = {}) {
  return JSON.stringify({
    status: input.text,
    ...(mediaId ? { media_ids: [mediaId] } : {}),
    visibility: config.visibility || "public",
    ...extra,
  });
}

/** Newlines and surrounding space can differ between what we sent and what Mastodon stores. */
const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();

/** Uploads the image if the post has one. */
async function maybeUpload(config: Config, input: PublishInput): Promise<string | undefined> {
  return input.mediaPath ? uploadMedia(config, { ...input, mediaPath: input.mediaPath }) : undefined;
}

async function accountId(config: Config): Promise<string> {
  if (config.accountId) return String(config.accountId);
  const me = await api(config, "/api/v1/accounts/verify_credentials");
  if (!me.ok) throw await failure(me, "account lookup");
  return String(((await me.json()) as { id: string }).id);
}

export const mastodon: Provider = {
  kind: "mastodon",
  label: "Mastodon",
  fields: [
    {
      name: "instance",
      label: "Instance",
      type: "url",
      placeholder: "https://mastodon.social",
      required: true,
    },
    {
      name: "accessToken",
      label: "Access token",
      type: "password",
      help: "On your instance: Preferences > Development > New application. Tick read:accounts, read:statuses, write:media and write:statuses, then copy 'Your access token'. Create a separate application for this app so you can revoke it independently.",
      required: true,
    },
    {
      name: "nativeSchedule",
      label: "Let Mastodon hold the schedule",
      type: "checkbox",
      default: true,
      help: "Posts go out on time even if this Mac is off or the app is closed. Mastodon requires at least 5 minutes' notice, so posts scheduled sooner are sent by this app instead.",
    },
  ],

  async connect(config) {
    const me = await api(config, "/api/v1/accounts/verify_credentials");
    if (!me.ok) throw await failure(me, "sign-in check");
    const account = (await me.json()) as { id: string; acct: string };

    // Limits differ per instance; ask the server rather than assuming.
    let maxChars = DEFAULT_CHARS;
    let imageBytes = DEFAULT_IMAGE_BYTES;
    let videoBytes = DEFAULT_VIDEO_BYTES;
    const instance = await api(config, "/api/v2/instance");
    if (instance.ok) {
      const info = (await instance.json()) as any;
      maxChars = info?.configuration?.statuses?.max_characters ?? maxChars;
      imageBytes = info?.configuration?.media_attachments?.image_size_limit ?? imageBytes;
      videoBytes = info?.configuration?.media_attachments?.video_size_limit ?? videoBytes;
    }

    const nativeSchedule = config.nativeSchedule !== false && config.nativeSchedule !== "false";
    if (nativeSchedule) {
      // Fail now, not at post time, if the token can't manage scheduled posts.
      const probe = await api(config, "/api/v1/scheduled_statuses?limit=1");
      if (!probe.ok) {
        throw new Error(
          `This token can't manage scheduled posts (${probe.status}). Create a new application with the read:statuses and write:statuses scopes, or untick "Let Mastodon hold the schedule".`,
        );
      }
    }
    return {
      config: { ...config, instance: baseUrl(config), accountId: account.id, maxChars, imageBytes, videoBytes, nativeSchedule },
      detail:
        `Signed in as @${account.acct} (limit ${maxChars} characters)` +
        (nativeSchedule ? ". Mastodon will hold the schedule." : ". This app will post at the scheduled time."),
    };
  },

  textLimit: (config) => Number(config.maxChars) || DEFAULT_CHARS,
  countText: (text) => mastodonLength(text),
  accepts: () => null,
  async validateMedia(file, kind, config) {
    if (kind !== "video") return null;
    const limit = Number(config.videoBytes) || DEFAULT_VIDEO_BYTES;
    const size = (await fs.stat(file)).size;
    return size > limit
      ? `This video is ${(size / 1048576).toFixed(0)} MB but ${baseUrl(config)} only accepts ${(limit / 1048576).toFixed(0)} MB.`
      : null;
  },

  async publish(config, input) {
    const mediaId = await maybeUpload(config, input);
    const status = await api(config, "/api/v1/statuses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
      body: statusBody(config, input, mediaId),
    });
    if (!status.ok) throw await failure(status, "post");
    const posted = (await status.json()) as { url: string; id?: string };
    return { url: posted.url, id: posted.id };
  },

  supportsServerSchedule: (config) => config.nativeSchedule !== false && config.nativeSchedule !== "false",

  async scheduleOnServer(config, input, whenIso) {
    const mediaId = await maybeUpload(config, input);
    const res = await api(config, "/api/v1/statuses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
      body: statusBody(config, input, mediaId, { scheduled_at: whenIso }),
    });
    if (!res.ok) throw await failure(res, "scheduling");
    const scheduled = (await res.json()) as { id: string; scheduled_at?: string };
    // Without scheduled_at in the reply, Mastodon posted it immediately instead of scheduling it.
    if (!scheduled.scheduled_at) {
      throw new Error("Mastodon published the post immediately instead of scheduling it. Check the account.");
    }
    // Remember how to recognise the published post: by its image if it has one, otherwise by its text.
    const ref: RemoteRef = { id: scheduled.id };
    if (mediaId) ref.mediaId = mediaId;
    else ref.text = input.text;
    return ref;
  },

  async cancelOnServer(config, remote: RemoteRef) {
    const res = await api(config, `/api/v1/scheduled_statuses/${remote.id}`, { method: "DELETE" });
    if (res.status === 404) return false;
    if (!res.ok) throw await failure(res, "cancelling the scheduled post");
    return true;
  },

  async checkOnServer(config, remote: RemoteRef, whenIso) {
    const res = await api(config, `/api/v1/scheduled_statuses/${remote.id}`);
    if (res.ok) return { state: "pending" };
    if (res.status !== 404) throw await failure(res, "checking the scheduled post");

    // It's gone from the schedule: normally because Mastodon published it. Find the real post
    // by the image we attached (the published post reuses the same media id).
    const id = await accountId(config);
    const list = await api(config, `/api/v1/accounts/${id}/statuses?limit=40`);
    if (!list.ok) throw await failure(list, "looking for the published post");
    const statuses = (await list.json()) as {
      id: string;
      url: string;
      created_at: string;
      media_attachments: { id: string }[];
    }[];

    let match = remote.mediaId
      ? statuses.find((s) => s.media_attachments?.some((m) => m.id === remote.mediaId))
      : undefined;
    if (!match && !remote.mediaId && remote.text) {
      // Text-only post: look at posts made around the scheduled time and compare the original text.
      const from = Date.parse(whenIso) - 60_000;
      const to = Date.parse(whenIso) + 15 * 60_000;
      const candidates = statuses
        .filter((s) => Date.parse(s.created_at) >= from && Date.parse(s.created_at) <= to)
        .slice(0, 5);
      for (const candidate of candidates) {
        const source = await api(config, `/api/v1/statuses/${candidate.id}/source`);
        if (!source.ok) continue;
        const { text } = (await source.json()) as { text?: string };
        if (text !== undefined && normalize(text) === normalize(remote.text)) {
          match = candidate;
          break;
        }
      }
    }
    const lateBy = Date.now() - Date.parse(whenIso);
    if (match) return { state: "published", url: match.url, id: match.id };
    // Right after the due time the post may not be listed yet; only call it gone once it's had a while.
    return lateBy < 3 * 60_000 ? { state: "pending" } : { state: "gone" };
  },

  async fetchStats(config, target) {
    const res = await api(config, `/api/v1/statuses/${encodeURIComponent(target.externalId)}`);
    if (!res.ok) throw await failure(res, "reading the post's counts");
    const status = (await res.json()) as { favourites_count?: number; reblogs_count?: number; replies_count?: number };
    return {
      metrics: withTotals({ likes: status.favourites_count ?? 0, shares: status.reblogs_count ?? 0, comments: status.replies_count ?? 0 }),
      notes: [],
    };
  },
};

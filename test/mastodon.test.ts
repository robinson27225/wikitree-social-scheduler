import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";

process.env.SOCIAL_SCHEDULER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mastodon-test-"));
const { mastodon } = await import("../src/providers/mastodon.ts");

interface Seen {
  method: string;
  url: string;
  auth?: string;
  idempotency?: string;
  body: Buffer;
}

describe("mastodon provider (against a fake server)", () => {
  const seen: Seen[] = [];
  let polls = 0;
  let scheduledGone = false;
  let publishedStatuses: unknown[] = [];
  let sources: Record<string, string> = {};
  let server: http.Server;
  let instance: string;
  let image: string;

  before(async () => {
    image = path.join(process.env.SOCIAL_SCHEDULER_DATA!, "pic.jpg");
    await sharp({ create: { width: 600, height: 400, channels: 3, background: "#25508a" } }).jpeg().toFile(image);

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const entry: Seen = {
          method: req.method!,
          url: req.url!,
          auth: req.headers.authorization,
          idempotency: req.headers["idempotency-key"] as string | undefined,
          body: Buffer.concat(chunks),
        };
        seen.push(entry);
        const json = (status: number, body: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (entry.auth !== "Bearer good-token" && entry.auth !== "Bearer no-read-scope") {
          return json(401, { error: "The access token is invalid" });
        }
        // A token without read:statuses can't list or manage scheduled posts.
        if (entry.auth === "Bearer no-read-scope" && req.url!.startsWith("/api/v1/scheduled_statuses")) {
          return json(403, { error: "This action is outside the authorized scopes" });
        }
        if (req.url === "/api/v1/accounts/verify_credentials") return json(200, { id: "42", acct: "wikitree" });
        if (req.url === "/api/v1/scheduled_statuses?limit=1") return json(200, []);
        if (req.url === "/api/v1/scheduled_statuses/s1") {
          if (req.method === "DELETE") {
            if (scheduledGone) return json(404, { error: "Record not found" });
            scheduledGone = true;
            return json(200, {});
          }
          return scheduledGone ? json(404, { error: "Record not found" }) : json(200, { id: "s1" });
        }
        if (req.url === "/api/v1/accounts/42/statuses?limit=40") {
          return json(200, publishedStatuses);
        }
        const sourceMatch = req.url!.match(/^\/api\/v1\/statuses\/([^/]+)\/source$/);
        if (sourceMatch) {
          return sourceMatch[1] in sources ? json(200, { text: sources[sourceMatch[1]] }) : json(404, { error: "nope" });
        }
        if (req.url === "/api/v2/instance") {
          return json(200, {
            configuration: { statuses: { max_characters: 1000 }, media_attachments: { image_size_limit: 5_000_000 } },
          });
        }
        if (req.url === "/api/v2/media") return json(202, { id: "m1" }); // still processing
        if (req.url === "/api/v1/media/m1") return json(++polls < 2 ? 206 : 200, { id: "m1" });
        if (req.url === "/api/v1/statuses") {
          const sent = JSON.parse(entry.body.toString());
          if (sent.scheduled_at) {
            return json(200, { id: "s1", scheduled_at: sent.scheduled_at, media_attachments: [{ id: "m1" }] });
          }
          return json(200, { url: "https://example.social/@wikitree/1" });
        }
        json(404, { error: "not found" });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    instance = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
    fs.rmSync(process.env.SOCIAL_SCHEDULER_DATA!, { recursive: true, force: true });
  });

  it("connects and learns the instance's real limits", async () => {
    const { config, detail } = await mastodon.connect({ instance, accessToken: "good-token" });
    assert.equal(config.maxChars, 1000);
    assert.equal(mastodon.textLimit(config), 1000);
    assert.match(detail, /@wikitree/);
  });

  it("reports a bad token clearly", async () => {
    await assert.rejects(
      () => mastodon.connect({ instance, accessToken: "nope" }),
      /sign-in check failed \(401\).*access token is invalid/,
    );
  });

  it("uploads every picture with its own description and attaches them all to one post", async () => {
    seen.length = 0;
    await mastodon.publish(
      { instance, accessToken: "good-token", maxChars: 1000 },
      {
        text: "Two pictures",
        altText: "First one",
        mediaPath: image,
        title: "",
        mediaKind: "image",
        idempotencyKey: "key-multi",
        extraImages: [{ path: image, altText: "Second one" }],
      },
    );
    const uploads = seen.filter((s) => s.url === "/api/v2/media");
    assert.equal(uploads.length, 2);
    assert.ok(uploads[0].body.toString("latin1").includes("First one"));
    assert.ok(uploads[1].body.toString("latin1").includes("Second one"));
    const sent = JSON.parse(seen.filter((s) => s.url === "/api/v1/statuses")[0].body.toString());
    assert.equal(sent.media_ids.length, 2);
  });

  it("uploads with alt text, waits for processing, then posts once with an idempotency key", async () => {
    seen.length = 0;
    const result = await mastodon.publish(
      { instance, accessToken: "good-token", maxChars: 1000 },
      { text: "Hello fediverse", altText: "A blue card", mediaPath: image, title: "", mediaKind: "image", idempotencyKey: "key-123" },
    );
    assert.equal(result.url, "https://example.social/@wikitree/1");

    const upload = seen.find((s) => s.url === "/api/v2/media")!;
    assert.ok(upload.body.toString("latin1").includes('name="description"'));
    assert.ok(upload.body.toString("latin1").includes("A blue card"));

    assert.ok(polls >= 2, "should have polled until the image was ready");
    const posts = seen.filter((s) => s.url === "/api/v1/statuses");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].idempotency, "key-123");
    assert.deepEqual(JSON.parse(posts[0].body.toString()), {
      status: "Hello fediverse",
      media_ids: ["m1"],
      visibility: "public",
    });
  });
  it("explains up front when the token can't manage scheduled posts", async () => {
    await assert.rejects(
      () => mastodon.connect({ instance, accessToken: "no-read-scope" }),
      /can't manage scheduled posts.*read:statuses/,
    );
    // ...but is fine if the person turns platform scheduling off.
    const { config } = await mastodon.connect({ instance, accessToken: "no-read-scope", nativeSchedule: false });
    assert.equal(mastodon.supportsServerSchedule!(config), false);
  });

  it("schedules on the server with scheduled_at, then finds the published post by its image", async () => {
    seen.length = 0;
    scheduledGone = false;
    const config = { instance, accessToken: "good-token", accountId: "42", nativeSchedule: true };
    const when = new Date(Date.now() + 3 * 3600_000).toISOString();

    assert.equal(mastodon.supportsServerSchedule!(config), true);
    const remote = await mastodon.scheduleOnServer!(
      config,
      { text: "Later!", altText: "A blue card", mediaPath: image, title: "", mediaKind: "image", idempotencyKey: "sched-1" },
      when,
    );
    assert.deepEqual(remote, { id: "s1", mediaId: "m1" });
    const post = seen.find((s) => s.url === "/api/v1/statuses")!;
    assert.deepEqual(JSON.parse(post.body.toString()), {
      status: "Later!",
      media_ids: ["m1"],
      visibility: "public",
      scheduled_at: when,
    });

    assert.deepEqual(await mastodon.checkOnServer!(config, remote, when), { state: "pending" });

    // Mastodon publishes it: the scheduled entry disappears and a real post appears with the same image.
    scheduledGone = true;
    publishedStatuses = [
      { id: "s-other", url: "https://example.social/@wikitree/other", created_at: when, media_attachments: [{ id: "zzz" }] },
      { id: "s-99", url: "https://example.social/@wikitree/99", created_at: when, media_attachments: [{ id: "m1" }] },
    ];
    assert.deepEqual(await mastodon.checkOnServer!(config, remote, new Date(Date.now() - 3600_000).toISOString()), {
      state: "published",
      url: "https://example.social/@wikitree/99",
      id: "s-99",
    });
  });

  it("reports a vanished scheduled post as gone only after giving Mastodon a few minutes", async () => {
    scheduledGone = true;
    publishedStatuses = [];
    const config = { instance, accessToken: "good-token", accountId: "42", nativeSchedule: true };
    const remote = { id: "s1", mediaId: "m1" };
    const justNow = new Date(Date.now() - 30_000).toISOString();
    const longAgo = new Date(Date.now() - 3600_000).toISOString();
    assert.deepEqual(await mastodon.checkOnServer!(config, remote, justNow), { state: "pending" });
    assert.deepEqual(await mastodon.checkOnServer!(config, remote, longAgo), { state: "gone" });
  });

  it("cancels a scheduled post, and says so when it was already gone", async () => {
    scheduledGone = false;
    const config = { instance, accessToken: "good-token", nativeSchedule: true };
    assert.equal(await mastodon.cancelOnServer!(config, { id: "s1", mediaId: "m1" }), true);
    assert.equal(await mastodon.cancelOnServer!(config, { id: "s1", mediaId: "m1" }), false);
  });
  it("posts text-only without touching the media endpoint", async () => {
    seen.length = 0;
    const config = { instance, accessToken: "good-token", accountId: "42" };
    const result = await mastodon.publish(config, {
      text: "Just words",
      altText: "",
      mediaPath: null, title: "", mediaKind: null,
      idempotencyKey: "k-text",
    });
    assert.equal(result.url, "https://example.social/@wikitree/1");
    assert.equal(seen.filter((s) => s.url.includes("/media")).length, 0);
    const post = seen.find((s) => s.url === "/api/v1/statuses")!;
    assert.deepEqual(JSON.parse(post.body.toString()), { status: "Just words", visibility: "public" });
  });

  it("schedules a text-only post on the server and recognises it afterwards by its text", async () => {
    seen.length = 0;
    scheduledGone = false;
    const config = { instance, accessToken: "good-token", accountId: "42", nativeSchedule: true };
    const when = new Date(Date.now() - 5 * 60_000).toISOString(); // pretend it was due 5 minutes ago
    const remote = await mastodon.scheduleOnServer!(
      config,
      { text: "Line one\nLine two", altText: "", mediaPath: null, title: "", mediaKind: null, idempotencyKey: "k-sched-text" },
      when,
    );
    assert.deepEqual(remote, { id: "s1", text: "Line one\nLine two" });
    const body = JSON.parse(seen.find((s) => s.url === "/api/v1/statuses")!.body.toString());
    assert.equal(body.media_ids, undefined);
    assert.equal(body.scheduled_at, when);
    assert.equal(seen.filter((s) => s.url.includes("/media")).length, 0);

    // Published: the scheduled entry is gone and several recent posts exist. Only one has our text.
    scheduledGone = true;
    const at = (minutesFromDue: number) => new Date(Date.parse(when) + minutesFromDue * 60_000).toISOString();
    publishedStatuses = [
      { id: "a", url: "https://example.social/@wikitree/a", created_at: at(1), media_attachments: [] },
      { id: "b", url: "https://example.social/@wikitree/b", created_at: at(2), media_attachments: [] },
      { id: "c", url: "https://example.social/@wikitree/c", created_at: at(-120), media_attachments: [] },
    ];
    sources = { a: "Something else entirely", b: "Line one\r\nLine two ", c: "Line one\nLine two" };
    assert.deepEqual(await mastodon.checkOnServer!(config, remote, when), {
      state: "published",
      url: "https://example.social/@wikitree/b",
      id: "b",
    });
  });

  it("does not match a text-only post to look-alikes outside the time window or with different text", async () => {
    scheduledGone = true;
    const config = { instance, accessToken: "good-token", accountId: "42", nativeSchedule: true };
    const when = new Date(Date.now() - 60 * 60_000).toISOString();
    const remote = { id: "s1", text: "Exactly this" };
    publishedStatuses = [
      { id: "far", url: "u1", created_at: new Date(Date.parse(when) - 3 * 3600_000).toISOString(), media_attachments: [] },
      { id: "near", url: "u2", created_at: new Date(Date.parse(when) + 60_000).toISOString(), media_attachments: [] },
    ];
    sources = { far: "Exactly this", near: "Exactly this, but different" };
    assert.deepEqual(await mastodon.checkOnServer!(config, remote, when), { state: "gone" });
  });
});

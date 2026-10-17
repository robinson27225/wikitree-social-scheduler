import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import { startFake, type Fake } from "./fake.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meta-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { facebook } = await import("../src/providers/facebook.ts");
const { instagram } = await import("../src/providers/instagram.ts");
const { threads, threadsLength } = await import("../src/providers/threads.ts");
const { saveHostConfig } = await import("../src/publicHost.ts");

const square = path.join(dir, "square.png");
const wide = path.join(dir, "wide.jpg");
const video = path.join(dir, "clip.mp4");
const input = (over: Record<string, unknown> = {}) => ({
  text: "Hello world",
  title: "",
  altText: "",
  mediaPath: null as string | null,
  mediaKind: null as "image" | "video" | null,
  idempotencyKey: "k",
  ...over,
});

before(async () => {
  await sharp({ create: { width: 1080, height: 1080, channels: 3, background: "#2f6f4f" } }).png().toFile(square);
  await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#25508a" } }).jpeg().toFile(wide);
  fs.writeFileSync(video, Buffer.alloc(50_000, 1));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("Facebook Page", () => {
  let fb: Fake;
  let published = false;
  const config = () => ({ graphBase: fb.base, pageId: "PAGE", pageToken: "page-token" });

  before(async () => {
    fb = await startFake((req) => {
      if (req.path === "/PAGE" && req.method === "GET") return { json: { name: "WikiTree Official" } };
      if (req.path === "/PAGE/feed") return { json: { id: "PAGE_text1" } };
      if (req.path === "/PAGE/photos") {
        // an unpublished (to be scheduled) photo gets no post yet, only its own id
        return { json: req.text().includes("temporary") ? { id: "photo1" } : { id: "photo1", post_id: "PAGE_photo1" } };
      }
      if (req.path === "/photo1" && req.url.includes("is_published")) {
        // the real thing: a Photo has no such field
        return { status: 400, json: { error: { message: "(#100) Tried accessing nonexisting field (is_published) on node type (Photo)", code: 100 } } };
      }
      if (req.path === "/PAGE/videos") return { json: { id: "video1" } };
      if (req.path.endsWith("_text1") || req.path.endsWith("_photo1") || req.path === "/video1") {
        return { json: { permalink_url: "/WikiTreeOfficial/posts/123" } };
      }
      if (req.path === "/sched1") {
        if (req.method === "DELETE") return { json: { success: true } };
        return { json: { is_published: published, permalink_url: "https://www.facebook.com/WikiTreeOfficial/posts/999" } };
      }
      if (req.path === "/gone1") {
        return { status: 400, json: { error: { message: "Object does not exist", code: 100, error_subcode: 33 } } };
      }
      if (req.path === "/unreadable1") {
        return {
          status: 400,
          json: {
            error: {
              message:
                "(#10) Object does not exist, cannot be loaded due to missing permission or reviewable feature, or the object requires the 'pages_read_engagement' permission",
              code: 10,
            },
          },
        };
      }
      return { status: 404, json: { error: { message: "no route" } } };
    });
  });
  after(() => fb.close());

  it("checks the Page token on connect", async () => {
    const { detail } = await facebook.connect(config());
    assert.match(detail, /WikiTree Official/);
    assert.equal(fb.requests[0].url.includes("access_token=page-token"), true);
  });

  it("posts text with the first link as a preview, and returns the permalink", async () => {
    fb.requests.length = 0;
    const result = await facebook.publish(config(), input({ text: "Read this: https://www.wikitree.com/wiki/Help:Apps. Thanks" }));
    assert.equal(result.url, "https://www.facebook.com/WikiTreeOfficial/posts/123");
    assert.equal(result.id, "PAGE_text1", "the platform's own post id is returned");
    const body = fb.to("/PAGE/feed")[0].form();
    assert.equal(body.get("message"), "Read this: https://www.wikitree.com/wiki/Help:Apps. Thanks");
    assert.equal(body.get("link"), "https://www.wikitree.com/wiki/Help:Apps");
    assert.equal(body.get("access_token"), "page-token");
    assert.equal(body.get("published"), null);
  });

  it("uploads a photo with its caption and alt text", async () => {
    fb.requests.length = 0;
    await facebook.publish(config(), input({ mediaPath: square, mediaKind: "image", altText: "A green square" }));
    const text = fb.to("/PAGE/photos")[0].text();
    assert.ok(text.includes('name="source"') && text.includes('name="caption"') && text.includes("Hello world"));
    assert.ok(text.includes('name="alt_text_custom"') && text.includes("A green square"));
  });

  it("uploads a video with a title", async () => {
    fb.requests.length = 0;
    const result = await facebook.publish(config(), input({ mediaPath: video, mediaKind: "video", title: "My clip" }));
    const text = fb.to("/PAGE/videos")[0].text();
    assert.ok(text.includes('name="title"') && text.includes("My clip") && text.includes('name="description"'));
    assert.match(result.url, /facebook\.com/);
  });

  it("lets Facebook hold the schedule, within Facebook's 10 minute to 30 day window", async () => {
    fb.requests.length = 0;
    assert.equal(facebook.supportsServerSchedule!(config()), true);
    const window = facebook.serverScheduleWindow!(config());
    assert.ok(window.minMs >= 10 * 60_000 && window.maxMs <= 30 * 24 * 3_600_000);

    const when = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const ref = await facebook.scheduleOnServer!(config(), input({ mediaPath: square, mediaKind: "image", altText: "A green square" }), when);
    // a scheduled photo is a post (which can be asked whether it's published), not a bare Photo (which can't)
    assert.deepEqual(ref, { id: "PAGE_text1", kind: "post" });

    const upload = fb.to("/PAGE/photos")[0].text();
    assert.ok(upload.includes('name="published"') && upload.includes("false") && upload.includes('name="temporary"'));
    assert.ok(upload.includes("A green square"));
    assert.ok(!upload.includes('name="scheduled_publish_time"'), "the schedule is on the post, not the photo");

    const post = fb.to("/PAGE/feed")[0].form();
    assert.equal(post.get("message"), "Hello world");
    assert.equal(post.get("attached_media[0]"), JSON.stringify({ media_fbid: "photo1" }));
    assert.equal(post.get("published"), "false");
    assert.equal(post.get("unpublished_content_type"), "SCHEDULED");
    assert.equal(post.get("scheduled_publish_time"), String(Math.floor(Date.parse(when) / 1000)));
  });

  it("does not mistake a question Facebook can't answer for a deleted post", async () => {
    // posts scheduled by older versions kept a bare Photo id; asking a Photo "is_published" is an error, not "gone"
    assert.deepEqual(await facebook.checkOnServer!(config(), { id: "photo1", kind: "photo" }, ""), { state: "pending" });
  });

  it("tells pending from published from gone, and cancels", async () => {
    published = false;
    assert.deepEqual(await facebook.checkOnServer!(config(), { id: "sched1", kind: "photo" }, ""), { state: "pending" });
    published = true;
    assert.deepEqual(await facebook.checkOnServer!(config(), { id: "sched1", kind: "photo" }, ""), {
      state: "published",
      url: "https://www.facebook.com/WikiTreeOfficial/posts/999",
      id: "sched1",
    });
    assert.deepEqual(await facebook.checkOnServer!(config(), { id: "gone1", kind: "post" }, ""), { state: "gone" });
    assert.equal(await facebook.cancelOnServer!(config(), { id: "sched1", kind: "post" }), true);
    assert.equal(await facebook.cancelOnServer!(config(), { id: "gone1", kind: "post" }), false);
  });

  it("treats Facebook's (#10) 'object does not exist' answer as a missing post, so Retry isn't stuck", async () => {
    assert.deepEqual(await facebook.checkOnServer!(config(), { id: "unreadable1", kind: "post" }, ""), { state: "gone" });
  });

  it("reports Facebook's own error message when a post is refused", async () => {
    const bad = await startFake(() => ({ status: 400, json: { error: { message: "(#200) Requires pages_manage_posts permission" } } }));
    try {
      await assert.rejects(
        () => facebook.publish({ graphBase: bad.base, pageId: "P", pageToken: "t" }, input()),
        /Facebook post failed \(400\): \(#200\) Requires pages_manage_posts permission/,
      );
    } finally {
      bad.close();
    }
  });
});

describe("Instagram", () => {
  let graph: Fake;
  let s3: Fake;
  const objects = new Map<string, Buffer>();
  const config = () => ({ graphBase: graph.base, igUserId: "IG", pageToken: "page-token", username: "wikitreers" });

  before(async () => {
    s3 = await startFake((req) => {
      if (req.method === "PUT") {
        objects.set(req.path, req.body);
        return { raw: "", headers: { ETag: '"x"' } };
      }
      if (req.method === "DELETE") {
        objects.delete(req.path);
        return { status: 204 };
      }
      return { status: 404 };
    });
    saveHostConfig({
      endpoint: s3.base,
      region: "auto",
      bucket: "media",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      publicBaseUrl: "https://media.example.com",
    });
    graph = await startFake((req) => {
      if (req.path === "/IG" && req.method === "GET") return { json: { username: "wikitreers" } };
      if (req.path === "/IG/media") return { json: { id: "container1" } };
      if (req.path === "/container1") return { json: { status_code: "FINISHED" } };
      if (req.path === "/IG/media_publish") return { json: { id: "media1" } };
      if (req.path === "/media1") return { json: { permalink: "https://www.instagram.com/p/ABC/" } };
      return { status: 404, json: { error: { message: "no route" } } };
    });
  });
  after(() => {
    graph.close();
    s3.close();
  });

  it("refuses text-only posts, and images outside Instagram's shape limits", async () => {
    assert.match(instagram.accepts(null, config())!, /image or a video/);
    assert.equal(instagram.accepts("image", config()), null);
    assert.equal(await instagram.validateMedia!(square, "image", config()), null);
    assert.match((await instagram.validateMedia!(wide, "image", config()))!, /between 4:5 and 1\.91:1.*3000x1000/);
  });

  it("converts to JPEG, hosts it publicly just for the moment, posts it, and cleans up", async () => {
    graph.requests.length = 0;
    const result = await instagram.publish(config(), input({ mediaPath: square, mediaKind: "image", altText: "A green square", text: "Caption #wikitree" }));
    assert.equal(result.url, "https://www.instagram.com/p/ABC/");

    const create = graph.to("/IG/media")[0].form();
    assert.match(create.get("image_url")!, /^https:\/\/media\.example\.com\/social-scheduler\/[0-9a-f-]+\.jpg$/);
    assert.equal(create.get("caption"), "Caption #wikitree");
    assert.equal(create.get("alt_text"), "A green square");
    assert.equal(create.get("access_token"), "page-token");
    assert.equal(graph.to("/IG/media_publish")[0].form().get("creation_id"), "container1");
    assert.equal(objects.size, 0, "the hosted copy should be deleted afterwards");
  });

  it("posts a video as a Reel", async () => {
    graph.requests.length = 0;
    await instagram.publish(config(), input({ mediaPath: video, mediaKind: "video" }));
    const create = graph.to("/IG/media")[0].form();
    assert.equal(create.get("media_type"), "REELS");
    assert.match(create.get("video_url")!, /\.mp4$/);
    assert.equal(objects.size, 0);
  });

  it("says when Instagram can't process the media", async () => {
    const failing = await startFake((req) => {
      if (req.path === "/IG/media") return { json: { id: "c" } };
      if (req.path === "/c") return { json: { status_code: "ERROR", status: "Aspect ratio not supported" } };
      return { status: 404 };
    });
    try {
      await assert.rejects(
        () => instagram.publish({ ...config(), graphBase: failing.base }, input({ mediaPath: square, mediaKind: "image" })),
        /couldn't process the media \(Aspect ratio not supported\)/,
      );
      assert.equal(objects.size, 0, "even a failed post must not leave the hosted file behind");
    } finally {
      failing.close();
    }
  });
});

describe("Threads", () => {
  let api: Fake;
  let refresh: Fake;
  let s3: Fake;
  const objects = new Map<string, Buffer>();
  const config = (over: Record<string, unknown> = {}) => ({
    threadsBase: api.base,
    threadsRefreshBase: refresh.base,
    threadsUserId: "U1",
    username: "wikitree",
    accessToken: "old-token",
    ...over,
  });

  before(async () => {
    s3 = await startFake((req) => {
      if (req.method === "PUT") objects.set(req.path, req.body);
      if (req.method === "DELETE") objects.delete(req.path);
      return { status: req.method === "DELETE" ? 204 : 200, headers: { ETag: '"x"' } };
    });
    saveHostConfig({ endpoint: s3.base, bucket: "media", accessKeyId: "A", secretAccessKey: "s", publicBaseUrl: "https://media.example.com" });
    api = await startFake((req) => {
      if (req.path === "/me") return { json: { username: "wikitree" } };
      if (req.path === "/U1/threads") return { json: { id: "cont1" } };
      if (req.path === "/cont1") return { json: { status: "FINISHED" } };
      if (req.path === "/U1/threads_publish") return { json: { id: "post1" } };
      if (req.path === "/post1") return { json: { permalink: "https://www.threads.net/@wikitree/post/abc" } };
      return { status: 404, json: { error: { message: "no route" } } };
    });
    refresh = await startFake(() => ({ json: { access_token: "new-token", expires_in: 5_184_000 } }));
  });
  after(() => {
    api.close();
    refresh.close();
    s3.close();
  });

  it("counts emoji as 4 toward the 500 limit, like Threads does", () => {
    assert.equal(threadsLength("abc"), 3);
    assert.equal(threadsLength("hi 😀"), 3 + 4);
    assert.equal(threads.textLimit({}), 500);
  });

  it("posts text", async () => {
    api.requests.length = 0;
    const result = await threads.publish(config(), input({ text: "Hello Threads" }));
    assert.equal(result.url, "https://www.threads.net/@wikitree/post/abc");
    const create = api.to("/U1/threads")[0].form();
    assert.equal(create.get("media_type"), "TEXT");
    assert.equal(create.get("text"), "Hello Threads");
    assert.equal(api.to("/U1/threads_publish")[0].form().get("creation_id"), "cont1");
  });

  it("posts an image through the image host, with alt text, and cleans up", async () => {
    api.requests.length = 0;
    await threads.publish(config(), input({ mediaPath: square, mediaKind: "image", altText: "Alt" }));
    const create = api.to("/U1/threads")[0].form();
    assert.equal(create.get("media_type"), "IMAGE");
    assert.match(create.get("image_url")!, /^https:\/\/media\.example\.com\/social-scheduler\/.+\.jpg$/);
    assert.equal(create.get("alt_text"), "Alt");
    assert.equal(objects.size, 0);
  });

  it("renews a token that is about to expire, saves it, and uses the new one", async () => {
    api.requests.length = 0;
    const saved: Record<string, unknown>[] = [];
    await threads.publish(
      config({ tokenExpiresAt: new Date(Date.now() + 2 * 24 * 3_600_000).toISOString() }),
      input(),
      { saveConfig: (patch) => saved.push(patch) },
    );
    assert.equal(saved.length, 1);
    assert.equal(saved[0].accessToken, "new-token");
    assert.equal(api.to("/U1/threads")[0].form().get("access_token"), "new-token");
  });

  it("renews in the background only when it is due", async () => {
    const saved: Record<string, unknown>[] = [];
    const ctx = { saveConfig: (patch: Record<string, unknown>) => saved.push(patch) };
    const day = 24 * 3_600_000;
    await threads.maintain!(config({ tokenRefreshedAt: new Date(Date.now() - 2 * day).toISOString(), tokenExpiresAt: new Date(Date.now() + 58 * day).toISOString() }), ctx);
    assert.equal(saved.length, 0, "a fresh token should be left alone");
    await threads.maintain!(config({ tokenRefreshedAt: new Date(Date.now() - 40 * day).toISOString(), tokenExpiresAt: new Date(Date.now() + 20 * day).toISOString() }), ctx);
    assert.equal(saved.length, 1);
    assert.ok(Date.parse(String(saved[0].tokenExpiresAt)) > Date.now() + 50 * day);
  });
});

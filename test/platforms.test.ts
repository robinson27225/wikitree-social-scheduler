import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import { startFake, type Fake } from "./fake.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platforms-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { x, xLength } = await import("../src/providers/x.ts");
const { youtube } = await import("../src/providers/youtube.ts");
const { tiktok } = await import("../src/providers/tiktok.ts");
const { reddit } = await import("../src/providers/reddit.ts");
const { manual } = await import("../src/providers/manual.ts");
const { saveHostConfig } = await import("../src/publicHost.ts");

const image = path.join(dir, "pic.png");
const bigVideo = path.join(dir, "big.mp4");
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
  await sharp({ create: { width: 800, height: 800, channels: 3, background: "#2f6f4f" } }).png().toFile(image);
  fs.writeFileSync(bigVideo, Buffer.alloc(25_000_000, 3));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("X", () => {
  let api: Fake;
  let altStatus = 200;
  const config = () => ({
    apiBase: api.base,
    consumerKey: "ck",
    consumerSecret: "cs",
    token: "tok",
    tokenSecret: "ts",
    username: "WikiTreers",
  });

  before(async () => {
    api = await startFake((req) => {
      if (req.path === "/2/users/me") return { json: { data: { username: "WikiTreers", id: "42", subscription_type: "None" } } };
      if (req.path === "/2/media/upload" && req.method === "POST") return { json: { data: { id: "IMG1" } } };
      if (req.path === "/2/media/metadata") return { status: altStatus, json: altStatus === 200 ? {} : { detail: "nope" } };
      if (req.path === "/2/media/upload/initialize") return { json: { data: { id: "VID1" } } };
      if (req.path === "/2/media/upload/VID1/append") return { status: 204, raw: "" };
      if (req.path === "/2/media/upload/VID1/finalize") return { json: { data: { id: "VID1", processing_info: { state: "pending" } } } };
      if (req.path === "/2/media/upload" && req.method === "GET") return { json: { data: { processing_info: { state: "succeeded" } } } };
      if (req.path === "/2/tweets") return { status: 201, json: { data: { id: "TWEET1" } } };
      return { status: 404, json: { detail: "no route" } };
    });
  });
  after(() => api.close());

  it("counts links as 23 and emoji as 2, like X does", () => {
    assert.equal(xLength("hello"), 5);
    assert.equal(xLength("see https://www.wikitree.com/genealogy/SMITH/very/long/path now"), 4 + 23 + 4); // "see " + link + " now"
    assert.equal(xLength("hi 😀"), 3 + 2);
    assert.equal(xLength("日本"), 4);
  });

  it("signs every request with OAuth 1.0a and learns the account's limit", async () => {
    const { config: saved, detail } = await x.connect(config());
    assert.equal(saved.maxChars, 280);
    assert.match(detail, /@WikiTreers/);
    const auth = String(api.to("/2/users/me")[0].headers.authorization);
    assert.match(auth, /^OAuth /);
    assert.match(auth, /oauth_consumer_key="ck"/);
    assert.match(auth, /oauth_token="tok"/);
    assert.match(auth, /oauth_signature="[^"]+"/);
  });

  it("posts text", async () => {
    api.requests.length = 0;
    const result = await x.publish(config(), input({ text: "Plain post" }));
    assert.equal(result.url, "https://x.com/WikiTreers/status/TWEET1");
    assert.deepEqual(api.to("/2/tweets")[0].json(), { text: "Plain post" });
  });

  it("uploads an image, sets its alt text, and attaches it", async () => {
    api.requests.length = 0;
    await x.publish(config(), input({ mediaPath: image, mediaKind: "image", altText: "A green square" }));
    const upload = api.to("/2/media/upload")[0].text();
    assert.ok(upload.includes('name="media_category"') && upload.includes("tweet_image"));
    assert.deepEqual(api.to("/2/media/metadata")[0].json(), { id: "IMG1", metadata: { alt_text: { text: "A green square" } } });
    assert.deepEqual(api.to("/2/tweets")[0].json(), { text: "Hello world", media: { media_ids: ["IMG1"] } });
  });

  it("still posts if X refuses the alt text", async () => {
    altStatus = 400;
    api.requests.length = 0;
    const result = await x.publish(config(), input({ mediaPath: image, mediaKind: "image", altText: "x" }));
    assert.match(result.url, /TWEET1/);
    altStatus = 200;
  });

  it("uploads a video in chunks and waits for X to process it", async () => {
    api.requests.length = 0;
    await x.publish(config(), input({ mediaPath: bigVideo, mediaKind: "video" }));
    const init = api.to("/2/media/upload/initialize")[0].json();
    assert.deepEqual(init, { media_type: "video/mp4", total_bytes: 25_000_000, media_category: "tweet_video" });
    const appends = api.to("/2/media/upload/VID1/append");
    assert.equal(appends.length, 6, "25 MB in 4 MiB parts is 6 parts");
    assert.ok(appends[0].text().includes('name="segment_index"') && appends[5].text().includes("5"));
    assert.equal(api.to("/2/media/upload/VID1/finalize").length, 1);
    assert.deepEqual(api.to("/2/tweets")[0].json(), { text: "Hello world", media: { media_ids: ["VID1"] } });
  });
});

describe("YouTube", () => {
  let api: Fake;
  let tokenCalls = 0;
  let videoState: "none" | "private" | "public" = "private";
  let sessionCount = 0;
  const config = (over: Record<string, unknown> = {}) => ({
    apiBase: api.base,
    tokenUrl: `${api.base}/token`,
    clientId: "cid",
    clientSecret: "csecret",
    refreshToken: "refresh",
    privacy: "public",
    ...over,
  });

  before(async () => {
    api = await startFake((req) => {
      if (req.path === "/token") {
        tokenCalls++;
        return { json: { access_token: `at-${tokenCalls}`, expires_in: 3600 } };
      }
      if (req.path === "/youtube/v3/channels") return { json: { items: [{ snippet: { title: "WikiTreers" } }] } };
      if (req.path === "/upload/youtube/v3/videos") {
        sessionCount++;
        return { headers: { Location: `${api.base}/session${sessionCount}` }, raw: "" };
      }
      if (req.path.startsWith("/session")) {
        const range = String(req.headers["content-range"]);
        const last = /bytes (\d+)-(\d+)\/(\d+)/.exec(range)!;
        const done = Number(last[2]) + 1 === Number(last[3]);
        return done ? { status: 201, json: { id: "VID9", status: { privacyStatus: "private" } } } : { status: 308, headers: { Range: `bytes=0-${last[2]}` } };
      }
      if (req.path === "/youtube/v3/videos" && req.method === "DELETE") return { status: req.url.includes("missing") ? 404 : 204 };
      if (req.path === "/youtube/v3/videos") {
        return { json: { items: videoState === "none" ? [] : [{ status: { privacyStatus: videoState } }] } };
      }
      return { status: 404, json: { error: { message: "no route" } } };
    });
  });
  after(() => api.close());

  it("only accepts video, and explains why Community posts are impossible", () => {
    assert.equal(youtube.accepts("video", {}), null);
    assert.match(youtube.accepts("image", {})!, /Community posts/);
    assert.match(youtube.accepts(null, {})!, /Community posts/);
    assert.equal(youtube.needsTitle, "required");
  });

  it("signs in with the refresh token and saves the access token for reuse", async () => {
    const saved: Record<string, unknown>[] = [];
    const { detail } = await youtube.connect(config(), { saveConfig: (p) => saved.push(p) });
    assert.match(detail, /"WikiTreers"/);
    assert.equal(saved[0].accessToken, "at-1");
    const form = api.to("/token")[0].form();
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), "refresh");
  });

  it("uploads in resumable chunks and says when YouTube forced the video private", async () => {
    api.requests.length = 0;
    const saved: Record<string, unknown>[] = [];
    const result = await youtube.publish(
      config({ accessToken: "cached", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
      input({ mediaPath: bigVideo, mediaKind: "video", title: "My video", text: "Description here" }),
      { saveConfig: (p) => saved.push(p) },
    );
    assert.equal(api.to("/token").length, 0, "a valid cached token must be reused");
    assert.equal(result.url, "https://www.youtube.com/watch?v=VID9");
    assert.match(result.note!, /kept this video private instead of public.*audit/);

    const start = api.to("/upload/youtube/v3/videos")[0];
    assert.equal(start.headers["x-upload-content-length"], "25000000");
    assert.equal(start.headers.authorization, "Bearer cached");
    const meta = start.json();
    assert.equal(meta.snippet.title, "My video");
    assert.equal(meta.snippet.description, "Description here");
    assert.equal(meta.status.privacyStatus, "public");

    const puts = api.requests.filter((r) => r.path.startsWith("/session"));
    assert.deepEqual(puts.map((p) => p.headers["content-range"]), ["bytes 0-16777215/25000000", "bytes 16777216-24999999/25000000"]);
  });

  it("holds a scheduled video privately with a publish time, and tracks it", async () => {
    api.requests.length = 0;
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const ref = await youtube.scheduleOnServer!(config({ accessToken: "t", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() }), input({ mediaPath: bigVideo, mediaKind: "video", title: "T" }), when);
    assert.deepEqual(ref, { id: "VID9" });
    const status = api.to("/upload/youtube/v3/videos")[0].json().status;
    assert.equal(status.privacyStatus, "private");
    assert.equal(status.publishAt, when);

    const c = config({ accessToken: "t", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    videoState = "private";
    assert.deepEqual(await youtube.checkOnServer!(c, ref, when), { state: "pending" });
    videoState = "public";
    assert.deepEqual(await youtube.checkOnServer!(c, ref, when), { state: "published", url: "https://www.youtube.com/watch?v=VID9", id: "VID9" });
    videoState = "none";
    assert.deepEqual(await youtube.checkOnServer!(c, ref, when), { state: "gone" });
    assert.equal(await youtube.cancelOnServer!(c, ref), true);
    assert.equal(await youtube.cancelOnServer!(c, { id: "missing" }), false);
  });
});

describe("TikTok", () => {
  let api: Fake;
  let s3: Fake;
  let options = ["SELF_ONLY", "PUBLIC_TO_EVERYONE"];
  let initError: { code: string; message: string } | undefined;
  const objects = new Map<string, Buffer>();
  const config = (over: Record<string, unknown> = {}) => ({
    apiBase: api.base,
    clientKey: "ckey",
    clientSecret: "csecret",
    refreshToken: "rt",
    accessToken: "at",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    username: "wikitreers",
    privacyLevel: "SELF_ONLY",
    ...over,
  });
  const ok = { code: "ok", message: "" };

  before(async () => {
    s3 = await startFake((req) => {
      if (req.method === "PUT") objects.set(req.path, req.body);
      if (req.method === "DELETE") objects.delete(req.path);
      return { status: req.method === "DELETE" ? 204 : 200, headers: { ETag: '"x"' } };
    });
    saveHostConfig({ endpoint: s3.base, bucket: "media", accessKeyId: "A", secretAccessKey: "s", publicBaseUrl: "https://media.example.com" });
    api = await startFake((req) => {
      if (req.path === "/v2/oauth/token/") {
        return { json: { access_token: "fresh", refresh_token: "rt2", expires_in: 86400, refresh_expires_in: 31_536_000 } };
      }
      if (req.path === "/v2/post/publish/creator_info/query/") {
        return { json: { data: { privacy_level_options: options, creator_nickname: "WikiTree" }, error: ok } };
      }
      if (req.path === "/v2/post/publish/video/init/" || req.path === "/v2/post/publish/content/init/") {
        if (initError) return { json: { data: {}, error: initError } };
        return { json: { data: { publish_id: "pub1", upload_url: `${api.base}/upload` }, error: ok } };
      }
      if (req.path === "/upload") return { status: 201, raw: "" };
      if (req.path === "/v2/post/publish/status/fetch/") {
        return { json: { data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [7123] }, error: ok } };
      }
      return { status: 404, json: { error: { message: "no route" } } };
    });
  });
  after(() => {
    api.close();
    s3.close();
  });

  it("refuses text-only posts", () => {
    assert.match(tiktok.accepts(null, {})!, /video or an image/);
    assert.equal(tiktok.accepts("video", {}), null);
    assert.equal(tiktok.accepts("image", {}), null);
  });

  it("explains the private-until-audited restriction on connect", async () => {
    const { detail } = await tiktok.connect(config());
    assert.match(detail, /WikiTree/);
    assert.match(detail, /private.*until TikTok audits/);
  });

  it("renews an expired access token and keeps the new refresh token", async () => {
    const saved: Record<string, unknown>[] = [];
    await tiktok.connect(config({ accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() }), { saveConfig: (p) => saved.push(p) });
    assert.equal(saved[0].accessToken, "fresh");
    assert.equal(saved[0].refreshToken, "rt2");
    assert.equal(api.to("/v2/oauth/token/")[0].form().get("grant_type"), "refresh_token");
  });

  it("uploads a video in chunks (the last one takes the remainder) and finds the public post", async () => {
    api.requests.length = 0;
    const result = await tiktok.publish(config(), input({ mediaPath: bigVideo, mediaKind: "video", text: "My caption" }));
    const init = api.to("/v2/post/publish/video/init/")[0].json();
    assert.deepEqual(init.source_info, { source: "FILE_UPLOAD", video_size: 25_000_000, chunk_size: 10_485_760, total_chunk_count: 2 });
    assert.equal(init.post_info.title, "My caption");
    assert.equal(init.post_info.privacy_level, "SELF_ONLY");
    assert.deepEqual(
      api.to("/upload").map((r) => r.headers["content-range"]),
      ["bytes 0-10485759/25000000", "bytes 10485760-24999999/25000000"],
    );
    assert.equal(result.url, "https://www.tiktok.com/@wikitreers/video/7123");
    assert.match(result.note!, /privately/);
  });

  it("refuses a visibility TikTok doesn't offer this account, naming what is offered", async () => {
    await assert.rejects(
      () => tiktok.publish(config({ privacyLevel: "FOLLOWER_OF_CREATOR" }), input({ mediaPath: bigVideo, mediaKind: "video" })),
      /doesn't offer "FOLLOWER_OF_CREATOR".*SELF_ONLY, PUBLIC_TO_EVERYONE/,
    );
  });

  it("surfaces errors TikTok reports inside a successful HTTP response", async () => {
    initError = { code: "spam_risk_too_many_posts", message: "Daily post limit reached" };
    try {
      await assert.rejects(
        () => tiktok.publish(config(), input({ mediaPath: bigVideo, mediaKind: "video" })),
        /Daily post limit reached \(spam_risk_too_many_posts\)/,
      );
    } finally {
      initError = undefined;
    }
  });

  it("posts a photo by hosting it publicly until TikTok has pulled it", async () => {
    api.requests.length = 0;
    await tiktok.publish(config(), input({ mediaPath: image, mediaKind: "image", text: "Photo caption", title: "Photo title" }));
    const init = api.to("/v2/post/publish/content/init/")[0].json();
    assert.equal(init.media_type, "PHOTO");
    assert.equal(init.post_mode, "DIRECT_POST");
    assert.equal(init.source_info.source, "PULL_FROM_URL");
    assert.match(init.source_info.photo_images[0], /^https:\/\/media\.example\.com\/social-scheduler\/.+\.jpg$/);
    assert.equal(init.post_info.title, "Photo title");
    assert.equal(init.post_info.description, "Photo caption");
    assert.equal(objects.size, 0, "the hosted photo must be removed afterwards");
  });
});

describe("Reddit", () => {
  let api: Fake;
  let s3: Fake;
  let submitErrors: string[][] = [];
  let postedTitle = "";
  const config = (over: Record<string, unknown> = {}) => ({
    authBase: api.base,
    oauthBase: api.base,
    clientId: "cid",
    clientSecret: "csecret",
    refreshToken: "rt",
    username: "wikitreers",
    subreddit: "wikitree",
    ...over,
  });

  before(async () => {
    s3 = await startFake(() => ({ status: 201, raw: "" }));
    api = await startFake((req) => {
      if (req.path === "/api/v1/access_token") return { json: { access_token: "tok", expires_in: 3600 } };
      if (req.path === "/api/v1/me") return { json: { name: "wikitreers" } };
      if (req.path === "/api/media/asset.json") {
        return { json: { args: { action: `${s3.base}/upload`, fields: [{ name: "key", value: "img/abc" }, { name: "policy", value: "p" }] } } };
      }
      if (req.path === "/api/submit") {
        postedTitle = req.form().get("title") ?? "";
        return { json: { json: { errors: submitErrors, data: submitErrors.length ? undefined : { url: "https://www.reddit.com/r/wikitree/comments/abc/hello/" } } } };
      }
      if (req.path === "/user/wikitreers/submitted") {
        return { json: { data: { children: [{ data: { title: postedTitle, permalink: "/r/wikitree/comments/img1/x/", name: "t3_img1", created_utc: Date.now() / 1000 } }] } } };
      }
      if (req.path === "/api/comment") return { json: { json: { errors: [] } } };
      return { status: 404, json: { message: "no route" } };
    });
  });
  after(() => {
    api.close();
    s3.close();
  });

  it("needs a title, refuses video, and accepts text and images", () => {
    assert.equal(reddit.needsTitle, "required");
    assert.match(reddit.accepts("video", {})!, /video uploads aren't supported/);
    assert.equal(reddit.accepts(null, {}), null);
    assert.equal(reddit.accepts("image", {}), null);
  });

  it("refreshes its token with the app's credentials and a descriptive user agent", async () => {
    const { detail } = await reddit.connect(config());
    assert.match(detail, /u\/wikitreers.*r\/wikitree/);
    const req = api.to("/api/v1/access_token")[0];
    assert.equal(req.headers.authorization, `Basic ${Buffer.from("cid:csecret").toString("base64")}`);
    assert.match(String(req.headers["user-agent"]), /social-scheduler.*u\/wikitreers/);
  });

  it("submits a text post to the subreddit", async () => {
    api.requests.length = 0;
    const result = await reddit.publish(config(), input({ title: "Hello r/wikitree", text: "Body text" }));
    assert.equal(result.url, "https://www.reddit.com/r/wikitree/comments/abc/hello/");
    const form = api.to("/api/submit")[0].form();
    assert.equal(form.get("kind"), "self");
    assert.equal(form.get("sr"), "wikitree");
    assert.equal(form.get("title"), "Hello r/wikitree");
    assert.equal(form.get("text"), "Body text");
  });

  it("reports Reddit's reasons when a submit is refused", async () => {
    submitErrors = [["SUBREDDIT_NOTALLOWED", "you aren't allowed to post there"]];
    try {
      await assert.rejects(() => reddit.publish(config(), input({ title: "T" })), /SUBREDDIT_NOTALLOWED: you aren't allowed to post there/);
    } finally {
      submitErrors = [];
    }
  });

  it("uploads an image to Reddit's storage, submits it, finds it, and adds the text as a comment", async () => {
    api.requests.length = 0;
    const result = await reddit.publish(config(), input({ mediaPath: image, mediaKind: "image", title: "A picture", text: "The caption" }));
    assert.equal(result.url, "https://www.reddit.com/r/wikitree/comments/img1/x/");
    const submit = api.to("/api/submit")[0].form();
    assert.equal(submit.get("kind"), "image");
    assert.equal(submit.get("url"), `${s3.base}/upload/img/abc`);
    assert.deepEqual(api.to("/api/comment")[0].form().get("thing_id"), "t3_img1");
    assert.equal(api.to("/api/comment")[0].form().get("text"), "The caption");
    assert.equal(result.note, undefined);
  });
});

describe("Manual (YouTube Community and anything else without an API)", () => {
  it("validates the address and never posts by itself", async () => {
    await assert.rejects(() => manual.connect({ url: "not a url" }), /https:\/\//);
    const { config } = await manual.connect({ url: " https://www.youtube.com/@WikiTreers/community " });
    assert.equal(config.url, "https://www.youtube.com/@WikiTreers/community");
    assert.equal(manual.manual!.openUrl(config), "https://www.youtube.com/@WikiTreers/community");
    assert.equal(manual.accepts(null, config), null);
    assert.equal(manual.accepts("image", config), null);
    await assert.rejects(() => manual.publish(config, input()), /posted by hand/);
  });
});

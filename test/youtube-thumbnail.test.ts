import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import { startFake, type Fake } from "./fake.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-thumb-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { youtube } = await import("../src/providers/youtube.ts");

const video = path.join(dir, "clip.mp4");
const input = (over: Record<string, unknown> = {}) => ({
  text: "Description",
  title: "My video",
  altText: "",
  mediaPath: video,
  mediaKind: "video" as const,
  idempotencyKey: "k",
  ...over,
});

describe("YouTube thumbnail from the video's first frame", () => {
  let api: Fake;
  let thumbnailStatus = 200;
  const config = () => ({ apiBase: api.base, tokenUrl: `${api.base}/token`, clientId: "c", clientSecret: "s", refreshToken: "r", privacy: "public", accessToken: "AT", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const realPath = process.env.PATH;
  let sessions = 0;

  before(async () => {
    fs.writeFileSync(video, Buffer.alloc(5000, 7));
    // A stand-in ffmpeg that "extracts" a 1920x1080 picture, so the test needs no real ffmpeg.
    const frame = path.join(dir, "frame.png");
    await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#336699" } }).png().toFile(frame);
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "ffmpeg"), `#!/bin/sh\ncat "${frame}"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${realPath}`;

    api = await startFake((req) => {
      if (req.path === "/upload/youtube/v3/videos") return { headers: { Location: `${api.base}/session${++sessions}` }, raw: "" };
      if (req.path.startsWith("/session")) return { status: 201, json: { id: "VID9", status: { privacyStatus: "private" } } };
      if (req.path === "/upload/youtube/v3/thumbnails/set") {
        return thumbnailStatus === 200
          ? { json: { items: [{}] } }
          : { status: thumbnailStatus, json: { error: { message: "The authenticated user doesn't have permissions to upload and set custom video thumbnails." } } };
      }
      return { status: 404, json: { error: { message: "no route" } } };
    });
  });
  after(() => {
    process.env.PATH = realPath;
    api.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sets the first frame as the thumbnail after the video is uploaded", async () => {
    api.requests.length = 0;
    const result = await youtube.publish(config(), input({ thumbnailFromVideo: true }));
    assert.equal(result.id, "VID9");
    assert.doesNotMatch(result.note ?? "", /thumbnail/);
    const call = api.to("/upload/youtube/v3/thumbnails/set")[0];
    assert.ok(call, "a thumbnail was uploaded");
    assert.match(call.url, /videoId=VID9/);
    assert.equal(call.method, "POST");
    assert.equal(call.headers["content-type"], "image/jpeg");
    assert.equal(call.headers.authorization, "Bearer AT");
    assert.deepEqual([...call.body.subarray(0, 2)], [0xff, 0xd8], "a JPEG");
    assert.ok(call.body.length < 2 * 1024 * 1024, "within YouTube's 2 MB");
    const meta = await sharp(call.body).metadata();
    assert.ok((meta.width ?? 0) <= 1280, "shrunk to a sensible size");
    assert.ok(api.requests.findIndex((r) => r.path.startsWith("/session")) < api.requests.findIndex((r) => r.path.includes("thumbnails")), "after the video, not before");
  });

  it("leaves YouTube to choose when the option isn't set", async () => {
    api.requests.length = 0;
    await youtube.publish(config(), input());
    assert.equal(api.to("/upload/youtube/v3/thumbnails/set").length, 0);
  });

  it("does it for a video YouTube is holding for later, too", async () => {
    api.requests.length = 0;
    const ref = await youtube.scheduleOnServer!(config(), input({ thumbnailFromVideo: true }), new Date(Date.now() + 86_400_000).toISOString());
    assert.equal(ref.id, "VID9");
    assert.equal(api.to("/upload/youtube/v3/thumbnails/set").length, 1);
    assert.equal(ref.note, undefined);
  });

  it("doesn't fail the post when YouTube won't accept a custom thumbnail, and says to verify the channel", async () => {
    thumbnailStatus = 403;
    const published = await youtube.publish(config(), input({ thumbnailFromVideo: true }));
    assert.equal(published.url, "https://www.youtube.com/watch?v=VID9", "the video is still posted");
    assert.match(published.note!, /wouldn't set its thumbnail.*youtube\.com\/verify/);
    const held = await youtube.scheduleOnServer!(config(), input({ thumbnailFromVideo: true }), new Date(Date.now() + 86_400_000).toISOString());
    assert.equal(held.id, "VID9");
    assert.match(held.note!, /youtube\.com\/verify/, "kept so it can be shown once the video is published");
    thumbnailStatus = 500;
    assert.match((await youtube.publish(config(), input({ thumbnailFromVideo: true }))).note!, /thumbnail couldn't be set \(500/);
    thumbnailStatus = 200;
  });

  it("says so, rather than failing, when the first frame can't be made", async () => {
    process.env.PATH = path.join(dir, "empty");
    fs.mkdirSync(path.join(dir, "empty"), { recursive: true });
    api.requests.length = 0;
    const result = await youtube.publish(config(), input({ thumbnailFromVideo: true }));
    process.env.PATH = `${path.join(dir, "bin")}:${realPath}`;
    assert.equal(result.id, "VID9");
    assert.match(result.note!, /first frame couldn't be made into a thumbnail.*ffmpeg/);
    assert.equal(api.to("/upload/youtube/v3/thumbnails/set").length, 0);
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import { startFake, type Fake } from "./fake.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bluesky-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { bluesky } = await import("../src/providers/bluesky.ts");

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (extra: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), ...extra })}.sig`;

let pds: Fake;
const pictures: string[] = [];
const input = (over: Record<string, unknown> = {}) => ({
  text: "Hello Bluesky",
  title: "",
  altText: "",
  mediaPath: null as string | null,
  mediaKind: null as "image" | "video" | null,
  idempotencyKey: "k",
  ...over,
});
const config = () => ({ service: pds.base, handle: "wikitree.bsky.social", appPassword: "app-password" });

before(async () => {
  for (const colour of ["#2f6f4f", "#25508a"]) {
    const file = path.join(dir, `${colour.slice(1)}.png`);
    await sharp({ create: { width: 300, height: 200, channels: 3, background: colour } }).png().toFile(file);
    pictures.push(file);
  }
  let blobs = 0;
  const cids = ["bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku", "bafkreibme22gw2h7y2h7tg2fhqotaqjucnbc24deqo72b6mkl2egezxhvy", "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy", "bafkreiaxyz5tvbwfrxzofb4cy5fqr2qxzmbhnmtpylvpbmqh5ogmlpdgtq"];
  pds = await startFake((req) => {
    if (req.path === "/xrpc/com.atproto.server.createSession") {
      return { json: { accessJwt: jwt({ sub: "did:plc:abc", scope: "com.atproto.appPassPrivileged" }), refreshJwt: jwt({ sub: "did:plc:abc", scope: "com.atproto.refresh" }), handle: "wikitree.bsky.social", did: "did:plc:abc", active: true } };
    }
    if (req.path === "/xrpc/com.atproto.repo.uploadBlob") {
      blobs++;
      return { json: { blob: { $type: "blob", ref: { $link: cids[(blobs - 1) % cids.length] }, mimeType: "image/jpeg", size: req.body.length } } };
    }
    if (req.path === "/xrpc/com.atproto.repo.createRecord") return { json: { uri: "at://did:plc:abc/app.bsky.feed.post/3kpost", cid: "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm" } };
    if (req.path === "/xrpc/com.atproto.identity.resolveHandle") return { json: { did: "did:plc:someone" } };
    return { status: 404, json: { error: "MethodNotImplemented", message: req.path } };
  });
});
after(() => {
  pds.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Bluesky, against a stand-in server", () => {
  it("signs in with the app password and says who it is", async () => {
    const { detail } = await bluesky.connect(config());
    assert.match(detail, /wikitree\.bsky\.social/);
  });

  it("posts text, with links made clickable, and returns the post's address and id", async () => {
    pds.requests.length = 0;
    const result = await bluesky.publish(config(), input({ text: "Read https://www.wikitree.com/wiki/Help:Calendar today" }));
    assert.equal(result.url, "https://bsky.app/profile/wikitree.bsky.social/post/3kpost");
    assert.equal(result.id, "at://did:plc:abc/app.bsky.feed.post/3kpost");
    const record = pds.to("/xrpc/com.atproto.repo.createRecord")[0].json<any>().record;
    assert.equal(record.text, "Read https://www.wikitree.com/wiki/Help:Calendar today");
    assert.equal(record.facets[0].features[0].$type, "app.bsky.richtext.facet#link");
    assert.equal(record.embed, undefined);
  });

  it("posts a picture with its description", async () => {
    pds.requests.length = 0;
    await bluesky.publish(config(), input({ mediaPath: pictures[0], mediaKind: "image", altText: "A green card" }));
    const record = pds.to("/xrpc/com.atproto.repo.createRecord")[0].json<any>().record;
    assert.equal(record.embed.$type, "app.bsky.embed.images");
    assert.equal(record.embed.images.length, 1);
    assert.equal(record.embed.images[0].alt, "A green card");
    assert.ok(record.embed.images[0].aspectRatio.width > 0);
  });

  it("posts several pictures in one post, each with its own description", async () => {
    pds.requests.length = 0;
    await bluesky.publish(config(), input({ mediaPath: pictures[0], mediaKind: "image", altText: "First", extraImages: [{ path: pictures[1], altText: "Second" }] }));
    assert.equal(pds.to("/xrpc/com.atproto.repo.uploadBlob").length, 2);
    const record = pds.to("/xrpc/com.atproto.repo.createRecord")[0].json<any>().record;
    assert.deepEqual(record.embed.images.map((i: any) => i.alt), ["First", "Second"]);
    assert.notEqual(record.embed.images[0].image.ref.$link, record.embed.images[1].image.ref.$link);
  });

  it("says it takes four pictures and no video", () => {
    assert.equal(bluesky.maxImages!({}), 4);
    assert.match(bluesky.accepts("video", {})!, /Video isn't supported/);
    assert.equal(bluesky.accepts("image", {}), null);
  });

  it("explains a refused sign-in", async () => {
    const bad = await startFake(() => ({ status: 401, json: { error: "AuthenticationRequired", message: "Invalid identifier or password" } }));
    try {
      await assert.rejects(() => bluesky.connect({ service: bad.base, handle: "x", appPassword: "wrong" }), /Invalid identifier or password/);
    } finally {
      bad.close();
    }
  });
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import sharp from "sharp";
import { prepareImage } from "../src/images.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "images-test-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const BLUESKY = { maxBytes: 950_000, maxEdge: 2000 };

async function noisyPng(file: string, width: number, height: number) {
  // Random noise doesn't compress, so this is a worst case for the size limit.
  const raw = crypto.randomBytes(width * height * 3);
  await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(file);
}

describe("prepareImage", () => {
  it("leaves a small image untouched", async () => {
    const file = path.join(dir, "small.jpg");
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#2f6f4f" } }).jpeg().toFile(file);
    const out = await prepareImage(file, BLUESKY);
    assert.deepEqual(out.bytes, fs.readFileSync(file));
    assert.equal(out.mime, "image/jpeg");
    assert.deepEqual([out.width, out.height], [800, 600]);
  });

  it("shrinks a huge image under Bluesky's 1,000,000 byte limit", async () => {
    const file = path.join(dir, "huge.png");
    await noisyPng(file, 3000, 2000);
    assert.ok(fs.statSync(file).size > 5_000_000);
    const out = await prepareImage(file, BLUESKY);
    assert.ok(out.bytes.length <= BLUESKY.maxBytes, `got ${out.bytes.length} bytes`);
    assert.ok(Math.max(out.width, out.height) <= BLUESKY.maxEdge);
    assert.equal(out.mime, "image/jpeg");
  });

  it("applies EXIF rotation so photos aren't sideways", async () => {
    const file = path.join(dir, "rotated.jpg");
    // Stored 400x200 with orientation 6 (rotate 90deg), so it displays as 200x400.
    await sharp({ create: { width: 400, height: 200, channels: 3, background: "#888" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(file);
    const out = await prepareImage(file, BLUESKY);
    assert.deepEqual([out.width, out.height], [200, 400]);
  });

  it("rejects files that aren't images", async () => {
    const file = path.join(dir, "fake.jpg");
    fs.writeFileSync(file, "hello");
    await assert.rejects(() => prepareImage(file, BLUESKY));
  });
});

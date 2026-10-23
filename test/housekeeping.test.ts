import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "housekeeping-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { all, get, run, MEDIA_DIR } = await import("../src/db.ts");
const { pruneOrphanMedia } = await import("../src/library.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const touch = (name: string) => fs.writeFileSync(path.join(MEDIA_DIR, name), "x");

describe("pictures no post uses", () => {
  it("are swept away, but a picture a post uses (first or extra) is never touched, and a brand-new file is left alone", () => {
    const at = new Date().toISOString();
    run("INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at, extra_media) VALUES ('p', '', 'first.png', '', ?, ?, ?)", at, at, JSON.stringify([{ file: "second.png", source: "", alt: "" }]));
    for (const name of ["first.png", "second.png", "orphan.png", "also-orphan.mp4"]) touch(name);

    assert.equal(pruneOrphanMedia(), 0, "everything is brand new, so nothing is removed yet");
    assert.equal(pruneOrphanMedia(0), 2, "the two nobody uses");
    assert.deepEqual(fs.readdirSync(MEDIA_DIR).sort(), ["first.png", "second.png"]);
  });
});


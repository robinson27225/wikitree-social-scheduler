import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "housekeeping-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { all, get, run, MEDIA_DIR } = await import("../src/db.ts");
const { pruneOldMedia, pruneOrphanMedia } = await import("../src/library.ts");
const { pruneAudit } = await import("../src/audit.ts");

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


describe("clearing out what is old", () => {
  const account = Number(run("INSERT INTO accounts (kind, label, config, created_at) VALUES ('dryrun', 'Old stuff', '{}', ?)", new Date().toISOString()).lastInsertRowid);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const post = (media: string, extra: string[], when: string, statuses: string[]) => {
    const id = Number(
      run("INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at, extra_media) VALUES ('old', '', ?, '', ?, ?, ?)", media, when, when, JSON.stringify(extra.map((file) => ({ file, source: "", alt: "" })))).lastInsertRowid,
    );
    for (const status of statuses) run("INSERT INTO targets (post_id, account_id, status, posted_at) VALUES (?, ?, ?, ?)", id, account, status, status === "posted" ? when : null);
    for (const name of [media, ...extra]) touch(name);
    return id;
  };
  const exists = (name: string) => fs.existsSync(path.join(MEDIA_DIR, name));

  it("removes the pictures of posts that finished long ago, and keeps everything that might still be needed", () => {
    post("done-old.png", ["done-old-2.png"], daysAgo(200), ["posted", "posted"]);
    post("failed-old.png", [], daysAgo(200), ["posted", "failed"]);
    post("waiting-old.png", [], daysAgo(200), ["scheduled"]);
    post("done-recent.png", [], daysAgo(10), ["posted"]);
    post("recent-posted-old-schedule.png", [], daysAgo(200), ["posted"]);
    run("UPDATE targets SET posted_at = ? WHERE post_id = (SELECT id FROM posts WHERE media_file = 'recent-posted-old-schedule.png')", daysAgo(5));

    assert.equal(pruneOldMedia(), 2, "the picture and its extra");
    assert.equal(exists("done-old.png"), false);
    assert.equal(exists("done-old-2.png"), false);
    for (const kept of ["failed-old.png", "waiting-old.png", "done-recent.png", "recent-posted-old-schedule.png"]) assert.ok(exists(kept), kept);
    assert.equal(get("SELECT COUNT(*) AS n FROM posts WHERE media_file = 'done-old.png'")!.n, 1, "the record of the post stays");
    assert.equal(pruneOldMedia(), 0, "nothing more to do");
  });

  it("trims the activity log, keeping what is recent", () => {
    run("INSERT INTO audit (at, user_id, email, action, detail) VALUES (?, NULL, 'a', 'login', '')", daysAgo(500));
    run("INSERT INTO audit (at, user_id, email, action, detail) VALUES (?, NULL, 'b', 'login', '')", daysAgo(5));
    assert.equal(pruneAudit(), 1);
    assert.deepEqual(all("SELECT email FROM audit").map((r) => r.email), ["b"]);
  });
});

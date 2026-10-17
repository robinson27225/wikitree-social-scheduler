import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// Must be set before the db module is imported, so tests never touch real data.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dataDir;

const { get, run, setSetting, MEDIA_DIR } = await import("../src/db.ts");
const { publishTarget, startScheduler, stopScheduler, tick } = await import("../src/scheduler.ts");
const { graphemeLength, mastodonLength } = await import("../src/util.ts");

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

function addAccount(config: Record<string, unknown> = {}): number {
  const r = run(
    "INSERT INTO accounts (kind, label, config, created_at) VALUES ('dryrun', 'Test', ?, ?)",
    JSON.stringify(config),
    new Date().toISOString(),
  );
  return Number(r.lastInsertRowid);
}

function addPost(accountId: number, scheduledAt: string, textOnly = false): { postId: number; targetId: number } {
  fs.writeFileSync(path.join(MEDIA_DIR, "x.png"), "not really an image; dryrun never reads it");
  const post = run(
    "INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at) VALUES ('hello', ?, ?, ?, ?, ?)",
    textOnly ? "" : "alt",
    textOnly ? "" : "x.png",
    textOnly ? "" : "/tmp/x.png",
    scheduledAt,
    new Date().toISOString(),
  );
  const target = run(
    "INSERT INTO targets (post_id, account_id) VALUES (?, ?)",
    post.lastInsertRowid,
    accountId,
  );
  return { postId: Number(post.lastInsertRowid), targetId: Number(target.lastInsertRowid) };
}

const status = (targetId: number) => get("SELECT * FROM targets WHERE id = ?", targetId)!;

describe("scheduler", () => {
  before(() => setSetting("missed_grace_minutes", "30"));
  after(() => {
    stopScheduler();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("posts something that is due", async () => {
    const { targetId } = addPost(addAccount(), minutes(-1));
    await tick();
    assert.equal(status(targetId).status, "posted");
    assert.match(String(status(targetId).url), /^dryrun:\/\//);
    assert.ok(fs.readFileSync(path.join(dataDir, "dryrun.log"), "utf8").includes('"text":"hello"'));
  });

  it("posts a text-only post (no image) when it is due", async () => {
    const { targetId } = addPost(addAccount(), minutes(-1), true);
    await tick();
    assert.equal(status(targetId).status, "posted");
    const lines = fs.readFileSync(path.join(dataDir, "dryrun.log"), "utf8").trim().split("\n");
    assert.equal(JSON.parse(lines[lines.length - 1]).image, null);
  });

  it("leaves future posts alone", async () => {
    const { targetId } = addPost(addAccount(), minutes(60));
    await tick();
    assert.equal(status(targetId).status, "scheduled");
  });

  it("marks posts that are too late as missed instead of posting them, and allows posting manually", async () => {
    const { targetId } = addPost(addAccount(), minutes(-120));
    await tick();
    assert.equal(status(targetId).status, "missed");
    assert.equal(await publishTarget(targetId), true);
    assert.equal(status(targetId).status, "posted");
  });

  it("records failures and lets a retry succeed", async () => {
    const accountId = addAccount({ failWith: "boom" });
    const { targetId } = addPost(accountId, minutes(-1));
    await tick();
    assert.equal(status(targetId).status, "failed");
    assert.equal(status(targetId).error, "boom");

    run("UPDATE accounts SET config = '{}' WHERE id = ?", accountId);
    await publishTarget(targetId);
    assert.equal(status(targetId).status, "posted");
    assert.equal(status(targetId).error, null);
  });

  it("never posts the same target twice", async () => {
    const { targetId } = addPost(addAccount(), minutes(-1));
    const [a, b] = await Promise.all([publishTarget(targetId), publishTarget(targetId)]);
    assert.deepEqual([a, b].sort(), [false, true]);
    assert.equal(await publishTarget(targetId), false); // already posted
  });

  it("does not retry a post that was interrupted mid-publish", () => {
    const { targetId } = addPost(addAccount(), minutes(-1));
    run("UPDATE targets SET status = 'posting' WHERE id = ?", targetId);
    startScheduler();
    stopScheduler();
    assert.equal(status(targetId).status, "failed");
    assert.match(String(status(targetId).error), /Interrupted/);
  });
});

describe("character counting", () => {
  it("counts graphemes, not UTF-16 units", () => {
    assert.equal(graphemeLength("héllo"), 5);
    assert.equal(graphemeLength("👨‍👩‍👧"), 1);
  });

  it("counts every Mastodon URL as 23 characters", () => {
    assert.equal(mastodonLength("see https://example.com/a/very/long/path/that/goes/on/and/on/forever"), 4 + 23);
  });
});

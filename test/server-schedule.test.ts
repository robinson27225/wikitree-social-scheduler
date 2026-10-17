import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-schedule-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dataDir;

const { get, run, MEDIA_DIR } = await import("../src/db.ts");
const { placeTarget, publishTarget, releaseServerCopy, tick } = await import("../src/scheduler.ts");

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const remoteFile = path.join(dataDir, "dryrun-remote.json");
const logFile = path.join(dataDir, "dryrun.log");
const remoteEntries = (): Record<string, { whenIso: string }> =>
  fs.existsSync(remoteFile) ? JSON.parse(fs.readFileSync(remoteFile, "utf8")) : {};
const logLines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean) : []);

function addTarget(scheduledAt: string, config: Record<string, unknown> = { nativeSchedule: true }): number {
  const account = run(
    "INSERT INTO accounts (kind, label, config, created_at) VALUES ('dryrun', 'Fake Mastodon', ?, ?)",
    JSON.stringify(config),
    new Date().toISOString(),
  );
  fs.writeFileSync(path.join(MEDIA_DIR, "x.png"), "dryrun never reads the image");
  const post = run(
    "INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at) VALUES ('hello', 'alt', 'x.png', '/tmp/x.png', ?, ?)",
    scheduledAt,
    new Date().toISOString(),
  );
  const target = run("INSERT INTO targets (post_id, account_id) VALUES (?, ?)", post.lastInsertRowid, account.lastInsertRowid);
  return Number(target.lastInsertRowid);
}

const target = (id: number) => get("SELECT * FROM targets WHERE id = ?", id)!;
const postOf = (id: number) => get("SELECT p.* FROM posts p JOIN targets t ON t.post_id = p.id WHERE t.id = ?", id)!;

describe("platform-held schedules", () => {
  after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it("hands a post to the platform when there is enough notice", async () => {
    const id = addTarget(minutes(120));
    await placeTarget(id);
    const row = target(id);
    assert.equal(row.mode, "remote");
    assert.equal(row.status, "scheduled");
    assert.ok(remoteEntries()[JSON.parse(String(row.remote)).id]);
  });

  it("keeps the post in this app when there is less than 6 minutes' notice", async () => {
    const id = addTarget(minutes(3));
    await placeTarget(id);
    assert.equal(target(id).mode, "local");
    assert.equal(target(id).remote, null);
  });

  it("keeps the post in this app when the account doesn't use platform scheduling", async () => {
    const id = addTarget(minutes(120), { nativeSchedule: false });
    await placeTarget(id);
    assert.equal(target(id).mode, "local");
  });

  it("falls back to this app, and says so, if the platform refuses", async () => {
    const id = addTarget(minutes(120), { nativeSchedule: true, failWith: "Too many scheduled posts" });
    await placeTarget(id);
    const row = target(id);
    assert.equal(row.mode, "local");
    assert.equal(row.status, "scheduled");
    assert.match(String(row.error), /Too many scheduled posts/);
    assert.match(String(row.error), /This app will post it/);
  });

  it("never posts a platform-held target itself while it is still pending", async () => {
    const id = addTarget(minutes(120));
    await placeTarget(id);
    const before = logLines().length;
    await tick(new Date(Date.now() + 119 * 60_000)); // just before it is due
    assert.equal(target(id).status, "scheduled");
    assert.equal(logLines().length, before);
  });

  it("marks it posted, with a link, once the platform has published it, even if this app was off", async () => {
    const id = addTarget(minutes(120));
    await placeTarget(id);
    const ref = JSON.parse(String(target(id).remote));
    // Time passes while the app is not running: the platform publishes it on schedule.
    const past = minutes(-180);
    run("UPDATE posts SET scheduled_at = ? WHERE id = ?", past, postOf(id).id);
    const remote = remoteEntries();
    remote[ref.id].whenIso = past;
    fs.writeFileSync(remoteFile, JSON.stringify(remote));

    const before = logLines().length;
    await tick();
    assert.equal(target(id).status, "posted");
    assert.equal(target(id).url, `dryrun://${ref.id}`);
    assert.equal(target(id).external_id, ref.id, "the platform's id is kept for a post it held, too");
    assert.equal(logLines().length, before, "this app must not post a second copy");
  });

  it("'Post now' cancels the platform's copy first and posts exactly once", async () => {
    const id = addTarget(minutes(120));
    await placeTarget(id);
    const ref = JSON.parse(String(target(id).remote));
    const before = logLines().length;

    assert.equal(await publishTarget(id), true);
    assert.equal(target(id).status, "posted");
    assert.equal(target(id).mode, "local");
    assert.equal(remoteEntries()[ref.id], undefined, "platform copy should be gone");
    assert.equal(logLines().length, before + 1);
  });

  it("does not post a duplicate if the platform's copy has vanished", async () => {
    const id = addTarget(minutes(120));
    await placeTarget(id);
    const ref = JSON.parse(String(target(id).remote));
    const remote = remoteEntries();
    delete remote[ref.id]; // e.g. someone deleted it on the platform
    fs.writeFileSync(remoteFile, JSON.stringify(remote));
    const before = logLines().length;

    await publishTarget(id);
    assert.equal(target(id).status, "failed");
    assert.equal(target(id).mode, "local");
    assert.match(String(target(id).error), /Check the account first/);
    assert.equal(logLines().length, before, "nothing should have been posted");

    // After the person has checked, Retry posts it from this app.
    await publishTarget(id);
    assert.equal(target(id).status, "posted");
    assert.equal(logLines().length, before + 1);
  });

  it("re-places the post on the platform after an edit, replacing the old copy", async () => {
    const id = addTarget(minutes(120));
    await placeTarget(id);
    const first = JSON.parse(String(target(id).remote));

    assert.equal(await releaseServerCopy(id), true);
    assert.equal(target(id).mode, "local");
    assert.equal(remoteEntries()[first.id], undefined);

    run("UPDATE posts SET scheduled_at = ? WHERE id = ?", minutes(240), postOf(id).id);
    await placeTarget(id);
    const second = JSON.parse(String(target(id).remote));
    assert.notEqual(second.id, first.id);
    assert.equal(remoteEntries()[second.id].whenIso, postOf(id).scheduled_at);
  });

  it("moves an edited post back to this app if the new time is too soon for the platform", async () => {
    const id = addTarget(minutes(120));
    await placeTarget(id);
    await releaseServerCopy(id);
    run("UPDATE posts SET scheduled_at = ? WHERE id = ?", minutes(2), postOf(id).id);
    await placeTarget(id);
    assert.equal(target(id).mode, "local");
    assert.equal(target(id).remote, null);
  });
});

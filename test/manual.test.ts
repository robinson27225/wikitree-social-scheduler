import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manual-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { get, run, MEDIA_DIR } = await import("../src/db.ts");
const { markPosted, placeTarget, publishTarget, setByHand, setHandedOff, setPostedLink, tick, unmarkPosted } = await import("../src/scheduler.ts");
const { buildBrief } = await import("../src/brief.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

function addManualTarget(scheduledAt: string, withImage = true, text = "Community post text"): number {
  const account = run(
    "INSERT INTO accounts (kind, label, config, created_at) VALUES ('manual', 'YouTube Community', ?, ?)",
    JSON.stringify({ url: "https://www.youtube.com/@WikiTreers/community" }),
    new Date().toISOString(),
  );
  if (withImage) fs.writeFileSync(path.join(MEDIA_DIR, "m.png"), "x");
  const post = run(
    "INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at) VALUES (?, '', ?, '', ?, ?)",
    text,
    withImage ? "m.png" : "",
    scheduledAt,
    new Date().toISOString(),
  );
  const target = run("INSERT INTO targets (post_id, account_id) VALUES (?, ?)", post.lastInsertRowid, account.lastInsertRowid);
  return Number(target.lastInsertRowid);
}

const status = (id: number) => get("SELECT * FROM targets WHERE id = ?", id)!;

describe("manual platforms (no API, such as the YouTube Community tab)", () => {
  it("is never held by a platform", async () => {
    const id = addManualTarget(minutes(180));
    await placeTarget(id);
    assert.equal(status(id).mode, "local");
  });

  it("turns 'ready' at the scheduled time instead of posting anything", async () => {
    const id = addManualTarget(minutes(-1));
    await tick();
    assert.equal(status(id).status, "ready");
    assert.equal(status(id).url, null);
  });

  it("is ready even if the app was off for hours; nothing is stale about a reminder", async () => {
    const id = addManualTarget(minutes(-600));
    await tick();
    assert.equal(status(id).status, "ready");
  });

  it("leaves future reminders alone", async () => {
    const id = addManualTarget(minutes(60));
    await tick();
    assert.equal(status(id).status, "scheduled");
  });

  it("'prepare now' makes it ready early, and is not repeated once ready", async () => {
    const id = addManualTarget(minutes(120));
    assert.equal(await publishTarget(id), true);
    assert.equal(status(id).status, "ready");
    assert.equal(await publishTarget(id), false);
  });

  it("marking it posted records the link; a second mark is refused", async () => {
    const id = addManualTarget(minutes(-1));
    await tick();
    assert.equal(markPosted(id, "  https://www.youtube.com/post/abc  "), true);
    assert.equal(status(id).status, "posted");
    assert.equal(status(id).url, "https://www.youtube.com/post/abc");
    assert.ok(status(id).posted_at);
    assert.equal(markPosted(id), false);
  });

  it("can be marked posted without a link", async () => {
    const id = addManualTarget(minutes(-1), false);
    await tick();
    assert.equal(markPosted(id), true);
    assert.equal(status(id).url, null);
  });
});

describe("a post you scheduled yourself on the platform's own tool", () => {
  it("stops asking for attention until its time, then asks you to check it went out", async () => {
    const id = addManualTarget(minutes(120));
    await publishTarget(id); // "prepare now": it is ready early, so it shows under Needs attention
    assert.equal(status(id).status, "ready");

    assert.deepEqual(setHandedOff(id, true), { ok: true });
    assert.equal(status(id).status, "scheduled", "it leaves Needs attention");
    assert.ok(status(id).handed_off_at);
    await tick();
    assert.equal(status(id).status, "scheduled", "and stays quiet before its time");

    run("UPDATE posts SET scheduled_at = ? WHERE id = (SELECT post_id FROM targets WHERE id = ?)", minutes(-1), id);
    await tick();
    assert.equal(status(id).status, "ready", "at its time it asks you to check");
    assert.ok(status(id).handed_off_at, "and remembers you had scheduled it");
    assert.equal(markPosted(id, "https://x.com/WikiTreers/status/1"), true);
    assert.equal(status(id).status, "posted");
  });

  it("can be taken back, and goes back to being a reminder", async () => {
    const id = addManualTarget(minutes(120));
    setHandedOff(id, true);
    assert.deepEqual(setHandedOff(id, false), { ok: true });
    assert.equal(status(id).handed_off_at, null);
    assert.equal(status(id).status, "scheduled");
  });

  it("is refused once the time has passed, for posts the app makes itself, and for what is already posted", async () => {
    const late = addManualTarget(minutes(-30));
    const refused = setHandedOff(late, true);
    assert.equal(refused.ok, false);
    assert.match((refused as { reason: string }).reason, /time has already passed/);

    const account = run("INSERT INTO accounts (kind, label, config, created_at) VALUES ('dryrun', 'Auto', '{}', ?)", new Date().toISOString());
    const post = run("INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at) VALUES ('t', '', '', '', ?, ?)", minutes(120), new Date().toISOString());
    const auto = Number(run("INSERT INTO targets (post_id, account_id) VALUES (?, ?)", post.lastInsertRowid, account.lastInsertRowid).lastInsertRowid);
    assert.match((setHandedOff(auto, true) as { reason: string }).reason, /only for channels you post to by hand/);

    const done = addManualTarget(minutes(120));
    markPosted(done);
    assert.match((setHandedOff(done, true) as { reason: string }).reason, /already been posted/);
    assert.equal(setHandedOff(999999, true).ok, false);
  });

  it("is described honestly in the daily digest, and not flagged as needing attention", async () => {
    const id = addManualTarget(minutes(60), true, "Check me over on X");
    setHandedOff(id, true);
    const brief = buildBrief();
    assert.ok(!brief.needsAttention.some((n) => n.post.includes("Check me over on X")), "nothing to do yet");
    const channel = brief.upcoming.flatMap((u) => u.channels).find((c) => c.how.includes("you scheduled it there yourself"));
    assert.ok(channel, "the digest says you scheduled it there");

    run("UPDATE posts SET scheduled_at = ? WHERE id = (SELECT post_id FROM targets WHERE id = ?)", minutes(-1), id);
    await tick();
    const later = buildBrief();
    assert.ok(later.needsAttention.some((n) => n.post.includes("Check me over on X") && /scheduled this there yourself/.test(n.detail ?? "")), "at its time the digest asks you to check it");
  });
});

describe("correcting a hand-posted post marked as posted by mistake", () => {
  it("takes 'posted' back, forgetting the link, and goes back to waiting for its time", () => {
    const id = addManualTarget(minutes(180));
    markPosted(id, "https://x.com/WikiTreers/status/1");
    assert.equal(status(id).status, "posted");
    assert.deepEqual(unmarkPosted(id), { ok: true });
    const after = status(id);
    assert.deepEqual([after.status, after.url, after.posted_at, after.external_id], ["scheduled", null, null, null]);
  });

  it("goes back to ready if its time has already passed, so it still asks to be posted", () => {
    const id = addManualTarget(minutes(-30));
    markPosted(id, "https://x.com/WikiTreers/status/2");
    assert.deepEqual(unmarkPosted(id), { ok: true });
    assert.equal(status(id).status, "ready");
    assert.equal(markPosted(id, "https://x.com/WikiTreers/status/3"), true, "and can be marked posted again, on the right one");
  });

  it("changes or clears the recorded link, and insists it is a web address", () => {
    const id = addManualTarget(minutes(-30));
    markPosted(id, "https://x.com/WikiTreers/status/wrong");
    assert.deepEqual(setPostedLink(id, "  https://x.com/WikiTreers/status/right  "), { ok: true });
    assert.equal(status(id).url, "https://x.com/WikiTreers/status/right");
    assert.equal(setPostedLink(id, "not a link").ok, false);
    assert.deepEqual(setPostedLink(id, ""), { ok: true });
    assert.equal(status(id).url, null);
    assert.equal(status(id).status, "posted", "still posted");
  });

  it("refuses for what isn't posted, what the app posted itself, and what doesn't exist", () => {
    const waiting = addManualTarget(minutes(120));
    assert.match((unmarkPosted(waiting) as { reason: string }).reason, /isn't marked as posted/);
    assert.match((setPostedLink(waiting, "https://x.com/a") as { reason: string }).reason, /isn't marked as posted/);

    const account = run("INSERT INTO accounts (kind, label, config, created_at) VALUES ('dryrun', 'Auto 2', '{}', ?)", new Date().toISOString());
    const post = run("INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at) VALUES ('t', '', '', '', ?, ?)", minutes(-5), new Date().toISOString());
    const auto = Number(run("INSERT INTO targets (post_id, account_id, status, url) VALUES (?, ?, 'posted', 'dryrun://x')", post.lastInsertRowid, account.lastInsertRowid).lastInsertRowid);
    assert.match((unmarkPosted(auto) as { reason: string }).reason, /posted by the app itself/);
    assert.match((setPostedLink(auto, "https://x.com/a") as { reason: string }).reason, /posted by the app itself/);
    assert.equal(status(auto).status, "posted", "a real post stays posted");
    assert.equal(unmarkPosted(999999).ok, false);
  });
});

describe("posting any channel by hand", () => {
  // A test account the app could post to itself, optionally one that holds the schedule like Facebook does.
  function autoTarget(scheduledAt: string, config: object = {}): number {
    const account = run("INSERT INTO accounts (kind, label, config, created_at) VALUES ('dryrun', 'Auto channel', ?, ?)", JSON.stringify(config), new Date().toISOString());
    const post = run("INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at) VALUES ('By hand text', '', '', '', ?, ?)", scheduledAt, new Date().toISOString());
    return Number(run("INSERT INTO targets (post_id, account_id) VALUES (?, ?)", post.lastInsertRowid, account.lastInsertRowid).lastInsertRowid);
  }
  const sentKeys = () => {
    const file = path.join(dir, "dryrun.log");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).key as string) : [];
  };
  const wasSent = (id: number) => sentKeys().some((k) => k.startsWith(`social-scheduler-target-${id}`));

  it("is never sent by the app: it turns Ready at its time, and is marked posted with the link", async () => {
    const id = autoTarget(minutes(60));
    assert.deepEqual(await setByHand(id, true), { ok: true });
    assert.equal(status(id).by_hand, 1);
    assert.equal(status(id).status, "scheduled", "waits for its time like a manual account");

    run("UPDATE posts SET scheduled_at = ? WHERE id = ?", minutes(-1), status(id).post_id);
    await tick();
    assert.equal(status(id).status, "ready");
    assert.equal(wasSent(id), false, "the app posted nothing");

    assert.equal(await publishTarget(id), false, "'post now' has nothing to send either");
    assert.equal(wasSent(id), false);
    assert.ok(markPosted(id, "https://example.com/by-hand/1"));
    assert.equal(status(id).status, "posted");
    assert.equal(status(id).url, "https://example.com/by-hand/1");
    // and the slips can be fixed, as for a manual account
    assert.equal(setPostedLink(id, "https://example.com/by-hand/2").ok, true);
    assert.equal(unmarkPosted(id).ok, true);
    assert.equal(status(id).status, "ready");
  });

  it("goes straight to Ready when its time has passed (a failed post you then did yourself)", async () => {
    const id = autoTarget(minutes(-20), { failWith: "The platform said no" });
    await tick();
    assert.equal(status(id).status, "failed");
    assert.deepEqual(await setByHand(id, true), { ok: true });
    assert.equal(status(id).status, "ready");
    assert.equal(status(id).error, null);
  });

  it("takes the post off the platform's own schedule first, so it can't also go out by itself", async () => {
    const id = autoTarget(minutes(180), { nativeSchedule: true });
    await placeTarget(id);
    assert.equal(status(id).mode, "remote");
    const held = JSON.parse(status(id).remote).id;
    const remoteFile = () => JSON.parse(fs.readFileSync(path.join(dir, "dryrun-remote.json"), "utf8"));
    assert.ok(remoteFile()[held]);

    assert.deepEqual(await setByHand(id, true), { ok: true });
    assert.equal(remoteFile()[held], undefined, "cancelled at the platform");
    assert.equal(status(id).mode, "local");
    assert.equal(status(id).remote, null);

    // an edit or a reschedule never hands it back to the platform while it is by hand
    await placeTarget(id);
    assert.equal(status(id).mode, "local");
  });

  it("can be handed back to the app, which then schedules it as usual", async () => {
    const id = autoTarget(minutes(180), { nativeSchedule: true });
    await setByHand(id, true);
    assert.equal(setHandedOff(id, true).ok, true, "by hand, it can be marked 'scheduled there by you'");
    assert.deepEqual(await setByHand(id, false), { ok: true });
    assert.equal(status(id).by_hand, 0);
    assert.equal(status(id).handed_off_at, null);
    assert.equal(status(id).mode, "remote", "back on the platform's schedule");

    const late = autoTarget(minutes(-10));
    await setByHand(late, true);
    assert.equal(status(late).status, "ready");
    await setByHand(late, false);
    assert.equal(status(late).status, "missed", "its time has passed: it waits for a person to press Retry, rather than posting late by itself");
    assert.equal(wasSent(late), false);
  });

  it("is refused for what has gone out, and for accounts that are always by hand", async () => {
    const done = autoTarget(minutes(-1));
    await tick();
    assert.equal(status(done).status, "posted");
    assert.match(((await setByHand(done, true)) as { reason: string }).reason, /already gone out/);
    assert.match(((await setByHand(addManualTarget(minutes(60)), true)) as { reason: string }).reason, /always posted by hand/);
    assert.equal((await setByHand(999999, true)).ok, false);
  });

  it("is described as a by-hand post in the daily digest", async () => {
    const id = autoTarget(minutes(90));
    run("UPDATE posts SET text = 'Digest by hand' WHERE id = ?", status(id).post_id);
    await setByHand(id, true);
    const brief = buildBrief();
    const entry = brief.upcoming.find((u: any) => u.post.includes("Digest by hand"));
    assert.ok(entry, JSON.stringify(brief.upcoming));
    assert.match(entry.channels[0].how, /by hand/);
    assert.equal(entry.appMustBeRunning, false);
  });
});

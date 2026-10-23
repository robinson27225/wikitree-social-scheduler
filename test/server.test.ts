import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";

/**
 * These start the real app (on a free port, with its own empty data folder) and talk to it over HTTP,
 * the way the browser does, so the routes and the rules behind them are tested together.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "server-test-"));
const dataDir = path.join(root, "data");
const mediaDir = path.join(root, "pictures");
fs.mkdirSync(mediaDir);

let child: ChildProcess;
let base = "";
let picId = 0; // the library id of pic.jpg

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function call(method: string, route: string, body?: unknown) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as any };
}

/** Sends a file the way the browser does: raw bytes in a PUT. */
async function upload(name: string, bytes: Buffer | Uint8Array, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/library?name=${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", ...headers },
    body: bytes as BodyInit,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as any };
}

const logLines = (): any[] => {
  const file = path.join(dataDir, "dryrun.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await sharp({ create: { width: 800, height: 800, channels: 3, background: "#2f6f4f" } }).jpeg().toFile(path.join(mediaDir, "pic.jpg"));

  child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, PORT: String(port), NO_OPEN: "1", SOCIAL_SCHEDULER_DATA: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the app didn't start in time")), 20_000);
    child.stdout!.on("data", (chunk) => {
      if (String(chunk).includes("running at")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`the app exited early (${code})`)));
  });
  picId = (await upload("pic.jpg", fs.readFileSync(path.join(mediaDir, "pic.jpg")))).json.item.id;
});

after(() => {
  child.kill();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("hosting basics", () => {
  it("answers the host's health check without a login or a JSON header", async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });

  it("sends strict browser security headers", async () => {
    const res = await fetch(`${base}/api/status`);
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("strict-transport-security"), null, "no https in local mode, so no HSTS");
  });

  it("still refuses requests addressed to some other name", async () => {
    // fetch() won't let a script choose the Host header, so use a plain request
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${base}/api/status`, { headers: { Host: "evil.example.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

async function addAccount(kind: string, label: string, config: Record<string, unknown> = {}) {
  const r = await call("POST", "/api/accounts", { kind, label, config });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.id as number;
}

async function schedule(accountIds: number[], extra: Record<string, unknown> = {}) {
  return call("POST", "/api/posts", {
    libraryId: picId,
    text: "Shared text #WikiTree",
    altText: "A green square",
    scheduledAt: later(120),
    accountIds,
    ...extra,
  });
}

const latestPost = async () => (await call("GET", "/api/posts")).json[0];
const targetOf = (post: any, label: string) => post.targets.find((t: any) => t.accountLabel === label);

describe("per-channel changes to a post", () => {
  let mastodon: number;
  let bluesky: number;

  before(async () => {
    mastodon = await addAccount("dryrun", "Mastodon stand-in");
    bluesky = await addAccount("dryrun", "Bluesky stand-in");
  });

  it("can leave the image off one channel while the others keep it", async () => {
    const r = await schedule([mastodon, bluesky], { overrides: { [mastodon]: { noMedia: true } } });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const post = await latestPost();
    assert.equal(targetOf(post, "Mastodon stand-in").noMedia, true);
    assert.equal(targetOf(post, "Bluesky stand-in").noMedia, false);

    for (const t of post.targets) await call("POST", `/api/targets/${t.id}/post-now`, {});
    const lines = logLines().slice(-2);
    const byText = (label: string) => lines.find((l) => l.key === `social-scheduler-target-${targetOf(post, label).id}`);
    assert.equal(byText("Mastodon stand-in").image, null, "no image on the channel that skipped it");
    assert.match(byText("Bluesky stand-in").image, /\.jpg$/, "the other channel still posts the image");
    assert.equal(byText("Mastodon stand-in").alt, "A green square", "alt text is simply unused when there's no image");
  });

  it("gives one channel its own text (for example different tags) and leaves the others on the shared text", async () => {
    await schedule([mastodon, bluesky]);
    const post = await latestPost();
    const guest = targetOf(post, "Bluesky stand-in");

    const edit = await call("PATCH", `/api/targets/${guest.id}`, { text: "Shared text. Guest: @guest.bsky.social" });
    assert.equal(edit.status, 200, JSON.stringify(edit.json));

    const after = await latestPost();
    assert.equal(targetOf(after, "Bluesky stand-in").text, "Shared text. Guest: @guest.bsky.social");
    assert.equal(targetOf(after, "Bluesky stand-in").customText, true);
    assert.equal(targetOf(after, "Mastodon stand-in").text, "Shared text #WikiTree");
    assert.equal(targetOf(after, "Mastodon stand-in").customText, false);

    await call("POST", `/api/targets/${guest.id}/post-now`, {});
    await call("POST", `/api/targets/${targetOf(after, "Mastodon stand-in").id}/post-now`, {});
    const lines = logLines().slice(-2);
    assert.deepEqual(lines.map((l) => l.text).sort(), ["Shared text #WikiTree", "Shared text. Guest: @guest.bsky.social"]);
  });

  it("goes back to the shared text when a channel's own text is cleared", async () => {
    await schedule([bluesky]);
    const t = (await latestPost()).targets[0];
    await call("PATCH", `/api/targets/${t.id}`, { text: "Only here" });
    assert.equal((await latestPost()).targets[0].customText, true);
    await call("PATCH", `/api/targets/${t.id}`, { text: "" });
    const back = (await latestPost()).targets[0];
    assert.equal(back.customText, false);
    assert.equal(back.text, "Shared text #WikiTree");
  });

  it("checks each channel's own text against that platform's limit", async () => {
    await schedule([bluesky]);
    const t = (await latestPost()).targets[0];
    const tooLong = await call("PATCH", `/api/targets/${t.id}`, { text: "x".repeat(300) });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.json.error, /Too long for Bluesky stand-in: 300 of 280/);
    assert.equal((await latestPost()).targets[0].customText, false, "a refused edit changes nothing");
  });

  it("won't let a channel drop the media if that platform can't post without it", async () => {
    const db = new DatabaseSync(path.join(dataDir, "scheduler.db"));
    const insta = Number(
      db
        .prepare("INSERT INTO accounts (kind, label, config, created_at) VALUES ('instagram', 'Instagram stand-in', ?, ?)")
        .run(JSON.stringify({ igUserId: "1", pageToken: "t", username: "x" }), new Date().toISOString()).lastInsertRowid,
    );
    db.close();

    const refused = await schedule([insta], { overrides: { [insta]: { noMedia: true } } });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /Instagram stand-in: Instagram posts need an image or a video/);
  });

  it("lets a channel that can't take a video post the text alone (Bluesky), but only when asked to", async () => {
    // different bytes from the library test's clip, or the library treats it as the same file
    const head = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(40, 7)]);
    const clip = (await upload("bsky-clip.mp4", head)).json.item.id;
    const db = new DatabaseSync(path.join(dataDir, "scheduler.db"));
    const bsky = Number(
      db
        .prepare("INSERT INTO accounts (kind, label, config, created_at) VALUES ('bluesky', 'Real Bluesky stand-in', ?, ?)")
        .run(JSON.stringify({ handle: "x.bsky.social", appPassword: "p" }), new Date().toISOString()).lastInsertRowid,
    );
    db.close();

    const refused = await schedule([bsky], { libraryId: clip });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /Video isn't supported for Bluesky/);

    const ok = await schedule([bsky, mastodon], { libraryId: clip, overrides: { [bsky]: { noMedia: true } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const post = await latestPost();
    assert.equal(targetOf(post, "Real Bluesky stand-in").noMedia, true);
    assert.equal(targetOf(post, "Mastodon stand-in").noMedia, false);
  });

  it("adds a channel that was missed to a post that is already in the Queue", async () => {
    const extra = await addAccount("dryrun", "Added later");
    const first = await schedule([mastodon]);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const post = await latestPost();
    assert.equal(post.targets.length, 1);
    assert.equal(post.targets[0].accountId, mastodon);

    const added = await call("POST", `/api/posts/${post.id}/channels`, { accountIds: [extra] });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    const after = (await latestPost()).targets;
    assert.deepEqual(after.map((t: any) => t.accountLabel).sort(), ["Added later", "Mastodon stand-in"]);
    assert.equal(after.find((t: any) => t.accountLabel === "Added later").status, "scheduled");

    const twice = await call("POST", `/api/posts/${post.id}/channels`, { accountIds: [extra] });
    assert.equal(twice.status, 409, "a channel can't be added twice");
    assert.match(twice.json.error, /already on this post/);
    assert.equal((await call("POST", `/api/posts/${post.id}/channels`, { accountIds: [] })).status, 400);
    assert.equal((await call("POST", "/api/posts/99999/channels", { accountIds: [extra] })).status, 404);
  });

  it("checks an added channel the same way as when scheduling (Instagram needs a picture)", async () => {
    const db = new DatabaseSync(path.join(dataDir, "scheduler.db"));
    const insta2 = Number(
      db
        .prepare("INSERT INTO accounts (kind, label, config, created_at) VALUES ('instagram', 'Instagram added later', ?, ?)")
        .run(JSON.stringify({ igUserId: "1", pageToken: "t", username: "x" }), new Date().toISOString()).lastInsertRowid,
    );
    db.close();
    await call("POST", "/api/posts", { text: "Text only", scheduledAt: later(120), accountIds: [mastodon] });
    const post = await latestPost();
    const refused = await call("POST", `/api/posts/${post.id}/channels`, { accountIds: [insta2] });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /Instagram added later: Instagram posts need an image or a video/);
    assert.equal((await latestPost()).targets.length, 1, "nothing was added");
  });

  it("refuses to change a channel that has already been posted, but other channels stay editable", async () => {
    await schedule([mastodon, bluesky]);
    const post = await latestPost();
    const done = targetOf(post, "Mastodon stand-in");
    const open = targetOf(post, "Bluesky stand-in");
    await call("POST", `/api/targets/${done.id}/post-now`, {});

    const refused = await call("PATCH", `/api/targets/${done.id}`, { text: "too late" });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /already gone out/);

    assert.equal((await call("PATCH", `/api/targets/${open.id}`, { text: "still fine" })).status, 200);
    // The shared post can't be rewritten once part of it is out, and says where to go instead.
    const shared = await call("PATCH", `/api/posts/${post.id}`, { text: "rewrite everything" });
    assert.equal(shared.status, 409);
    assert.match(shared.json.error, /Edit the channels that haven't been posted/);
  });
});

describe("titles for manual accounts", () => {
  it("can be added later in the Queue instead of blocking the schedule", async () => {
    const reddit = await addAccount("manual", "Reddit stand-in", {
      url: "https://www.reddit.com/r/wikitree/submit?title={title}&text={text}",
      usesTitle: true,
    });
    const account = (await call("GET", "/api/accounts")).json.find((a: any) => a.id === reddit);
    assert.equal(account.needsTitle, "required");

    const r = await schedule([reddit], { title: "" });
    assert.equal(r.status, 200, "a missing title doesn't stop a manual account being scheduled");
    const target = (await latestPost()).targets[0];
    assert.equal(target.titleMissing, true, "but the Queue is told it still needs one");

    await call("PATCH", `/api/targets/${target.id}`, { title: "Smith & Sons: a showcase" });
    const fixed = (await latestPost()).targets[0];
    assert.equal(fixed.titleMissing, false);
    assert.equal(new URL(fixed.manualUrl).searchParams.get("title"), "Smith & Sons: a showcase", "the page opens with this channel's title");
    assert.equal(new URL(fixed.manualUrl).searchParams.get("text"), "Shared text #WikiTree");
  });

  it("still insists on a title for platforms the app posts to itself", async () => {
    const db = new DatabaseSync(path.join(dataDir, "scheduler.db"));
    const yt = Number(
      db
        .prepare("INSERT INTO accounts (kind, label, config, created_at) VALUES ('reddit', 'Reddit API stand-in', ?, ?)")
        .run(JSON.stringify({ clientId: "a", clientSecret: "b", refreshToken: "c", username: "u", subreddit: "wikitree" }), new Date().toISOString())
        .lastInsertRowid,
    );
    db.close();
    const r = await schedule([yt], { title: "" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Reddit API stand-in needs a title/);
  });
});

describe("a platform-held schedule follows per-channel edits", () => {
  it("replaces the platform's copy when one channel's text changes", async () => {
    const held = await addAccount("dryrun", "Held stand-in", { nativeSchedule: true });
    const remoteFile = path.join(dataDir, "dryrun-remote.json");
    const entries = () => Object.entries(JSON.parse(fs.readFileSync(remoteFile, "utf8")) as Record<string, { text: string }>);

    const created = await schedule([held], { scheduledAt: later(60) });
    assert.equal(created.status, 200);
    const postById = async () => (await call("GET", "/api/posts")).json.find((p: any) => p.id === created.json.id);
    const target = (await postById()).targets[0];
    assert.equal(target.mode, "remote", `expected the platform to hold it (error: ${target.error})`);
    const [firstId, first] = entries().at(-1)!;
    assert.equal(first.text, "Shared text #WikiTree");

    assert.equal((await call("PATCH", `/api/targets/${target.id}`, { text: "Different words here" })).status, 200);
    const now = Object.fromEntries(entries());
    assert.equal(now[firstId], undefined, "the old copy at the platform is gone");
    assert.ok(Object.values(now).some((e) => e.text === "Different words here"), "and a new one carries the channel's own text");
    assert.equal((await postById()).targets[0].mode, "remote", "it's still held by the platform");
  });
});

describe("posts with several pictures", () => {
  const colours = ["#aa3333", "#33aa33", "#3333aa", "#aaaa33", "#aa33aa", "#33aaaa", "#884400", "#004488", "#448800", "#880044", "#008844", "#440088"];
  const ids: number[] = [];
  let channel: number;

  before(async () => {
    channel = await addAccount("dryrun", "Several pictures channel");
    for (const [i, colour] of colours.entries()) {
      const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: colour } }).png().toBuffer();
      const r = await upload(`multi-${i}.png`, png);
      assert.equal(r.status, 201, JSON.stringify(r.json));
      ids.push(r.json.item.id);
    }
  });

  const post = (libraryId: number, more: unknown, extra: Record<string, unknown> = {}) =>
    call("POST", "/api/posts", { libraryId, text: "Several pictures", altText: "First", scheduledAt: later(120), accountIds: [channel], moreImages: more, ...extra });

  it("keeps every picture, each with its own description, and marks them all as used", async () => {
    const r = await post(ids[0], [{ libraryId: ids[1], altText: "Second" }, { libraryId: ids[2], altText: "" }]);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const p = await latestPost();
    assert.equal(p.extraMedia.length, 2);
    assert.deepEqual(p.extraMedia.map((m: any) => m.altText), ["Second", ""]);
    assert.deepEqual(p.extraMedia.map((m: any) => m.libraryId), [ids[1], ids[2]]);
    const library = (await call("GET", "/api/library")).json.items as any[];
    for (const id of [ids[0], ids[1], ids[2]]) assert.equal(library.find((i) => i.id === id).state, "scheduled", "every picture counts as used");
    assert.equal(library.find((i) => i.id === ids[3]).state, "new");

    // the post keeps its own copies: removing a library picture changes nothing
    await call("DELETE", `/api/library/${ids[1]}`, {});
    const after = await latestPost();
    assert.equal((await fetch(`${base}${after.extraMedia[0].url}`)).status, 200);
  });

  it("posts them all, and cuts the list to what a channel takes", async () => {
    const r = await post(ids[3], ids.slice(4, 12).map((id, i) => ({ libraryId: id, altText: `Picture ${i + 2}` })).concat([{ libraryId: ids[0], altText: "again" }, { libraryId: ids[2], altText: "again" }]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const p = await latestPost();
    assert.equal(p.extraMedia.length, 10, "all kept on the post");
    await call("POST", `/api/targets/${p.targets[0].id}/post-now`, {});
    const line = logLines().at(-1);
    assert.equal(line.more.length, 9, "the test account takes 10 pictures, so 9 after the first");
    assert.equal(line.more[0].alt, "Picture 2");
  });

  it("a channel set to leave the pictures off posts none of them", async () => {
    await post(ids[3], [{ libraryId: ids[5], altText: "" }], { overrides: { [channel]: { noMedia: true } } });
    const p = await latestPost();
    await call("POST", `/api/targets/${p.targets[0].id}/post-now`, {});
    const line = logLines().at(-1);
    assert.equal(line.image, null);
    assert.deepEqual(line.more, []);
  });

  it("refuses extra pictures that make no sense", async () => {
    const withVideo = await upload("multi-clip.mp4", Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(40, 9)]));
    const videoId = withVideo.json.item.id;
    assert.match((await post(videoId, [{ libraryId: ids[4] }])).json.error, /can only go with a first picture/);
    assert.match((await post(ids[4], [{ libraryId: videoId }])).json.error, /only pictures can be added/);
    assert.match((await post(ids[4], [{ libraryId: ids[4] }])).json.error, /twice/);
    assert.match((await post(ids[4], [{ libraryId: ids[5] }, { libraryId: ids[5] }])).json.error, /twice/);
    assert.match((await post(ids[4], Array.from({ length: 20 }, () => ({ libraryId: ids[6] })))).json.error, /at most 20/);
    assert.equal((await post(ids[4], [{ libraryId: 999999 }])).status, 404);
    assert.equal((await call("POST", "/api/posts", { text: "Text only", scheduledAt: later(120), accountIds: [channel], moreImages: [{ libraryId: ids[4] }] })).status, 400);
  });

  it("adding a channel later gives it the same pictures", async () => {
    await post(ids[7], [{ libraryId: ids[8], altText: "Second" }]);
    const p = await latestPost();
    const added = await addAccount("dryrun", "Added with pictures");
    assert.equal((await call("POST", `/api/posts/${p.id}/channels`, { accountIds: [added] })).status, 200);
    const target = (await latestPost()).targets.find((t: any) => t.accountLabel === "Added with pictures");
    await call("POST", `/api/targets/${target.id}/post-now`, {});
    const line = logLines().at(-1);
    assert.equal(line.more.length, 1);
    assert.equal(line.more[0].alt, "Second");
  });
});

describe("the Queue's list of posts", () => {
  it("shows the last 90 days and whatever is still waiting, and everything on request", async () => {
    const channel = await addAccount("dryrun", "Old posts channel");
    const db = new DatabaseSync(path.join(dataDir, "scheduler.db"));
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const add = (text: string, status: string) => {
      const p = db.prepare("INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at) VALUES (?, '', '', '', ?, ?)").run(text, old, old);
      db.prepare("INSERT INTO targets (post_id, account_id, status, posted_at) VALUES (?, ?, ?, ?)").run(p.lastInsertRowid, channel, status, old);
    };
    add("Long ago and done", "posted");
    add("Long ago but failed", "failed");
    db.close();
    const texts = async (route: string) => ((await call("GET", route)).json as any[]).map((p) => p.text);
    const recent = await texts("/api/posts");
    assert.ok(!recent.includes("Long ago and done"), "old and finished: left out");
    assert.ok(recent.includes("Long ago but failed"), "old but still needs someone: kept");
    assert.ok((await texts("/api/posts?days=0")).includes("Long ago and done"), "everything on request");
  });
});

describe("taking an account out of use", () => {
  it("deletes an account that never posted, but only retires one with history, keeping its record", async () => {
    const fresh = await addAccount("dryrun", "Never used");
    assert.deepEqual((await call("DELETE", `/api/accounts/${fresh}`, {})).json, { ok: true });
    assert.ok(!((await call("GET", "/api/accounts")).json as any[]).some((a) => a.id === fresh));

    const used = await addAccount("dryrun", "Has posted");
    const r = await call("POST", "/api/posts", { text: "A post", scheduledAt: later(120), accountIds: [used] });
    const post = (await call("GET", "/api/posts")).json.find((p: any) => p.id === r.json.id);
    await call("POST", `/api/targets/${post.targets[0].id}/post-now`, {});
    const gone = await call("DELETE", `/api/accounts/${used}`, {});
    assert.deepEqual(gone.json, { ok: true, retired: true });

    assert.ok(!((await call("GET", "/api/accounts")).json as any[]).some((a) => a.id === used), "out of the lists");
    const again = (await call("GET", "/api/posts")).json.find((p: any) => p.id === r.json.id);
    assert.equal(again.targets[0].status, "posted", "the record of the post is still there");
    assert.equal(again.targets[0].accountLabel, "Has posted");
    assert.match((await call("POST", "/api/posts", { text: "Another", scheduledAt: later(120), accountIds: [used] })).json.error, /no longer exists/);
  });
});

describe("WikiTree Challenge posts", () => {
  let channel: number;
  before(async () => {
    channel = await addAccount("dryrun", "Challenge channel");
  });

  it("marks a post for a stage of a challenge, when scheduling and afterwards", async () => {
    const bad = await call("POST", "/api/posts", { text: "WTC", scheduledAt: later(120), accountIds: [channel], wtc: { challenge: "WTC 12", phase: "someday" } });
    assert.equal(bad.status, 400);
    const made = await call("POST", "/api/posts", { text: "Kick-off day", scheduledAt: later(120), accountIds: [channel], wtc: { challenge: "WTC 12", phase: "kickoff" } });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const post = await latestPost();
    assert.deepEqual(post.wtc, { challenge: "WTC 12", phase: "kickoff", phaseLabel: "Kick-Off" });

    const plain = await call("POST", "/api/posts", { text: "An everyday post", scheduledAt: later(130), accountIds: [channel] });
    const other = (await call("GET", "/api/posts")).json.find((p: any) => p.id === plain.json.id);
    assert.equal(other.wtc, null);
    assert.equal((await call("PUT", `/api/posts/${other.id}/wtc`, { challenge: "WTC 12", phase: "chat" })).status, 200);
    assert.equal((await call("GET", "/api/posts")).json.find((p: any) => p.id === other.id).wtc.phaseLabel, "Chat");
    assert.equal((await call("PUT", `/api/posts/${other.id}/wtc`, { challenge: "", phase: "" })).status, 200, "clearing it");
    const garbage = await fetch(`${base}/api/posts/${other.id}/wtc`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(garbage.status, 400, "a malformed request is the sender's mistake, not a server fault");
    assert.equal((await call("GET", "/api/posts")).json.find((p: any) => p.id === other.id).wtc, null);
    assert.equal((await call("PUT", "/api/posts/99999/wtc", { challenge: "WTC 12", phase: "chat" })).status, 404);
  });

  it("builds the table from the posts that went out, and saves edits to the row labels", async () => {
    const post = await latestPost();
    await call("POST", `/api/targets/${post.targets[0].id}/post-now`, {});
    const info = (await call("GET", "/api/wtc")).json;
    assert.equal(info.phases.length, 10);
    assert.equal(info.rows.length, 9);
    assert.ok(info.challenges.some((c: any) => c.name === "WTC 12"));
    const table = (await call("GET", "/api/wtc/table?challenge=WTC%2012")).json;
    assert.match(table.markup, /^\{\| border="1" /);
    assert.equal((await call("GET", "/api/wtc/table")).status, 400);
    const rows = info.rows.map((r: any) => ({ ...r, label: r.column === "reddit" ? "r/wikitree<br>@someone" : r.label }));
    assert.equal((await call("PUT", "/api/wtc/rows", { rows })).status, 200);
    assert.ok((await call("GET", "/api/wtc/table?challenge=WTC%2012")).json.markup.includes("<!---reddit--->r/wikitree<br>@someone"));
  });
});

describe("the media library", () => {
  const png = () => sharp({ create: { width: 64, height: 48, channels: 3, background: "#aa3311" } }).png().toBuffer();

  it("lists what was uploaded, newest first, with its kind and state", async () => {
    const r = await call("GET", "/api/library");
    assert.equal(r.status, 200);
    const pic = r.json.items.find((i: any) => i.id === picId);
    assert.deepEqual({ name: pic.name, kind: pic.kind }, { name: "pic.jpg", kind: "image" });
    assert.ok(["new", "scheduled"].includes(pic.state));
  });

  it("keeps one copy when the same file is sent twice", async () => {
    const bytes = await png();
    const first = await upload("one.png", bytes);
    const second = await upload("again.png", bytes);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.json.duplicate, true);
    assert.equal(second.json.item.id, first.json.item.id);
  });

  it("decides the file type from its contents, not its name", async () => {
    const jpegNamedPng = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).jpeg().toBuffer();
    const r = await upload("sneaky.png", jpegNamedPng);
    assert.equal(r.status, 201);
    const stored = fs.readdirSync(path.join(dataDir, "library")).filter((f) => f.endsWith(".jpg"));
    assert.ok(stored.length >= 1, "stored with its real extension");
  });

  it("refuses things that aren't pictures or videos", async () => {
    assert.equal((await upload("notes.txt", Buffer.from("hello"))).status, 400);
    assert.equal((await upload("fake.jpg", Buffer.from("this is not a picture"))).status, 400);
    assert.equal((await upload("fake.mp4", Buffer.from("this is not a video at all"))).status, 400);
    assert.equal((await upload("page.html", Buffer.from("<script>alert(1)</script>"))).status, 400);
    assert.equal((await upload("empty.png", Buffer.alloc(0))).status, 400);
  });

  it("accepts a video and gives it a stand-in preview picture", async () => {
    const head = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(40)]);
    const r = await upload("clip.mp4", head);
    assert.equal(r.status, 201);
    assert.equal(r.json.item.kind, "video");
    const thumb = await fetch(`${base}/api/library/${r.json.item.id}/thumb`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get("content-type"), "image/jpeg");
  });

  it("makes a small picture for the grid and a large one on request", async () => {
    const small = await sharp(Buffer.from(await (await fetch(`${base}/api/library/${picId}/thumb`)).arrayBuffer())).metadata();
    const large = await sharp(Buffer.from(await (await fetch(`${base}/api/library/${picId}/thumb?size=large`)).arrayBuffer())).metadata();
    assert.equal(small.width, 360);
    assert.ok((large.width ?? 0) > 360);
  });

  it("only accepts uploads sent as raw bytes from this app's own address", async () => {
    const bytes = await png();
    assert.equal((await upload("x.png", bytes, { "Content-Type": "text/plain" })).status, 403);
    assert.equal((await upload("x.png", bytes, { Origin: "https://evil.example.com" })).status, 403);
    // and JSON posts to the upload address are not a way around it
    assert.equal((await call("PUT", "/api/library?name=x.png", { a: 1 })).status, 403);
  });

  it("never trusts a name or id from the request to find a file", async () => {
    assert.equal((await call("GET", "/api/library/abc/thumb")).status, 404);
    assert.equal((await call("GET", "/api/library/99999/thumb")).status, 404);
    assert.equal((await call("GET", "/api/library/..%2F..%2Fscheduler.db/thumb")).status, 404);
    const odd = await upload("../../etc/passwd.png", await sharp({ create: { width: 21, height: 17, channels: 3, background: "#445566" } }).png().toBuffer());
    assert.ok([200, 201].includes(odd.status));
    assert.equal(odd.json.item.name, "passwd.png");
  });

  it("never gives a new file the id of a deleted one (which would show the old picture and tags)", async () => {
    const make = (color: string) => sharp({ create: { width: 20, height: 20, channels: 3, background: color } }).png().toBuffer();
    const first = (await upload("reuse-a.png", await make("#102030"))).json.item;
    assert.equal((await call("DELETE", `/api/library/${first.id}`)).status, 200);
    const second = (await upload("reuse-b.png", await make("#203040"))).json.item;
    assert.ok(second.id > first.id, `${second.id} should come after ${first.id}`);
    assert.equal((await call("DELETE", `/api/library/${second.id}`)).status, 200);
  });

  it("can't make a post from a file that isn't in the library", async () => {
    const dry = await addAccount("dryrun", "Library test stand-in");
    const r = await call("POST", "/api/posts", { libraryId: 424242, text: "hi", scheduledAt: later(120), accountIds: [dry] });
    assert.equal(r.status, 404);
    const viaPath = await call("POST", "/api/posts", { sourcePath: path.join(mediaDir, "pic.jpg"), text: "hi", scheduledAt: later(120), accountIds: [dry] });
    assert.equal(viaPath.status, 200, "a bare path is ignored; this is just a text-only post");
    const post = (await call("GET", "/api/posts")).json.find((p: any) => p.id === viaPath.json.id);
    assert.equal(post.mediaFile, null);
  });

  it("marks a file as used once a post is made, and a post keeps its picture after the library item is deleted", async () => {
    const bytes = await sharp({ create: { width: 30, height: 30, channels: 3, background: "#123456" } }).png().toBuffer();
    const item = (await upload("keep.png", bytes)).json.item;
    const dry = await addAccount("dryrun", "Keep test stand-in");
    const made = await call("POST", "/api/posts", { libraryId: item.id, text: "keeps its picture", altText: "blue", scheduledAt: later(120), accountIds: [dry] });
    assert.equal(made.status, 200, JSON.stringify(made.json));

    const after = (await call("GET", "/api/library")).json.items.find((i: any) => i.id === item.id);
    assert.equal(after.state, "scheduled");

    const post = (await call("GET", "/api/posts")).json.find((p: any) => p.id === made.json.id);
    assert.equal(post.libraryId, item.id);
    const download = await fetch(`${base}/api/media/${post.mediaFile}?download=1`);
    assert.match(download.headers.get("content-disposition") ?? "", /attachment; filename="keep\.png"/);

    assert.equal((await call("DELETE", `/api/library/${item.id}`)).status, 200);
    assert.equal((await call("GET", `/api/library/${item.id}/thumb`)).status, 404);
    const media = await fetch(`${base}/api/media/${post.mediaFile}`);
    assert.equal(media.status, 200, "the scheduled post still has its picture");
  });
});

describe("templates for recurring posts", () => {
  let dry: number;
  before(async () => {
    dry = await addAccount("dryrun", "Template test stand-in");
  });

  it("starts with the team's usual templates and their schedules", async () => {
    const { templates } = (await call("GET", "/api/templates")).json;
    const byName = (prefix: string) => templates.find((t: any) => t.name.startsWith(prefix));
    assert.equal(templates.length, 10);
    assert.deepEqual(
      ["QoW", "ONS", "CC", "OPS", "Project", "Member of the Week", "Saturday Roundup", "GCH", "FDN", "Mbr Q&A"].map((n) => Boolean(byName(n))),
      Array(10).fill(true),
    );
    const days = (t: any) => t.rules.map((r: any) => `${r.kind}:${r.nth ?? ""}:${r.weekday}`);
    assert.deepEqual(days(byName("QoW")), ["weekly::1"]);
    assert.deepEqual(days(byName("ONS")), ["weekly::2"]);
    assert.deepEqual(days(byName("CC")), ["weekly::2"]);
    assert.deepEqual(days(byName("OPS")), ["weekly::3"]);
    assert.deepEqual(days(byName("Project")), ["weekly::4"]);
    for (const n of ["Member of the Week", "Saturday Roundup", "GCH"]) assert.deepEqual(days(byName(n)), ["weekly::6"], n);
    assert.deepEqual(days(byName("Mbr Q&A")), ["monthly:2:4", "monthly:4:0"], "2nd Thursday and 4th Sunday");
    assert.deepEqual(byName("Mbr Q&A").rules.map((r: any) => r.defaults.time), ["8pm ET", "11am ET"]);
    assert.deepEqual(days(byName("FDN")), ["monthly:2:5", "monthly:4:5"], "the 2nd and 4th Friday, as the wiki page shows");
    assert.match(byName("Saturday Roundup").wikiStyle, /#90C73F/);
    assert.equal(byName("Saturday Roundup").wikiPlaylist, "SaturdayRoundup");
    assert.equal(byName("QoW").wikiBold, true);
    assert.match(byName("Project").wikiSubject, /Tag Link\|Projects/);
    assert.match(byName("QoW").body, /#QuestionOfTheWeek \{\{question\}\}/);
  });

  it("creates, changes and removes a template, and keeps names unique", async () => {
    const made = await call("POST", "/api/templates", { name: "Anniversary", body: "Happy {{years}} years, WikiTree!", rules: [{ kind: "weekly", weekday: 5, time: "10:00" }], accountIds: [dry] });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const id = made.json.template.id;
    assert.deepEqual(made.json.template.accountIds, [dry]);

    assert.equal((await call("POST", "/api/templates", { name: "Anniversary", body: "x" })).status, 409);
    const changed = await call("PATCH", `/api/templates/${id}`, { body: "Happy {{years}}th birthday!", active: false });
    assert.equal(changed.json.template.body, "Happy {{years}}th birthday!");
    assert.equal(changed.json.template.active, false);
    assert.equal(changed.json.template.name, "Anniversary", "fields left out keep their value");

    assert.equal((await call("DELETE", `/api/templates/${id}`)).status, 200);
    assert.equal((await call("PATCH", `/api/templates/${id}`, { body: "x" })).status, 404);
  });

  it("refuses a template that makes no sense", async () => {
    const bad = (body: any) => call("POST", "/api/templates", { name: `Bad ${Math.random()}`, body: "text", ...body });
    assert.equal((await call("POST", "/api/templates", { name: "", body: "x" })).status, 400);
    assert.equal((await call("POST", "/api/templates", { name: "No text", body: "  " })).status, 400);
    assert.equal((await bad({ rules: [{ kind: "daily", weekday: 1, time: "09:00" }] })).status, 400);
    assert.equal((await bad({ rules: [{ kind: "weekly", weekday: 9, time: "09:00" }] })).status, 400);
    assert.equal((await bad({ rules: [{ kind: "weekly", weekday: 1, time: "9am" }] })).status, 400);
    assert.equal((await bad({ rules: [{ kind: "monthly", weekday: 1, time: "09:00" }] })).status, 400, "a monthly rule needs its week");
    assert.equal((await bad({ rules: [{ kind: "monthly", nth: 6, weekday: 1, time: "09:00" }] })).status, 400);
    assert.equal((await bad({ rules: "weekly" })).status, 400);
    assert.equal((await bad({ body: "x".repeat(5001) })).status, 400);
  });

  it("never lets a post go out with a placeholder still unfilled", async () => {
    const r = await call("POST", "/api/posts", { text: "Do you have German roots? {{details}}", scheduledAt: later(120), accountIds: [dry] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /still has \{\{details\}\} to fill in/);
    const inTitle = await call("POST", "/api/posts", { text: "fine", title: "About {{place}}", scheduledAt: later(120), accountIds: [dry] });
    assert.equal(inTitle.status, 400);
    assert.equal((await call("POST", "/api/posts", { text: "Braces { are } fine", scheduledAt: later(121), accountIds: [dry] })).status, 200);
  });

  it("remembers which template a post came from, and forgets it if the template is deleted", async () => {
    const tpl = (await call("POST", "/api/templates", { name: "Linked", body: "hello" })).json.template;
    const made = await call("POST", "/api/posts", { text: "From the template", scheduledAt: later(122), accountIds: [dry], templateId: tpl.id });
    assert.equal(made.status, 200);
    let post = (await call("GET", "/api/posts")).json.find((p: any) => p.id === made.json.id);
    assert.equal(post.templateId, tpl.id);
    assert.equal((await call("DELETE", `/api/templates/${tpl.id}`)).status, 200);
    post = (await call("GET", "/api/posts")).json.find((p: any) => p.id === made.json.id);
    assert.equal(post.templateId, null);
    const bogus = await call("POST", "/api/posts", { text: "Unknown template", scheduledAt: later(123), accountIds: [dry], templateId: 99999 });
    assert.equal((await call("GET", "/api/posts")).json.find((p: any) => p.id === bogus.json.id).templateId, null);
  });
});

describe("the list of published posts with their platform ids", () => {
  let dry: number;
  before(async () => {
    dry = await addAccount("dryrun", "Export test stand-in");
  });

  async function publishNow(text: string) {
    const made = await call("POST", "/api/posts", { text, scheduledAt: later(130), accountIds: [dry] });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const post = (await call("GET", "/api/posts")).json.find((p: any) => p.id === made.json.id);
    const target = post.targets[0].id;
    assert.equal((await call("POST", `/api/targets/${target}/post-now`, {})).status, 200);
    return target as number;
  }

  it("records the platform's own id for a post, and offers it as a CSV a spreadsheet opens", async () => {
    const target = await publishNow("Exported, with a comma, and \"quotes\"");
    const res = await fetch(`${base}/api/export/published`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="published-posts-\d{4}-\d{2}-\d{2}\.csv"/);
    const raw = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], "starts with a byte-order mark so Excel reads it as UTF-8");
    const csv = raw.toString("utf8");
    assert.ok(csv.slice(1).startsWith("postedAt,channel,platform,platformPostId,link,template,text,internalId"));
    assert.ok(csv.includes(`social-scheduler-target-${target}`), "the platform post id is in the list");
    assert.ok(csv.includes('"Exported, with a comma, and ""quotes"""'), "commas and quotes are handled");
  });

  it("also comes as JSON, can be limited by date, and never lets text run as a spreadsheet formula", async () => {
    await publishNow("=HYPERLINK(\"http://evil.example\",\"click\")");
    const json = (await call("GET", "/api/export/published?format=json")).json;
    const row = json.posts.find((p: any) => p.text.startsWith("=HYPERLINK"));
    assert.equal(row.platform, "dryrun");
    assert.match(row.platformPostId, /^social-scheduler-target-\d+$/);

    const csv = await (await fetch(`${base}/api/export/published`)).text();
    assert.ok(csv.includes(`"'=HYPERLINK(`), "a leading = is made plain text");
    assert.ok(!/(^|,)=HYPERLINK/m.test(csv));

    const none = (await call("GET", "/api/export/published?format=json&from=2099-01-01")).json;
    assert.equal(none.posts.length, 0);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok((await call("GET", `/api/export/published?format=json&from=${today}&to=${today}`)).json.posts.length >= 2);
  });

  it("leaves out anything that hasn't been published", async () => {
    const made = await call("POST", "/api/posts", { text: "Still scheduled, not out yet", scheduledAt: later(900), accountIds: [dry] });
    assert.equal(made.status, 200);
    const json = (await call("GET", "/api/export/published?format=json")).json;
    assert.ok(!json.posts.some((p: any) => p.text.startsWith("Still scheduled")));
  });
});

describe("scheduling a hand-posted platform on its own tool", () => {
  it("lets you say you did, and take it back, from the Queue", async () => {
    const manual = await addAccount("manual", "X stand-in", { url: "https://x.com/intent/post?text={text}" });
    const auto = await addAccount("dryrun", "Auto stand-in");
    const made = await call("POST", "/api/posts", { text: "Scheduled over on X", scheduledAt: later(300), accountIds: [manual, auto] });
    assert.equal(made.status, 200);
    const find = async () => (await call("GET", "/api/posts")).json.find((p: any) => p.id === made.json.id);
    const target = (post: any, label: string) => post.targets.find((t: any) => t.accountLabel === label);
    const x = target(await find(), "X stand-in");

    assert.equal((await call("POST", `/api/targets/${x.id}/post-now`, {})).json.status, "ready", "prepared early");
    assert.equal((await call("POST", `/api/targets/${x.id}/handed-off`, {})).status, 200);
    let now = target(await find(), "X stand-in");
    assert.deepEqual([now.status, now.handedOff], ["scheduled", true]);

    assert.equal((await call("POST", `/api/targets/${x.id}/handed-off`, { undo: true })).status, 200);
    now = target(await find(), "X stand-in");
    assert.deepEqual([now.status, now.handedOff], ["scheduled", false]);

    const autoTarget = target(await find(), "Auto stand-in");
    assert.equal((await call("POST", `/api/targets/${autoTarget.id}/handed-off`, {})).status, 409);
    assert.equal((await call("POST", "/api/targets/99999/handed-off", {})).status, 404);
  });
});

describe("wiki table rows over HTTP", () => {
  it("gives the row for one post, and for what went out recently, as JSON or plain text", async () => {
    const tw = await addAccount("manual", "WikiTree on Twitter", { url: "https://x.com/intent/post?text={text}" });
    const made = await call("POST", "/api/posts", { text: "Wiki row test post", scheduledAt: later(140), accountIds: [tw] });
    const post = (await call("GET", "/api/posts")).json.find((p: any) => p.id === made.json.id);
    const target = post.targets[0].id;
    assert.equal((await call("POST", `/api/targets/${target}/post-now`, {})).json.status, "ready");
    assert.equal((await call("POST", `/api/targets/${target}/mark-posted`, { url: "https://twitter.com/WikiTreers/status/1234567" })).status, 200);

    const one = await call("GET", `/api/export/wiki?post=${made.json.id}`);
    assert.equal(one.status, 200);
    assert.equal(one.json.rows.length, 1);
    assert.equal(one.json.rows[0].text.split("\n")[4], "|[https://twitter.com/WikiTreers/status/1234567/ Link]", "the Twitter column, in the page's link style");

    const plain = await fetch(`${base}/api/export/wiki?post=${made.json.id}&format=text&tz=America/Los_Angeles`);
    assert.match(plain.headers.get("content-type") ?? "", /text\/plain/);
    assert.match(await plain.text(), /^\|-\n\|(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\n\|Wiki row test post\n\|\n\|\[https:\/\/twitter\.com\/WikiTreers\/status\/1234567\/ Link\]/);

    const recent = await call("GET", "/api/export/wiki?days=7");
    assert.ok(recent.json.rows.some((r: any) => r.postId === made.json.id));
    assert.equal((await call("GET", "/api/export/wiki?days=0")).status, 400);
    assert.equal((await call("GET", "/api/export/wiki?post=abc")).status, 400);
    assert.equal((await call("GET", `/api/export/wiki?post=${made.json.id}&tz=Not/AZone`)).status, 400);
    assert.equal((await call("GET", `/api/export/wiki?post=${made.json.id}&values=%7Bnot-json`)).status, 400);
  });

  it("lets the column for each account be seen and changed, and refuses a column that doesn't exist", async () => {
    const accounts = await call("GET", "/api/wiki-columns");
    assert.equal(accounts.status, 200);
    assert.deepEqual(accounts.json.columns.map((c: any) => c.key), ["facebook", "twitter", "mastodon", "bluesky", "linkedin", "instagram", "threads", "tiktok", "reddit", "youtube"]);
    const tw = accounts.json.accounts.find((a: any) => a.label === "WikiTree on Twitter");
    assert.equal(tw.column, "twitter", "worked out from its name");

    const changed = await call("PUT", "/api/wiki-columns", { map: { [tw.id]: "reddit" } });
    assert.equal(changed.json.accounts.find((a: any) => a.id === tw.id).column, "reddit");
    assert.equal((await call("PUT", "/api/wiki-columns", { map: { [tw.id]: "myspace" } })).status, 400);
    await call("PUT", "/api/wiki-columns", { map: {} });
  });
});

describe("weeks that differ, and the wiki row for a template post", () => {
  it("lets a regular post be skipped for one day, and brought back", async () => {
    const tpl = (await call("POST", "/api/templates", { name: "Skippable", body: "x", rules: [{ kind: "weekly", weekday: 2, time: "09:00" }] })).json.template;
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    assert.equal((await call("POST", `/api/templates/${tpl.id}/skip`, { day })).status, 200);
    assert.deepEqual((await call("GET", "/api/templates")).json.skips[tpl.id], [day]);
    assert.equal((await call("POST", `/api/templates/${tpl.id}/skip`, { day, skipped: false })).status, 200);
    assert.equal((await call("GET", "/api/templates")).json.skips[tpl.id], undefined);
    assert.equal((await call("POST", `/api/templates/${tpl.id}/skip`, { day: "tomorrow" })).status, 400);
    assert.equal((await call("POST", "/api/templates/99999/skip", { day })).status, 404);
    await call("POST", `/api/templates/${tpl.id}/skip`, { day });
    await call("DELETE", `/api/templates/${tpl.id}`);
    assert.equal((await call("GET", "/api/templates")).json.skips[tpl.id], undefined, "deleting a template forgets its skips");
  });

  it("stores how a template's post appears in the wiki table, and refuses a row style that could break the markup", async () => {
    const good = await call("POST", "/api/templates", { name: "Wiki settings", body: "x", wikiSubject: "{{Tag Link|Projects}} {{project name}}", wikiStyle: "background:#F59122;", wikiBold: true, wikiPlaylist: "Hacktoberfest2026" });
    assert.equal(good.status, 200, JSON.stringify(good.json));
    assert.deepEqual([good.json.template.wikiStyle, good.json.template.wikiBold, good.json.template.wikiPlaylist], ["background:#F59122;", true, "Hacktoberfest2026"]);
    const bad = (extra: object) => call("POST", "/api/templates", { name: `Bad ${Math.random()}`, body: "x", ...extra });
    assert.equal((await bad({ wikiStyle: 'background:red;" onclick="x' })).status, 400);
    assert.equal((await bad({ wikiStyle: "a|b" })).status, 400);
    assert.equal((await bad({ wikiPlaylist: "not a name" })).status, 400);
    assert.equal((await bad({ wikiSubject: "x".repeat(2001) })).status, 400);
  });

  it("keeps the answers typed into a template's blanks, and uses them in the wiki row", async () => {
    const subject = "{{Tag Link|One_Name _Studies}} '''[[Project:{{surname}}|{{surname}}]]'''<br>[[Image:{{image}}|125px]]";
    const tpl = (await call("POST", "/api/templates", { name: "ONS stand-in", body: "Smith {{surname}}", wikiSubject: subject, wikiBold: true })).json.template;
    const acct = await addAccount("manual", "WikiTree on Twitter again", { url: "https://x.com/intent/post?text={text}" });
    const made = await call("POST", "/api/posts", {
      text: "One Name Tuesday: Smith", scheduledAt: later(150), accountIds: [acct], templateId: tpl.id,
      templateValues: { Surname: "Smith", note: 5, "": "ignored" },
    });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const target = (await call("GET", "/api/posts")).json.find((p: any) => p.id === made.json.id).targets[0].id;
    await call("POST", `/api/targets/${target}/post-now`, {});
    await call("POST", `/api/targets/${target}/mark-posted`, { url: "https://x.com/WikiTreers/status/42" });

    const first = (await call("GET", `/api/export/wiki?post=${made.json.id}&tz=America/Los_Angeles`)).json.rows[0];
    assert.deepEqual(first.blanks, ["image"], "the surname came from the post; the image still needs naming");
    assert.ok(first.text.includes("!{{Tag Link|One_Name _Studies}} '''[[Project:Smith|Smith]]'''<br>[[Image:{{image}}|125px]]"), first.text);

    const values = encodeURIComponent(JSON.stringify({ image: "Steve_s_Tools-50.png" }));
    const second = (await call("GET", `/api/export/wiki?post=${made.json.id}&tz=America/Los_Angeles&values=${values}`)).json.rows[0];
    assert.deepEqual(second.blanks, []);
    assert.ok(second.text.includes("[[Image:Steve_s_Tools-50.png|125px]]"));
  });
});

describe("fixing a hand-posted post that was marked posted by mistake", () => {
  it("lets the link be corrected and 'posted' be taken back, from the Queue", async () => {
    const manual = await addAccount("manual", "Reddit again", { url: "https://www.reddit.com/r/wikitree/submit" });
    const made = await call("POST", "/api/posts", { text: "Marked on the wrong post", scheduledAt: later(400), accountIds: [manual] });
    const find = async () => (await call("GET", "/api/posts")).json.find((p: any) => p.id === made.json.id).targets[0];
    const target = (await find()).id;
    await call("POST", `/api/targets/${target}/post-now`, {});
    assert.equal((await call("POST", `/api/targets/${target}/mark-posted`, { url: "https://www.reddit.com/r/wikitree/comments/wrong/" })).status, 200);

    assert.equal((await call("POST", `/api/targets/${target}/posted-link`, { url: "https://www.reddit.com/r/wikitree/comments/right/" })).status, 200);
    assert.equal((await find()).url, "https://www.reddit.com/r/wikitree/comments/right/");
    assert.equal((await call("POST", `/api/targets/${target}/posted-link`, { url: "nope" })).status, 400);

    assert.equal((await call("POST", `/api/targets/${target}/unmark-posted`, {})).status, 200);
    const back = await find();
    assert.deepEqual([back.status, back.url], ["scheduled", null]);
    assert.equal((await call("POST", `/api/targets/${target}/unmark-posted`, {})).status, 409, "not posted any more");
    assert.equal((await call("POST", "/api/targets/99999/unmark-posted", {})).status, 404);
  });
});

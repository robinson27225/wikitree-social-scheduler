import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { metricsPresent, summarise } from "../public/stats-sum.js";
import { startFake, type Fake } from "./fake.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stats-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { facebook } = await import("../src/providers/facebook.ts");
const { instagram } = await import("../src/providers/instagram.ts");
const { threads } = await import("../src/providers/threads.ts");
const { mastodon } = await import("../src/providers/mastodon.ts");
const { bluesky } = await import("../src/providers/bluesky.ts");
const { youtube } = await import("../src/providers/youtube.ts");
const { linkedin } = await import("../src/providers/linkedin.ts");
const { withTotals } = await import("../src/providers/insights.ts");
const { all, get, run } = await import("../src/db.ts");
const { archiveInfo, checkArchivableMonth, clearMonth, collectStats, importTikTokCsv, localDay, monthBeforeLast, monthlyCsv, parseCsv, statsRows } = await import("../src/stats.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const target = (externalId: string) => ({ externalId, url: null, postedAt: new Date().toISOString() });

describe("adding numbers up", () => {
  it("fills in content interactions and engagements when a platform gave only the parts", () => {
    assert.deepEqual(withTotals({ likes: 10, comments: 2, shares: 3, link_clicks: 5 }), {
      likes: 10,
      comments: 2,
      shares: 3,
      link_clicks: 5,
      interactions: 15,
      engagements: 20,
    });
  });

  it("keeps a platform's own totals", () => {
    assert.equal(withTotals({ likes: 1, interactions: 99 }).interactions, 99);
    assert.equal(withTotals({ views: 50 }).engagements, undefined, "views alone say nothing about engagement");
  });

  it("totals per group, and shows a number no one in the group reported as missing rather than zero", () => {
    const rows = [
      { channel: "A", metrics: { views: 10, reach: 4 } },
      { channel: "A", metrics: { views: 5 } },
      { channel: "B", metrics: {} },
    ];
    const groups = summarise(rows, (r: any) => r.channel);
    assert.deepEqual(groups[0].totals, { views: 15, reach: 4 });
    assert.equal(groups[0].posts, 2);
    assert.equal(groups[1].withNumbers, 0);
    assert.equal(groups[1].totals.views, undefined);
    assert.deepEqual(metricsPresent(rows).map((m: any) => m.key), ["views", "reach"]);
  });
});

describe("Facebook numbers", () => {
  let fb: Fake;
  let insightsAllowed = true;
  before(async () => {
    fb = await startFake((req) => {
      if (req.path === "/PAGE_1" && req.url.includes("reactions")) {
        return { json: { reactions: { summary: { total_count: 12 } }, comments: { summary: { total_count: 3 } }, shares: { count: 2 } } };
      }
      if (req.path === "/PAGE_1/insights") {
        if (!insightsAllowed) {
          return { status: 400, json: { error: { message: "(#10) Application does not have permission for this action", code: 10 } } };
        }
        const metric = req.url.match(/metric=([^&]+)/)?.[1];
        if (metric === "post_media_view") return { json: { data: [{ name: metric, values: [{ value: 900 }] }] } };
        if (metric === "post_total_media_view_unique") return { json: { data: [{ name: metric, values: [{ value: 640 }] }] } };
        if (metric === "post_clicks_by_type") return { json: { data: [{ name: metric, values: [{ value: { "link clicks": 17, "other clicks": 4 } }] }] } };
      }
      if (req.path === "/PAGE_BARE" && req.url.includes("reactions")) return { json: { id: "PAGE_BARE" } };
      if (req.path === "/PAGE_BARE/insights") return { json: { data: [] } };
      if (req.path === "/PAGE_RETIRED" && req.url.includes("reactions")) return { json: { comments: { summary: { total_count: 0 } } } };
      if (req.path === "/PAGE_RETIRED/insights") return { status: 400, json: { error: { message: "(#100) metric is no longer supported", code: 100 } } };
      return { status: 404, json: { error: { message: "no route" } } };
    });
  });
  after(() => fb.close());
  const cfg = () => ({ pageToken: "t", graphBase: fb.base });

  it("reads views, viewers, link clicks and the counts, and totals them", async () => {
    const stats = await facebook.fetchStats!(cfg(), target("PAGE_1"));
    assert.deepEqual(stats.metrics, {
      likes: 12,
      comments: 3,
      shares: 2,
      views: 900,
      viewers: 640,
      link_clicks: 17,
      interactions: 17,
      engagements: 34,
    });
    assert.deepEqual(stats.notes, []);
  });

  it("still gives the counts, and says what to add, when the sign-in can't read insights", async () => {
    insightsAllowed = false;
    const stats = await facebook.fetchStats!(cfg(), target("PAGE_1"));
    insightsAllowed = true;
    assert.equal(stats.metrics.likes, 12);
    assert.equal(stats.metrics.views, undefined);
    assert.match(stats.notes[0], /read_insights/);
  });

  it("doesn't turn counts Facebook didn't send into zeros, and says so", async () => {
    const stats = await facebook.fetchStats!(cfg(), target("PAGE_BARE"));
    assert.deepEqual(stats.metrics, {}, "no likes, comments, shares, views or totals made up");
    assert.ok(stats.notes.some((n) => /no reaction or comment counts/.test(n)));
    assert.ok(stats.notes.some((n) => /no data for post_media_view/.test(n)));
  });

  it("copes with a metric Facebook has retired", async () => {
    const stats = await facebook.fetchStats!(cfg(), target("PAGE_RETIRED"));
    assert.equal(stats.metrics.views, undefined);
    assert.match(stats.notes[0], /didn't give views/);
  });

  it("fails (so it is retried) when the post can't be read at all", async () => {
    await assert.rejects(() => facebook.fetchStats!(cfg(), target("PAGE_NOPE")), /404|no route/);
  });
});

describe("Instagram, Threads and the rest", () => {
  it("reads Instagram's insights one at a time and skips ones a post doesn't support", async () => {
    const fake = await startFake((req) => {
      if (req.path === "/IG1" && req.url.includes("like_count")) return { json: { like_count: 30, comments_count: 4 } };
      const metric = req.url.match(/metric=([^&]+)/)?.[1];
      const values: Record<string, number> = { views: 1500, reach: 1100, shares: 6, saved: 9, total_interactions: 55, profile_visits: 12 };
      if (req.path === "/IG1/insights" && metric && metric in values) return { json: { data: [{ name: metric, values: [{ value: values[metric] }] }] } };
      if (req.path === "/IG1/insights") return { status: 400, json: { error: { message: "(#100) metric not supported for this media", code: 100 } } };
      return { status: 404, json: {} };
    });
    try {
      const { metrics, notes } = await instagram.fetchStats!({ pageToken: "t", graphBase: fake.base }, target("IG1"));
      assert.deepEqual(metrics, { likes: 30, comments: 4, views: 1500, reach: 1100, shares: 6, saves: 9, interactions: 55, visits: 12, engagements: 55 });
      assert.deepEqual(notes, [], "follows isn't offered for this post, and that is fine");
    } finally {
      fake.close();
    }
  });

  it("explains a missing Instagram permission", async () => {
    const fake = await startFake((req) =>
      req.url.includes("like_count")
        ? { json: { like_count: 1, comments_count: 0 } }
        : { status: 400, json: { error: { message: "(#10) permission denied", code: 10 } } },
    );
    try {
      const { metrics, notes } = await instagram.fetchStats!({ pageToken: "t", graphBase: fake.base }, target("IG2"));
      assert.equal(metrics.likes, 1);
      assert.match(notes[0], /instagram_manage_insights/);
    } finally {
      fake.close();
    }
  });

  it("reads Threads, counting reposts and quotes as shares", async () => {
    const fake = await startFake((req) => {
      const metric = req.url.match(/metric=([^&]+)/)?.[1] ?? "";
      const values: Record<string, number> = { views: 800, likes: 40, replies: 5, reposts: 3, quotes: 2, shares: 1 };
      return metric in values ? { json: { data: [{ name: metric, values: [{ value: values[metric] }] }] } } : { status: 400, json: { error: { message: "bad", code: 100 } } };
    });
    try {
      const { metrics } = await threads.fetchStats!({ accessToken: "t", threadsBase: fake.base }, target("TH1"));
      assert.equal(metrics.views, 800);
      assert.equal(metrics.comments, 5);
      assert.equal(metrics.shares, 6);
      assert.equal(metrics.interactions, 51);
    } finally {
      fake.close();
    }
  });

  it("reads Mastodon's counts", async () => {
    const fake = await startFake((req) =>
      req.path === "/api/v1/statuses/77" ? { json: { favourites_count: 8, reblogs_count: 4, replies_count: 2 } } : { status: 404, json: { error: "Record not found" } },
    );
    try {
      const { metrics } = await mastodon.fetchStats!({ instance: fake.base, accessToken: "t" }, target("77"));
      assert.deepEqual(metrics, { likes: 8, shares: 4, comments: 2, interactions: 14, engagements: 14 });
      await assert.rejects(() => mastodon.fetchStats!({ instance: fake.base, accessToken: "t" }, target("78")), /404/);
    } finally {
      fake.close();
    }
  });

  it("reads Bluesky's counts without signing in", async () => {
    const fake = await startFake((req) =>
      req.path === "/xrpc/app.bsky.feed.getPosts" && req.url.includes("at%3A%2F%2Fdid%3Aplc%3Aabc%2Fapp.bsky.feed.post%2F1")
        ? { json: { posts: [{ likeCount: 20, repostCount: 3, replyCount: 1, quoteCount: 2 }] } }
        : { json: { posts: [] } },
    );
    try {
      const { metrics } = await bluesky.fetchStats!({ statsBase: fake.base }, target("at://did:plc:abc/app.bsky.feed.post/1"));
      assert.deepEqual(metrics, { likes: 20, shares: 5, comments: 1, interactions: 26, engagements: 26 });
      await assert.rejects(() => bluesky.fetchStats!({ statsBase: fake.base }, target("at://did:plc:abc/app.bsky.feed.post/2")), /doesn't show/);
    } finally {
      fake.close();
    }
  });

  it("reads a YouTube video's views, likes and comments", async () => {
    const fake = await startFake((req) =>
      req.url.includes("id=VID1")
        ? { json: { items: [{ statistics: { viewCount: "321", likeCount: "20", commentCount: "4" } }] } }
        : { json: { items: [] } },
    );
    try {
      const config = { apiBase: fake.base, accessToken: "tok", accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() };
      const { metrics } = await youtube.fetchStats!(config, target("VID1"));
      assert.equal(metrics.views, 321);
      assert.equal(metrics.likes, 20);
      assert.equal(fake.requests[0].headers.authorization, "Bearer tok");
      await assert.rejects(() => youtube.fetchStats!(config, target("VID2")), /doesn't show/);
    } finally {
      fake.close();
    }
  });

  it("reads a LinkedIn post's statistics", async () => {
    const fake = await startFake((req) =>
      req.path === "/rest/organizationalEntityShareStatistics"
        ? {
            json: {
              elements: [{ totalShareStatistics: { impressionCount: 2000, uniqueImpressionsCount: 1500, clickCount: 40, likeCount: 25, commentCount: 3, shareCount: 2 } }],
            },
          }
        : { status: 404, json: {} },
    );
    try {
      const config = { apiBase: fake.base, accessToken: "t", organizationId: "1360133" };
      const { metrics } = await linkedin.fetchStats!(config, target("urn:li:share:123"));
      assert.equal(metrics.views, 2000);
      assert.equal(metrics.reach, 1500);
      assert.equal(metrics.link_clicks, 40);
      assert.equal(metrics.engagements, 70);
      const q = decodeURIComponent(fake.requests[0].url);
      assert.match(q, /organizationalEntity=urn:li:organization:1360133/);
      assert.match(q, /shares=List\(urn:li:share:123\)/);
      await linkedin.fetchStats!(config, target("urn:li:ugcPost:9"));
      assert.match(decodeURIComponent(fake.requests[1].url), /ugcPosts=List\(urn:li:ugcPost:9\)/);
    } finally {
      fake.close();
    }
  });
});

// A posted post on a test account, with the given age.
function posted(externalId: string | null, hoursAgo: number, over: { kind?: string; config?: object; text?: string; url?: string | null } = {}): number {
  const account = run(
    "INSERT INTO accounts (kind, label, config, created_at) VALUES (?, ?, ?, ?)",
    over.kind ?? "dryrun",
    `Account ${Math.random().toString(36).slice(2, 7)}`,
    JSON.stringify(over.config ?? {}),
    new Date().toISOString(),
  );
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  const post = run(
    "INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at) VALUES (?, '', '', '', ?, ?)",
    over.text ?? "Hello",
    at,
    at,
  );
  const t = run(
    "INSERT INTO targets (post_id, account_id, status, posted_at, external_id, url) VALUES (?, ?, 'posted', ?, ?, ?)",
    post.lastInsertRowid,
    account.lastInsertRowid,
    at,
    externalId,
    over.url ?? null,
  );
  return Number(t.lastInsertRowid);
}
const stagesOf = (id: number) => all("SELECT stage, error FROM target_stats WHERE target_id = ? ORDER BY stage", id).map((r) => r.stage);

describe("collecting numbers", () => {
  it("waits a day, then reads once, then waits for the week reading", async () => {
    const young = posted("ext-young", 5);
    const day = posted("ext-day", 30);
    await collectStats();
    assert.deepEqual(stagesOf(young), [], "too soon");
    assert.deepEqual(stagesOf(day), ["d1"]);
    const before = get("SELECT taken_at FROM target_stats WHERE target_id = ?", day)!.taken_at;
    await collectStats();
    assert.equal(get("SELECT taken_at FROM target_stats WHERE target_id = ?", day)!.taken_at, before, "not read again until the next stage");
    await collectStats(new Date(Date.now() + 7 * 24 * 3_600_000));
    assert.deepEqual(stagesOf(day), ["d1", "d7"]);
  });

  it("gives an old, never-read post only the latest due reading", async () => {
    const old = posted("ext-old", 24 * 10);
    await collectStats();
    assert.deepEqual(stagesOf(old), ["d7"]);
  });

  it("leaves posts without a platform id, and very old posts, alone", async () => {
    const noId = posted(null, 30);
    const ancient = posted("ext-ancient", 24 * 60);
    await collectStats();
    assert.deepEqual(stagesOf(noId), []);
    assert.deepEqual(stagesOf(ancient), []);
  });

  it("records a failure, doesn't retry for hours, then tries again", async () => {
    const id = posted("ext-fail", 30, { kind: "mastodon", config: { instance: "http://127.0.0.1:1", accessToken: "t" } });
    await collectStats();
    const first = get("SELECT * FROM target_stats WHERE target_id = ?", id)!;
    assert.ok(first.error);
    await collectStats(new Date(Date.now() + 3_600_000));
    assert.equal(get("SELECT taken_at FROM target_stats WHERE target_id = ?", id)!.taken_at, first.taken_at, "an hour is too soon to retry");
    await collectStats(new Date(Date.now() + 7 * 3_600_000));
    assert.notEqual(get("SELECT taken_at FROM target_stats WHERE target_id = ?", id)!.taken_at, first.taken_at);
  });

  it("'refresh now' re-reads recent posts regardless of stage, but not ones minutes old", async () => {
    const fresh = posted("ext-fresh", 2);
    const minutes = posted("ext-minutes", 0.05);
    await collectStats(new Date(), { force: true });
    assert.deepEqual(stagesOf(fresh), ["now"]);
    assert.deepEqual(stagesOf(minutes), []);
  });

  it("lists posts with their latest numbers, and leaves out channels that can't report any", () => {
    const manualX = posted("whatever", 30, { kind: "manual", config: { url: "https://x.com/intent/post" } });
    const rows = statsRows(new Date(Date.now() - 30 * 86_400_000).toISOString());
    assert.ok(rows.find((r) => r.targetId === manualX) === undefined, "X is hand-posted and has no numbers");
    const withNumbers = rows.find((r) => r.metrics.views !== undefined);
    assert.ok(withNumbers, "a test-account post has numbers");
    assert.ok(withNumbers!.takenAt);
  });
});

describe("the monthly export", () => {
  it("picks the month before last", () => {
    assert.equal(monthBeforeLast(new Date(2026, 9, 5)), "2026-08");
    assert.equal(monthBeforeLast(new Date(2027, 0, 3)), "2026-11");
    assert.equal(monthBeforeLast(new Date(2026, 2, 1)), "2026-01");
  });

  it("only allows that month or earlier", () => {
    const now = new Date(2026, 9, 5);
    assert.equal(checkArchivableMonth("2026-08", now), "2026-08");
    assert.equal(checkArchivableMonth("2025-12", now), "2025-12");
    assert.throws(() => checkArchivableMonth("2026-09", now), /August 2026 and earlier/);
    assert.throws(() => checkArchivableMonth("2026-13", now));
    assert.throws(() => checkArchivableMonth("last month", now));
  });

  // Posts in a month that is always allowed: February two years back.
  const year = new Date().getFullYear() - 2;
  const month = `${year}-02`;
  const at = (day: number, hour = 12) => new Date(year, 1, day, hour).toISOString();
  const addPost = (day: number, metrics: object | null, accountId?: number) => {
    const id = posted(`m-${day}-${Math.random()}`, 24 * 800, { text: "Feb post" });
    run("UPDATE targets SET posted_at = ? WHERE id = ?", at(day), id);
    run("UPDATE posts SET scheduled_at = ? WHERE id = (SELECT post_id FROM targets WHERE id = ?)", at(day), id);
    if (accountId) run("UPDATE targets SET account_id = ? WHERE id = ?", accountId, id);
    if (metrics) run("INSERT INTO target_stats (target_id, stage, taken_at, metrics) VALUES (?, 'd30', ?, ?)", id, at(day), JSON.stringify(metrics));
    return id;
  };

  it("adds each day's posts up per channel, and leaves a number blank when nobody reported it", () => {
    assert.equal(monthlyCsv(month), null, "nothing posted yet");
    const first = addPost(3, { views: 100, likes: 5, shares: 1 });
    const account = get("SELECT account_id FROM targets WHERE id = ?", first)!.account_id;
    addPost(3, { views: 20, likes: 1 }, account);
    addPost(3, null, account); // posted, but no numbers read
    addPost(9, { views: 4 }, account);
    const csv = monthlyCsv(month)!;
    const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    assert.equal(lines[0], "date,channel,platform,posts,posts_with_numbers,views,reach,viewers,engagements,interactions,link_clicks,visits,follows,shares,comments,likes,saves");
    const day3 = lines[1].split(",");
    assert.deepEqual(day3.slice(0, 1).concat(day3.slice(3, 6)), [`${month}-03`, "3", "2", "120"], "three posts, two with numbers, 120 views");
    assert.equal(day3[6], "", "no one reported reach: blank, not zero");
    assert.equal(day3[13], "1", "shares from the one post that had them");
    assert.equal(day3[15], "6", "likes added up");
    assert.equal(lines.length, 3, "two days with posts");
  });

  it("clears the numbers, not the posts, and stops them coming back", async () => {
    const before = all("SELECT 1 FROM target_stats s JOIN targets t ON t.id = s.target_id JOIN posts p ON p.id = t.post_id WHERE p.text = 'Feb post'").length;
    assert.ok(before >= 3);
    const result = clearMonth(month);
    assert.equal(result.readings, before);
    assert.equal(all("SELECT 1 FROM posts WHERE text = 'Feb post'").length >= 4, true, "posts are kept");
    assert.equal(all("SELECT 1 FROM target_stats s JOIN targets t ON t.id = s.target_id JOIN posts p ON p.id = t.post_id WHERE p.text = 'Feb post'").length, 0);
    assert.equal(archiveInfo().clearedThrough! >= `${month}-28`, true);

    // A post from the cleared month isn't read again, even when it would be due.
    const again = posted("late-read", 1, { text: "Feb straggler" });
    run("UPDATE targets SET posted_at = ? WHERE id = ?", at(5), again);
    await collectStats(new Date(new Date(at(5)).getTime() + 31 * 86_400_000));
    assert.deepEqual(stagesOf(again), []);
    assert.equal(localDay(at(5)), `${month}-05`);
  });
});

describe("TikTok's monthly file", () => {
  it("reads quoted cells, other delimiters and either line ending", () => {
    assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n'), [["a", "b"], ["x, y", 'say "hi"']]);
    assert.deepEqual(parseCsv("a;b\n1;2", ";"), [["a", "b"], ["1", "2"]]);
  });

  const tiktok = { url: "https://www.tiktok.com/tiktokstudio/upload" };

  it("matches videos by their link and attaches the numbers", () => {
    const id = posted("tt", 24 * 3, { kind: "manual", config: tiktok, url: "https://www.tiktok.com/@wikitreers/video/7400000000000000001" });
    const file =
      "Video title,Video link,Post time,Total views,Total likes,Total comments,Total shares,Reached audience,Weird column\n" +
      '"Meet our members","https://www.tiktok.com/@wikitreers/video/7400000000000000001","2026-10-12 09:00","1,234",56,7,8,900,x\n' +
      '"Not ours","https://www.tiktok.com/@wikitreers/video/999","2026-10-01 09:00",10,1,0,0,5,y\n';
    const result = importTikTokCsv(file);
    assert.equal(result.matched, 1);
    assert.equal(result.unmatched, 1);
    assert.deepEqual(result.unmatchedExamples, ["Not ours"]);
    assert.ok(result.found.includes("Views") && result.found.includes("Reach"));
    assert.deepEqual(result.ignoredHeaders, ["Weird column"]);
    const row = get("SELECT metrics, source, stage FROM target_stats WHERE target_id = ?", id)!;
    assert.equal(row.source, "csv");
    assert.deepEqual(JSON.parse(row.metrics), { views: 1234, reach: 900, likes: 56, comments: 7, shares: 8, interactions: 71, engagements: 71 });
    // The tab shows it, and a later file replaces it.
    assert.equal(statsRows(new Date(Date.now() - 30 * 86_400_000).toISOString()).find((r) => r.targetId === id)!.metrics.views, 1234);
    importTikTokCsv(file.replace("1,234", "2000"));
    assert.equal(JSON.parse(get("SELECT metrics FROM target_stats WHERE target_id = ? AND stage = 'import'", id)!.metrics).views, 2000);
  });

  it("falls back to the day posted, and to the start of the text when several went out that day", () => {
    const solo = posted(null, 24 * 5, { kind: "manual", config: tiktok, text: "Solo post about trees" });
    const dayOf = (id: number) => String(get("SELECT posted_at FROM targets WHERE id = ?", id)!.posted_at).slice(0, 10);
    const a = posted(null, 24 * 9, { kind: "manual", config: tiktok, text: "Alpha video text here" });
    const b = posted(null, 24 * 9, { kind: "manual", config: tiktok, text: "Bravo video text here" });
    const file =
      "Video title,Date,Views\n" +
      `Solo post about trees,${dayOf(solo)},77\n` +
      `Bravo video text here,${dayOf(b)},55\n` +
      `Something else entirely,${dayOf(a)},1\n`;
    const result = importTikTokCsv(file);
    assert.equal(result.matched, 2);
    assert.equal(JSON.parse(get("SELECT metrics FROM target_stats WHERE target_id = ?", solo)!.metrics).views, 77);
    assert.equal(JSON.parse(get("SELECT metrics FROM target_stats WHERE target_id = ?", b)!.metrics).views, 55);
    assert.equal(get("SELECT 1 FROM target_stats WHERE target_id = ?", a), undefined);
  });

  it("explains a file it can't use instead of guessing", () => {
    assert.match(importTikTokCsv("Date,Video Views\n2026-10-01,5\n").problem ?? "ok", /^ok$/, "per-day rows with a date can still be tried");
    assert.match(importTikTokCsv("Views,Likes\n5,1\n").problem ?? "", /no video link or post date/);
    assert.match(importTikTokCsv("Video title,Colour\nx,red\n").problem ?? "", /couldn't find any numbers/);
    assert.match(importTikTokCsv("only a header\n").problem ?? "", /no rows/);
  });
});

describe("the Stats routes", () => {
  let child: ChildProcess;
  let base = "";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stats-server-"));
  const dataDir = path.join(root, "data");
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${base}${route}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* csv */
    }
    return { status: res.status, json, text };
  };

  before(async () => {
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    base = `http://127.0.0.1:${port}`;
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
  });
  after(() => {
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("shows posted posts with numbers once they are read, and refreshes on request", async () => {
    const account = await call("POST", "/api/accounts", { kind: "dryrun", label: "Test channel", config: {} });
    assert.equal(account.status, 200);
    const db = new DatabaseSync(path.join(dataDir, "scheduler.db"));
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const post = db.prepare("INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at) VALUES ('Server test post', '', '', '', ?, ?)").run(at, at);
    db.prepare("INSERT INTO targets (post_id, account_id, status, posted_at, external_id) VALUES (?, ?, 'posted', ?, 'srv-1')").run(post.lastInsertRowid, account.json.id, at);
    db.close();

    const before = await call("GET", "/api/stats?days=30");
    assert.equal(before.status, 200);
    assert.equal(before.json.rows.length, 1);
    assert.equal(before.json.rows[0].takenAt, null, "not read yet");

    const refreshed = await call("POST", "/api/stats/refresh", {});
    assert.equal(refreshed.json.read, 1);
    const after = await call("GET", "/api/stats?days=30");
    assert.equal(typeof after.json.rows[0].metrics.views, "number");

  });

  it("exports the month before last as daily totals, and clears it only when told to", async () => {
    const month = monthBeforeLast();
    const [y, m] = month.split("-").map(Number);
    const account = ((await call("GET", "/api/accounts")).json as { id: number; label: string }[]).find((a) => a.label === "Test channel")?.id;
    assert.ok(account, "an account exists from the earlier test");
    assert.equal((await call("GET", "/api/export/stats")).status, 404, "nothing posted that month yet");
    assert.equal((await call("GET", "/api/export/stats?month=2099-01")).status, 400, "a recent month can't be exported");
    assert.equal((await call("GET", "/api/export/stats?month=nonsense")).status, 400);

    const db = new DatabaseSync(path.join(dataDir, "scheduler.db"));
    const put = (day: number, views: number) => {
      const at = new Date(y, m - 1, day, 12, 0, 0).toISOString();
      const post = db.prepare("INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at) VALUES ('Old post', '', '', '', ?, ?)").run(at, at);
      const t = db.prepare("INSERT INTO targets (post_id, account_id, status, posted_at, external_id) VALUES (?, ?, 'posted', ?, ?)").run(post.lastInsertRowid, account, at, `old-${day}-${views}`);
      db.prepare("INSERT INTO target_stats (target_id, stage, taken_at, metrics) VALUES (?, 'd30', ?, ?)").run(t.lastInsertRowid, at, JSON.stringify({ views, likes: 1 }));
    };
    put(10, 100);
    put(10, 50);
    put(11, 7);
    db.close();

    const csv = await call("GET", "/api/export/stats");
    assert.equal(csv.status, 200);
    const lines = csv.text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    assert.equal(lines.length, 3, "a header and one row for each of the two days, not one per post");
    assert.match(lines[1], new RegExp(`^${month}-10,Test channel,dryrun,2,2,150,`));
    assert.match(lines[2], new RegExp(`^${month}-11,Test channel,dryrun,1,1,7,`));

    assert.equal((await call("POST", "/api/stats/clear-month", { month })).status, 400, "needs the explicit confirmation");
    const stats = (await call("GET", "/api/stats")).json;
    assert.equal(stats.archive.month, month);
    assert.equal(stats.archive.posts, 3);

    const cleared = await call("POST", "/api/stats/clear-month", { month, confirm: true });
    assert.equal(cleared.json.readings, 3);
    assert.equal(cleared.json.posts, 3);
    const check = new DatabaseSync(path.join(dataDir, "scheduler.db"));
    assert.equal((check.prepare("SELECT COUNT(*) AS n FROM posts WHERE text = 'Old post'").get() as any).n, 3, "the posts themselves stay");
    assert.equal((check.prepare("SELECT COUNT(*) AS n FROM target_stats s JOIN posts p ON 1=1 WHERE p.text = 'Old post' AND s.stage = 'd30'").get() as any).n, 0);
    check.close();
  });

  it("imports a TikTok file and rejects an empty one", async () => {
    assert.equal((await call("POST", "/api/stats/import", { csv: "   " })).status, 400);
    const ok = await call("POST", "/api/stats/import", { csv: "Video title,Video link,Views\nx,https://www.tiktok.com/@a/video/1,5\n" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.matched, 0);
    assert.equal(ok.json.unmatched, 1);
  });
});

describe("the version under the title", () => {
  it("is reported by the app and matches package.json", async () => {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "version-test-"));
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, PORT: String(port), NO_OPEN: "1", SOCIAL_SCHEDULER_DATA: path.join(root2, "data") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
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
      const status = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()) as { version: string };
      const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
      assert.match(status.version, /^\d+\.\d+\.\d+$/);
      assert.equal(status.version, pkg.version);
    } finally {
      child.kill();
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });
});

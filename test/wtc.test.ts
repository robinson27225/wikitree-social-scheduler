import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtc-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { run } = await import("../src/db.ts");
const { checkWtc, DEFAULT_ROWS, listChallenges, saveWtcRows, WTC_PHASES, wtcRows, wtcTable } = await import("../src/wtc.ts");
const { wikiRows } = await import("../src/wiki.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const account = (kind: string, label: string, config: object = {}) =>
  Number(run("INSERT INTO accounts (kind, label, config, created_at) VALUES (?, ?, ?, ?)", kind, label, JSON.stringify(config), new Date().toISOString()).lastInsertRowid);

function post(challenge: string, phase: string, targets: { account: number; url?: string; external?: string; status?: string }[]) {
  const at = new Date().toISOString();
  const id = Number(
    run("INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at, wtc_challenge, wtc_phase) VALUES ('WTC post', '', '', '', ?, ?, ?, ?)", at, at, challenge, phase)
      .lastInsertRowid,
  );
  for (const t of targets) {
    run("INSERT INTO targets (post_id, account_id, status, url, external_id, posted_at) VALUES (?, ?, ?, ?, ?, ?)", id, t.account, t.status ?? "posted", t.url ?? null, t.external ?? null, at);
  }
  return id;
}

describe("the WikiTree Challenge table", () => {
  const fb = account("facebook", "WikiTree (Facebook)");
  const projectFb = account("facebook", "WikiTree's US Black Heritage Project (Facebook)");
  const wtcX = account("manual", "WT Challenge on Twitter", { url: "https://x.com/intent/post" });
  const wikitreeX = account("manual", "WikiTree on Twitter", { url: "https://x.com/intent/post" });
  const masto = account("mastodon", "WikiTree on Mastodon");
  const reddit = account("manual", "WikiTree on Reddit", { url: "https://www.reddit.com/r/wikitree/submit" });
  const yt = account("youtube", "WikiTree (YouTube)");
  const ytCommunity = account("manual", "WikiTree YouTube Community", { url: "https://www.youtube.com/@WikiTreers/community" });

  it("checks the challenge and stage, both or neither", () => {
    assert.deepEqual(checkWtc(null), { challenge: "", phase: "" });
    assert.deepEqual(checkWtc({ challenge: "", phase: "" }), { challenge: "", phase: "" });
    assert.deepEqual(checkWtc({ challenge: " WTC 12 ", phase: "kickoff" }), { challenge: "WTC 12", phase: "kickoff" });
    assert.throws(() => checkWtc({ challenge: "WTC 12" }), /Choose which stage/);
    assert.throws(() => checkWtc({ phase: "chat" }), /which challenge/);
    assert.throws(() => checkWtc({ challenge: "WTC 12", phase: "nonsense" }), /Choose which stage/);
    assert.throws(() => checkWtc({ challenge: "x".repeat(41), phase: "chat" }), /40 characters/);
  });

  it("has the layout of the existing table, with Reddit added", () => {
    const { markup } = wtcTable("Nothing yet");
    const lines = markup.split("\n");
    assert.equal(lines[0], '{| border="1" ');
    assert.equal(lines[1], "!Channel!!Open!!Week<br>out!!Two<br>days!!Kick-Off!!Chat!!Halfway!!Winding<br>Down!!Wrap-Up!!Reveal!!Highlights");
    assert.equal(lines.at(-1), "|}");
    assert.equal(lines.filter((l) => l === "|-").length, 9, "eight channels and Reddit");
    assert.equal(lines[3], "|align=center width=65|{{Image|file=PFWC-1.png|size=50");
    assert.equal(lines[4], "|link=https://www.facebook.com/WikiTreeOfficial}}<!---facebook--->@WikiTreeOfficial<br>@bbettinger");
    assert.ok(markup.includes("|align=center|{{Image|file=PFWC-23.png|size=50\n|link=https://twitter.com/WTChallenge}}<!---twitter--->@WTChallenge<br>"));
    assert.ok(markup.includes("<!---reddit--->r/wikitree"), "Reddit has its row");
    assert.ok(markup.indexOf("<!---reddit--->") > markup.indexOf("<!---youtube--->"), "after the existing rows");
    // every cell is the usual blank link
    assert.equal(lines.filter((l) => l === "|[https://www.facebook.com/WikiTreeOfficial/posts// Link]").length, 10);
    assert.equal(lines.filter((l) => l === "|[https://www.reddit.com/r/wikitree/comments// Link]").length, 10);
    assert.equal(WTC_PHASES.length, 10);
  });

  it("fills a cell from the post that went out for that stage on that channel", () => {
    post("WTC 12", "open", [
      { account: fb, url: "https://www.facebook.com/WikiTreeOfficial/posts/1753737050089555" },
      { account: wtcX, url: "https://x.com/WTChallenge/status/2103194306534400279" },
      { account: masto, url: "https://genealysis.social/@wikitree/117327480752609729" },
      { account: reddit, url: "https://www.reddit.com/r/wikitree/comments/abc123/the_title_of_it/" },
      { account: yt, external: "H03Bhd_yp3Q", url: "https://www.youtube.com/watch?v=H03Bhd_yp3Q" },
    ]);
    post("WTC 12", "week_out", [
      { account: fb, url: "https://www.facebook.com/WikiTreeOfficial/posts/1761850319278228/" },
      { account: ytCommunity, url: "https://www.youtube.com/post/UgkxHX3NrJ14UVxcGJcPZTXK8uO3tr-Bp-BK" },
    ]);
    const { markup, filled, blank } = wtcTable("WTC 12");
    assert.ok(markup.includes("|[https://www.facebook.com/WikiTreeOfficial/posts/1753737050089555/ Link]"));
    assert.ok(markup.includes("|[https://www.facebook.com/WikiTreeOfficial/posts/1761850319278228/ Link]"), "an existing closing slash isn't doubled");
    assert.ok(markup.includes("|[https://x.com/WTChallenge/status/2103194306534400279/ Link]"), "X links stay on x.com in this table");
    assert.ok(markup.includes("|[https://genealysis.social/@wikitree/117327480752609729/ Link]"));
    assert.ok(markup.includes("|[https://www.reddit.com/r/wikitree/comments/abc123/ Link]"), "Reddit without the post's title");
    assert.ok(markup.includes("|{{YouTube|H03Bhd_yp3Q}}"), "an uploaded video is the YouTube template");
    assert.ok(markup.includes("|[https://www.youtube.com/post/UgkxHX3NrJ14UVxcGJcPZTXK8uO3tr-Bp-BK/ Link]"), "a community post is a link");
    assert.equal(filled, 7);
    assert.equal(blank, 90 - 7);
    // the cell goes where the stage is, not just anywhere in the row
    const facebookRow = markup.split("|-").find((r) => r.includes("<!---facebook--->"))!.split("\n").filter((l) => l.startsWith("|["));
    assert.equal(facebookRow[0], "|[https://www.facebook.com/WikiTreeOfficial/posts/1753737050089555/ Link]");
    assert.equal(facebookRow[1], "|[https://www.facebook.com/WikiTreeOfficial/posts/1761850319278228/ Link]");
    assert.equal(facebookRow[2], "|[https://www.facebook.com/WikiTreeOfficial/posts// Link]");
  });

  it("keeps the project Pages and WikiTree's own X out of the Challenge's rows, and other challenges out of this one", () => {
    post("WTC 12", "chat", [
      { account: projectFb, url: "https://www.facebook.com/projectpage/posts/111" },
      { account: wikitreeX, url: "https://x.com/WikiTree/status/222" },
    ]);
    post("WTC 11", "chat", [{ account: fb, url: "https://www.facebook.com/WikiTreeOfficial/posts/999" }]);
    const { markup } = wtcTable("WTC 12");
    assert.ok(!markup.includes("projectpage"));
    assert.ok(!markup.includes("/WikiTree/status/222"));
    assert.ok(!markup.includes("posts/999"));
    assert.ok(wtcTable("WTC 11").markup.includes("posts/999/"));
  });

  it("says when a hand-posted channel went out with no link, and leaves that cell blank", () => {
    post("WTC 13", "kickoff", [{ account: reddit }]);
    const t = wtcTable("WTC 13");
    assert.deepEqual(t.missingLinks, ["WikiTree on Reddit (Kick-Off)"]);
    assert.equal(t.filled, 0);
  });

  it("ignores a post that hasn't gone out", () => {
    post("WTC 14", "open", [{ account: fb, status: "scheduled", url: "https://www.facebook.com/WikiTreeOfficial/posts/555" }]);
    assert.ok(!wtcTable("WTC 14").markup.includes("posts/555"));
  });

  it("lists the challenges newest first, with how many posts have gone out", () => {
    const list = listChallenges();
    assert.ok(list.find((c) => c.name === "WTC 12")!.posted >= 2);
    assert.equal(list.find((c) => c.name === "WTC 14")!.posted, 0);
  });

  it("keeps the challenge's posts out of the everyday rows", () => {
    assert.equal(wikiRows({}).filter((r) => r.text.includes("WTC")).length, 0);
  });

  it("remembers edits to the first cells, and checks them", () => {
    const rows = wtcRows().map((r) => ({ ...r }));
    rows[0].label = "@WikiTreeOfficial<br>@someoneelse";
    saveWtcRows(rows);
    assert.ok(wtcTable("WTC 12").markup.includes("<!---facebook--->@WikiTreeOfficial<br>@someoneelse"));
    assert.equal(wtcRows().length, DEFAULT_ROWS.length);
    assert.throws(() => saveWtcRows([{ column: "myspace" }]), /isn't a row/);
    assert.throws(() => saveWtcRows([{ ...rows[0], match: "(" }]), /valid pattern/);
    assert.throws(() => saveWtcRows([{ ...rows[0], label: "two\nlines" }]), /one line/);
    assert.throws(() => saveWtcRows("nope"), /list/);
  });
});

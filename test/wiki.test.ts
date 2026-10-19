import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { defaultColumn, saveColumnSettings, wikiLink, wikiRows, WIKI_COLUMNS } = await import("../src/wiki.ts");
const { createTemplate, seedWikiSettings, getTemplate, listTemplates } = await import("../src/templates.ts");
const { run, getSetting } = await import("../src/db.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));
const TZ = "America/Los_Angeles";

describe("which column each account's links go in", () => {
  it("follows the platform, and tells WikiTree's own Facebook Page from its project and event Pages", () => {
    assert.equal(defaultColumn({ kind: "mastodon", label: "WikiTree on Mastodon" }), "mastodon");
    assert.equal(defaultColumn({ kind: "bluesky", label: "WikiTree on BlueSky" }), "bluesky");
    assert.equal(defaultColumn({ kind: "facebook", label: "WikiTree (Facebook)" }), "facebook");
    assert.equal(defaultColumn({ kind: "facebook", label: "WikiTree's US Black Heritage Project (Facebook)" }), null);
    assert.equal(defaultColumn({ kind: "facebook", label: "WikiTree Day & Symposium (Facebook)" }), null);
    assert.equal(defaultColumn({ kind: "x", label: "X" }), "twitter");
    assert.equal(defaultColumn({ kind: "dryrun", label: "Test" }), null);
  });

  it("reads hand-posted accounts by their name", () => {
    assert.equal(defaultColumn({ kind: "manual", label: "WikiTree on Twitter" }), "twitter");
    assert.equal(defaultColumn({ kind: "manual", label: "WikiTreers on X" }), "twitter");
    assert.equal(defaultColumn({ kind: "manual", label: "WikiTree on Reddit" }), "reddit");
    assert.equal(defaultColumn({ kind: "manual", label: "WikiTree on TikTok" }), "tiktok");
    assert.equal(defaultColumn({ kind: "manual", label: "WikiTree on LinkedIn" }), "linkedin");
    assert.equal(defaultColumn({ kind: "manual", label: "YouTube Community" }), null, "name it in Settings to put it in the YouTube column");
    assert.equal(defaultColumn({ kind: "manual", label: "Max review" }), null, "an x inside a word is not X");
  });
});

describe("making a link look like the ones on the page", () => {
  it("uses twitter.com, drops Reddit's title, and ends with a slash", () => {
    assert.equal(wikiLink("twitter", "https://x.com/WikiTreers/status/2109761122807202258"), "https://twitter.com/WikiTreers/status/2109761122807202258/");
    assert.equal(wikiLink("reddit", "https://www.reddit.com/r/wikitree/comments/1x4dn5u/question_of_the_week/"), "https://www.reddit.com/r/wikitree/comments/1x4dn5u/");
    assert.equal(wikiLink("instagram", "https://www.instagram.com/p/DeaGGuekZ7C/"), "https://www.instagram.com/p/DeaGGuekZ7C/");
    assert.equal(wikiLink("threads", "https://www.threads.net/@wikitreers/post/DeaI_XGgYba"), "https://www.threads.net/@wikitreers/post/DeaI_XGgYba/");
    assert.equal(wikiLink("facebook", "https://www.facebook.com/page/posts/1?ref=x"), "https://www.facebook.com/page/posts/1?ref=x", "a link with a query is left alone");
    assert.equal(wikiLink("twitter", "https://twitter.com/a b]c"), "https://twitter.com/a%20b%5Dc/", "spaces and brackets can't break the markup");
  });
});

describe("rows of the wiki table", () => {
  const now = new Date().toISOString();
  const account = (kind: string, label: string) =>
    Number(run("INSERT INTO accounts (kind, label, config, created_at) VALUES (?, ?, '{}', ?)", kind, label, now).lastInsertRowid);
  interface Opts { title?: string; at?: string; templateId?: number; values?: object; external?: Record<number, string> }
  function post(text: string, links: [number, string | null][], o: Opts = {}) {
    const at = o.at ?? "2026-10-12T16:00:00.000Z"; // a Monday
    const p = Number(
      run(
        "INSERT INTO posts (text, title, alt_text, media_file, source_path, scheduled_at, created_at, template_id, template_values) VALUES (?, ?, '', '', '', ?, ?, ?, ?)",
        text, o.title ?? "", at, now, o.templateId ?? null, o.values ? JSON.stringify(o.values) : null,
      ).lastInsertRowid,
    );
    for (const [acct, url] of links) {
      run("INSERT INTO targets (post_id, account_id, status, url, posted_at, external_id) VALUES (?, ?, 'posted', ?, ?, ?)", p, acct, url, at, o.external?.[acct] ?? null);
    }
    return p;
  }

  const fb = account("facebook", "WikiTree (Facebook)");
  const fbProject = account("facebook", "WikiTree's US Black Heritage Project (Facebook)");
  const mast = account("mastodon", "WikiTree on Mastodon");
  const bsky = account("bluesky", "WikiTree on BlueSky");
  const li = account("linkedin", "WikiTree on LinkedIn");
  const ig = account("instagram", "@wikitreers (Instagram)");
  const th = account("threads", "@wikitreers (Threads)");
  const tk = account("tiktok", "WikiTreers (TikTok)");
  const tw = account("manual", "WikiTree on Twitter");
  const rd = account("manual", "WikiTree on Reddit");
  const yt = account("youtube", "WikiTreers (YouTube)");
  const ytCommunity = account("manual", "YouTube Community");
  saveColumnSettings({ [ytCommunity]: "youtube" });

  const qow = createTemplate({
    name: "QoW: Question of the Week",
    body: "x",
    wikiSubject: "{{Tag Link|Question_of_the_Week}} {{subject}}<br>[[Image:{{image}}|125px]]",
    wikiBold: true,
    wikiPlaylist: "QuestionOfTheWeek",
  }).id;

  it("has the nine link columns of the wiki table, in its order", () => {
    assert.deepEqual(WIKI_COLUMNS.map((c) => c.label), ["Facebook", "Twitter", "Mastodon", "Bluesky", "LinkedIn", "Instagram", "Threads", "TikTok", "Reddit"]);
  });

  it("makes the whole row: day, subject, a link per platform, and the YouTube and G2G cell", () => {
    const id = post(
      "❓#QuestionOfTheWeek Do you have German roots? 🇩🇪\n\nhttps://youtube.com/shorts/CArvcSM3mck\n\nTell us!\n\nhttps://wikitree.com/g2g/2089463\n\n#Genealogy",
      [
        [fb, "https://www.facebook.com/WikiTreeOfficial/posts/1774553328007927"],
        [tw, "https://x.com/WikiTreers/status/2109761122807202258"],
        [mast, "https://genealysis.social/@wikitree/117429928818619019"],
        [bsky, "https://bsky.app/profile/wikitree.bsky.social/post/3mxpfp6kna72q"],
        [li, "https://www.linkedin.com/feed/update/urn:li:share:7515527630050324480/"],
        [ig, "https://www.instagram.com/p/DeaGGuekZ7C/"],
        [th, "https://www.threads.net/@wikitreers/post/DeaI_XGgYba"],
        [tk, "https://www.tiktok.com/@wikitreers/video/7695885625634917646"],
        [rd, "https://www.reddit.com/r/wikitree/comments/1x4dn5u/question_of_the_week_dna/"],
      ],
      { templateId: qow, values: { subject: "[[Project:DNA|DNA]] Ethnicity Estimates", image: "Question_of_the_Week-282.png" } },
    );
    const [row] = wikiRows({ postId: id }, { tz: TZ });
    assert.equal(
      row.text,
      [
        "|-",
        "|Mon",
        "!{{Tag Link|Question_of_the_Week}} [[Project:DNA|DNA]] Ethnicity Estimates<br>[[Image:Question_of_the_Week-282.png|125px]]",
        "|[https://www.facebook.com/WikiTreeOfficial/posts/1774553328007927/ Link]",
        "|[https://twitter.com/WikiTreers/status/2109761122807202258/ Link]",
        "|[https://genealysis.social/@wikitree/117429928818619019/ Link]",
        "|[https://bsky.app/profile/wikitree.bsky.social/post/3mxpfp6kna72q/ Link]",
        "|[https://www.linkedin.com/feed/update/urn:li:share:7515527630050324480/ Link]",
        "|[https://www.instagram.com/p/DeaGGuekZ7C/ Link]",
        "|[https://www.threads.net/@wikitreers/post/DeaI_XGgYba/ Link]",
        "|[https://www.tiktok.com/@wikitreers/video/7695885625634917646/ Link]",
        "|[https://www.reddit.com/r/wikitree/comments/1x4dn5u/ Link]",
        "|{{YouTube|CArvcSM3mck|playlist=QuestionOfTheWeek}}<br>{{G2GLink|2089463}}",
      ].join("\n"),
    );
    assert.deepEqual([row.missingLinks, row.blanks], [[], []]);
  });

  it("reads the day in the time zone you give it", () => {
    const id = post("late one", [[mast, "https://genealysis.social/@wikitree/1"]], { at: "2026-10-13T03:00:00.000Z" }); // Monday evening in California
    assert.equal(wikiRows({ postId: id }, { tz: TZ })[0].text.split("\n")[1], "|Mon");
    assert.equal(wikiRows({ postId: id }, { tz: "Asia/Tokyo" })[0].text.split("\n")[1], "|Tue");
    assert.throws(() => wikiRows({ postId: id }, { tz: "Not/AZone" }), /time zone/);
  });

  it("says which blanks in the subject still need an answer, and fills them when given", () => {
    const id = post("no values saved", [[mast, "https://genealysis.social/@wikitree/2"]], { templateId: qow });
    const [open] = wikiRows({ postId: id }, { tz: TZ });
    assert.deepEqual(open.blanks.sort(), ["image", "subject"]);
    assert.match(open.text, /\{\{subject\}\}/, "left showing so it can't be missed");
    const [filled] = wikiRows({ postId: id }, { tz: TZ, values: { Subject: "Germany", image: "Q-1.png" } });
    assert.deepEqual(filled.blanks, []);
    assert.match(filled.text, /!\{\{Tag Link\|Question_of_the_Week\}\} Germany<br>\[\[Image:Q-1\.png\|125px\]\]/);
  });

  it("colors the row for a template that has a color, and leaves the others plain", () => {
    const green = createTemplate({ name: "Saturday Roundup", body: "x", wikiSubject: "{{Tag Link|Saturday_Roundup}}", wikiStyle: "background:#90C73F;" }).id;
    const id = post("Tune in", [[mast, "https://genealysis.social/@wikitree/3"]], { templateId: green });
    assert.equal(wikiRows({ postId: id }, { tz: TZ })[0].text.split("\n")[0], '|- style="background:#90C73F;"');
    const plainRow = post("no template", [[mast, "https://genealysis.social/@wikitree/4"]]);
    assert.equal(wikiRows({ postId: plainRow }, { tz: TZ })[0].text.split("\n")[0], "|-");
  });

  it("uses the post's first line as the subject when there is no template, and keeps wiki markup out of it", () => {
    const id = post("First line | with [a bar] and {braces}\nsecond", [[mast, "https://genealysis.social/@wikitree/5"]]);
    const lines = wikiRows({ postId: id }, { tz: TZ })[0].text.split("\n");
    assert.equal(lines[2], "|First line &#124; with &#91;a bar&#93; and &#123;braces&#125;");
    assert.equal(lines.at(-1), "|{{G2GLink|}}", "an empty G2G cell, as on the page, to fill in");
  });

  it("puts a playlist embed in the last cell even before there is a video, as the page does for Connection Checkers", () => {
    const cc = createTemplate({ name: "CC: Connection Checkers", body: "x", wikiSubject: "{{Tag Link|Connection_Checkers}}", wikiPlaylist: "ConnectionCombat" }).id;
    const id = post("This week's checkers https://wikitree.com/g2g/2092662", [[mast, "https://genealysis.social/@wikitree/6"]], { templateId: cc });
    assert.equal(wikiRows({ postId: id }, { tz: TZ })[0].text.split("\n").at(-1), "|{{YouTube||playlist=ConnectionCombat}}<br>{{G2GLink|2092662}}");
  });

  it("puts a YouTube Community post link and an uploaded video in the last cell, in the page's order", () => {
    const id = post("Video day https://wikitree.com/g2g/2090677", [
      [ytCommunity, "https://www.youtube.com/post/UgkxHDcHMsRrd_wWhuNJGF5ge7Xr0TTLJvKs"],
      [yt, "https://www.youtube.com/watch?v=KUeoJZMKZLo"],
    ], { external: { [yt]: "KUeoJZMKZLo" } });
    assert.equal(
      wikiRows({ postId: id }, { tz: TZ })[0].text.split("\n").at(-1),
      "|[https://www.youtube.com/post/UgkxHDcHMsRrd_wWhuNJGF5ge7Xr0TTLJvKs/ Link]<br>{{YouTube|KUeoJZMKZLo}}<br>{{G2GLink|2090677}}",
    );
  });

  it("only uses the Page that has a column, not the project's Page", () => {
    const id = post("Both pages", [[fbProject, "https://www.facebook.com/project/1"], [fb, "https://www.facebook.com/main/2"]]);
    assert.equal(wikiRows({ postId: id }, { tz: TZ })[0].text.split("\n")[3], "|[https://www.facebook.com/main/2/ Link]");
    const only = post("Project page only", [[fbProject, "https://www.facebook.com/project/3"]]);
    assert.equal(wikiRows({ postId: only }, { tz: TZ })[0].text.split("\n")[3], "|", "the project's link has nowhere to go");
  });

  it("tells you which hand-posted channels have no link, instead of quietly leaving a hole", () => {
    const id = post("Posted by hand", [[tw, null], [rd, "https://www.reddit.com/r/wikitree/comments/abc/"]]);
    const [row] = wikiRows({ postId: id }, { tz: TZ });
    assert.deepEqual(row.missingLinks, ["Twitter"]);
    assert.equal(row.text.split("\n")[4], "|", "Twitter's cell is empty");
    assert.equal(row.text.split("\n")[11], "|[https://www.reddit.com/r/wikitree/comments/abc/ Link]");
  });

  it("leaves out posts that haven't been published, and orders rows by date", () => {
    const later = post("Later one", [[mast, "https://genealysis.social/@wikitree/7"]], { at: "2026-11-01T16:00:00.000Z" });
    const earlier = post("Earlier one", [[mast, "https://genealysis.social/@wikitree/8"]], { at: "2026-09-01T16:00:00.000Z" });
    const draft = Number(run("INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at) VALUES ('Not yet', '', '', '', ?, ?)", now, now).lastInsertRowid);
    run("INSERT INTO targets (post_id, account_id, status) VALUES (?, ?, 'scheduled')", draft, mast);
    const all = wikiRows({}, { tz: TZ });
    assert.ok(!all.some((r) => r.postId === draft));
    assert.ok(all.findIndex((r) => r.postId === earlier) < all.findIndex((r) => r.postId === later));
  });

  it("lets the team change which column an account uses, and refuses nonsense", () => {
    const odd = account("mastodon", "Second Mastodon");
    const id = post("Moved", [[odd, "https://example.social/@x/9"]]);
    assert.equal(wikiRows({ postId: id }, { tz: TZ })[0].text.split("\n")[5], "|[https://example.social/@x/9/ Link]", "mastodon by default");
    saveColumnSettings({ [ytCommunity]: "youtube", [odd]: "reddit" });
    assert.equal(wikiRows({ postId: id }, { tz: TZ })[0].text.split("\n")[11], "|[https://example.social/@x/9/ Link]", "now in the Reddit column");
    saveColumnSettings({ [ytCommunity]: "youtube", [odd]: "" });
    assert.ok(!wikiRows({ postId: id }, { tz: TZ })[0].text.includes("example.social"), "or in none");
    assert.throws(() => saveColumnSettings({ [odd]: "myspace" }), /isn't a column/);
    assert.throws(() => saveColumnSettings({ nope: "reddit" }), /isn't a column/);
  });
});

describe("templates made before the wiki settings existed", () => {
  it("get their row layout once, without overwriting anything the team already set", () => {
    run("DELETE FROM templates"); // start clean: the tests above made templates with the same names
    // as they were in a database from before: no wiki fields, and Friday Date Night with no schedule
    const old = (name: string) => Number(run("INSERT INTO templates (name, body, created_at, updated_at) VALUES (?, 'x', 'now', 'now')", name).lastInsertRowid);
    const roundup = old("Saturday Roundup");
    const fdn = old("FDN: Friday Date Night");
    const mine = old("Mbr Q&A: Member Q&A Session");
    run("UPDATE templates SET wiki_style = 'background:red;' WHERE id = ?", mine);

    assert.equal(getSetting("templates_wiki_seeded"), "");
    assert.equal(seedWikiSettings(), 3);
    assert.equal(getTemplate(roundup)!.wikiStyle, "background:#90C73F;");
    assert.equal(getTemplate(roundup)!.wikiPlaylist, "SaturdayRoundup");
    assert.deepEqual(getTemplate(fdn)!.rules.map((r) => `${r.nth}:${r.weekday}`), ["2:5", "4:5"], "2nd and 4th Friday, as the page shows");
    assert.equal(getTemplate(mine)!.wikiStyle, "background:red;", "what the team had set is kept");
    assert.match(getTemplate(mine)!.wikiSubject, /New_Member_Q_and_A_via_Zoom/);

    run("UPDATE templates SET wiki_subject = '' WHERE id = ?", roundup);
    assert.equal(seedWikiSettings(), 0, "and never again");
    assert.equal(getTemplate(roundup)!.wikiSubject, "");
    assert.ok(listTemplates().length >= 3);
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manual-provider-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;
const { manual, manualUrl } = await import("../src/providers/manual.ts");
const { connectors } = await import("../src/connectors/index.ts");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("manual accounts as stand-ins for X, Reddit and the YouTube Community tab", () => {
  it("opens X's own composer already filled in, with the text safely encoded", () => {
    const url = manualUrl(
      { url: "https://x.com/intent/post?text={text}" },
      { text: "Join us & help! #WikiTree https://www.wikitree.com/g2g/1?a=b&c=d\nLine two", title: "" },
    );
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("text"), "Join us & help! #WikiTree https://www.wikitree.com/g2g/1?a=b&c=d\nLine two");
    assert.equal(parsed.searchParams.get("c"), null, "the link's own & must not leak out as a separate parameter");
  });

  it("opens Reddit's submit page with the title and text filled in", () => {
    const url = manualUrl(
      { url: "https://www.reddit.com/r/wikitree/submit?type=TEXT&title={title}&text={text}" },
      { text: "Body", title: "Smith One Name Study showcase" },
    );
    assert.equal(new URL(url).searchParams.get("title"), "Smith One Name Study showcase");
    assert.equal(new URL(url).searchParams.get("text"), "Body");
  });

  it("leaves a plain address (such as the YouTube Community page) alone", () => {
    assert.equal(manualUrl({ url: "https://www.youtube.com/@WikiTreers/community" }, { text: "x", title: "y" }), "https://www.youtube.com/@WikiTreers/community");
  });

  it("enforces an optional character limit and counts links like X when asked", async () => {
    const { config } = await manual.connect({ url: "https://x.com/intent/post?text={text}", maxChars: "280", countLikeX: true });
    assert.equal(manual.textLimit(config), 280);
    const post = `Read this ${"https://www.wikitree.com/genealogy/SMITH/".repeat(2)}`;
    assert.equal(manual.countText(post, config), "Read this ".length + 23, "a long link counts as 23, as on X");
    assert.ok(manual.countText(post, { ...config, countLikeX: false }) > 80, "without the option it's a plain count");
  });

  it("defaults to a generous limit, and rejects a nonsense one", async () => {
    const { config } = await manual.connect({ url: "https://example.com" });
    assert.equal(manual.textLimit(config), 5000);
    await assert.rejects(() => manual.connect({ url: "https://example.com", maxChars: "lots" }), /whole number/);
    await assert.rejects(() => manual.connect({ url: "https://example.com", maxChars: "0" }), /whole number/);
  });

  it("asks for a title only on accounts marked as needing one", async () => {
    assert.equal(manual.needsTitleFor!({ url: "https://www.reddit.com/r/wikitree/submit", usesTitle: true }), "required");
    assert.equal(manual.needsTitleFor!({ url: "https://x.com" }), undefined);
    assert.equal(manual.titleLimit!({}), 300);
  });
});

describe("what's shown first in Settings", () => {
  it("keeps the platforms the team posts to up front and tucks the paid ones under More", () => {
    const front = connectors.filter((c) => !c.optional).map((c) => c.id);
    const more = connectors.filter((c) => c.optional).map((c) => c.id);
    assert.deepEqual(front, ["meta", "threads", "linkedin", "google"]);
    assert.deepEqual(more.sort(), ["reddit", "tiktok", "x"]);
  });
});

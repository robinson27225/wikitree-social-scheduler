import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import { startFake, type Fake, type Req } from "./fake.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { linkedin, linkedinText, LINKEDIN_VERSION } = await import("../src/providers/linkedin.ts");
const { linkedinConnector } = await import("../src/connectors/linkedin.ts");
const connect = await import("../src/connect.ts");
const { all, setJsonSetting } = await import("../src/db.ts");

const square = path.join(dir, "square.png");
const mov = path.join(dir, "clip.mov");
const mp4 = path.join(dir, "clip.mp4");
const tiny = path.join(dir, "tiny.mp4");
const input = (over: Record<string, unknown> = {}) => ({
  text: "Hello world",
  title: "",
  altText: "",
  mediaPath: null as string | null,
  mediaKind: null as "image" | "video" | null,
  idempotencyKey: "k",
  ...over,
});
const q = (s: string) => new URLSearchParams(s);

before(async () => {
  await sharp({ create: { width: 1200, height: 628, channels: 3, background: "#0a66c2" } }).png().toFile(square);
  fs.writeFileSync(mov, Buffer.alloc(200_000, 1));
  fs.writeFileSync(mp4, Buffer.alloc(9_000_000, 2)); // 3 pieces of 4 MB
  fs.writeFileSync(tiny, Buffer.alloc(1000, 3));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("LinkedIn post text", () => {
  it("escapes the characters LinkedIn treats as formatting, so nothing is cut short", () => {
    assert.equal(linkedinText("Plain text, nothing special."), "Plain text, nothing special.");
    assert.equal(linkedinText("Trees (and roots) [here] {now}"), "Trees \\(and roots\\) \\[here\\] \\{now\\}");
    assert.equal(linkedinText("a|b @name <b> *x* _y_ ~z~ back\\slash"), "a\\|b \\@name \\<b\\> \\*x\\* \\_y\\_ \\~z\\~ back\\\\slash");
  });

  it("keeps real hashtags as hashtags, but escapes a # anywhere else", () => {
    assert.equal(linkedinText("Join #WikiTree and #familyhistory!"), "Join #WikiTree and #familyhistory!");
    assert.equal(linkedinText("#First word"), "#First word");
    assert.equal(linkedinText("Page 5 # of 9"), "Page 5 \\# of 9");
    assert.equal(linkedinText("https://example.com/page#section"), "https://example.com/page\\#section");
  });

  it("leaves newlines, emoji and accented letters alone", () => {
    assert.equal(linkedinText("Line one\n\nLíne twö 🌳"), "Line one\n\nLíne twö 🌳");
  });
});

describe("LinkedIn posting", () => {
  let li: Fake;
  let failPosts: { status: number; message: string } | null = null;
  const config = () => ({
    apiBase: li.base,
    authBase: li.base,
    accessToken: "TOKEN",
    organizationId: "5515715",
    organizationName: "WikiTree",
    tokenExpiresAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
  });
  const etags: string[] = [];

  before(async () => {
    li = await startFake((req: Req) => {
      if (req.path === "/rest/posts" && req.method === "POST") {
        if (failPosts) return { status: failPosts.status, json: { message: failPosts.message, status: failPosts.status } };
        return { status: 201, headers: { "x-restli-id": "urn:li:share:6844785523593134080" }, json: {} };
      }
      if (req.path === "/rest/images" && req.url.includes("initializeUpload")) {
        return { json: { value: { uploadUrl: `${li.base}/upload/image1`, image: "urn:li:image:IMG1" } } };
      }
      if (req.path === "/upload/image1" && req.method === "PUT") return { status: 201, json: {} };
      if (req.path === "/rest/videos" && req.url.includes("initializeUpload")) {
        const size = req.json().initializeUploadRequest.fileSizeBytes as number;
        const instructions: object[] = [];
        for (let first = 0, n = 0; first < size; first += 4194304, n++) {
          instructions.push({ firstByte: first, lastByte: Math.min(first + 4194303, size - 1), uploadUrl: `${li.base}/upload/video/${n}` });
        }
        return { json: { value: { video: "urn:li:video:VID1", uploadToken: "UT1", uploadInstructions: instructions } } };
      }
      if (req.path.startsWith("/upload/video/") && req.method === "PUT") {
        const etag = `/ambry/part-${req.path.split("/").pop()}.bin`;
        etags.push(etag);
        return { headers: { etag }, json: {} };
      }
      if (req.path === "/rest/videos" && req.url.includes("finalizeUpload")) return { json: {} };
      if (req.path.startsWith("/rest/videos/")) return { json: { status: "AVAILABLE" } };
      if (req.path === "/oauth/v2/introspectToken") {
        const token = req.form().get("token");
        if (token === "TOKEN" || token === "NEW-TOKEN") return { json: { active: true, scope: "w_organization_social,r_organization_social", expires_at: Math.floor(Date.now() / 1000) + 5_000_000 } };
        if (token === "NOPOST") return { json: { active: true, scope: "r_basicprofile", expires_at: Math.floor(Date.now() / 1000) + 5_000_000 } };
        return { json: { active: false } };
      }
      if (req.path === "/oauth/v2/accessToken") {
        const form = req.form();
        if (form.get("grant_type") === "refresh_token") return { json: { access_token: "RENEWED", expires_in: 5_184_000, refresh_token: "REFRESH2", refresh_token_expires_in: 31_536_000 } };
        return { json: { access_token: "NEW-TOKEN", expires_in: 5_184_000 } };
      }
      if (req.path === "/rest/organizations/5515715") return { json: { localizedName: "WikiTree" } };
      return { status: 404, json: { message: "no route" } };
    });
  });
  after(() => li.close());

  it("posts text as the Page, with the version and protocol headers LinkedIn requires", async () => {
    li.requests.length = 0;
    const result = await linkedin.publish(config(), input({ text: "Trees (and roots) #WikiTree" }));
    assert.equal(result.url, "https://www.linkedin.com/feed/update/urn:li:share:6844785523593134080/");
    assert.equal(result.id, "urn:li:share:6844785523593134080");
    const req = li.to("/rest/posts")[0];
    assert.equal(req.headers.authorization, "Bearer TOKEN");
    assert.equal(req.headers["linkedin-version"], LINKEDIN_VERSION);
    assert.equal(req.headers["x-restli-protocol-version"], "2.0.0");
    const body = req.json();
    assert.equal(body.author, "urn:li:organization:5515715");
    assert.equal(body.commentary, "Trees \\(and roots\\) #WikiTree");
    assert.equal(body.visibility, "PUBLIC");
    assert.equal(body.lifecycleState, "PUBLISHED");
    assert.equal(body.content, undefined, "a text post has no media");
  });

  it("uploads a picture, then posts it with its alt text", async () => {
    li.requests.length = 0;
    await linkedin.publish(config(), input({ mediaPath: square, mediaKind: "image", altText: "A blue banner" }));
    assert.equal(li.to("/rest/images")[0].json().initializeUploadRequest.owner, "urn:li:organization:5515715");
    const upload = li.to("/upload/image1")[0];
    assert.equal(upload.method, "PUT");
    assert.ok(upload.body.length > 1000, "the picture's bytes were sent");
    assert.deepEqual(li.to("/rest/posts")[0].json().content.media, { id: "urn:li:image:IMG1", altText: "A blue banner" });
  });

  it("uploads a video in the pieces LinkedIn asks for, hands the ETags back in order, and posts it", async () => {
    li.requests.length = 0;
    etags.length = 0;
    await linkedin.publish(config(), input({ mediaPath: mp4, mediaKind: "video", title: "My clip" }));
    assert.equal(li.to("/rest/videos").find((r) => r.url.includes("initializeUpload"))!.json().initializeUploadRequest.fileSizeBytes, 9_000_000);
    const parts = li.requests.filter((r) => r.path.startsWith("/upload/video/"));
    assert.deepEqual(parts.map((p) => p.body.length), [4194304, 4194304, 9_000_000 - 2 * 4194304]);
    const finalize = li.to("/rest/videos").find((r) => r.url.includes("finalizeUpload"))!.json().finalizeUploadRequest;
    assert.deepEqual(finalize, { video: "urn:li:video:VID1", uploadToken: "UT1", uploadedPartIds: etags });
    assert.equal(etags.length, 3);
    assert.deepEqual(li.to("/rest/posts")[0].json().content.media, { id: "urn:li:video:VID1", title: "My clip" });
  });

  it("says what LinkedIn said when it refuses, and how to fix the common cases", async () => {
    failPosts = { status: 403, message: "Not enough permissions to access: partnerApiPostsExternal.CREATE.NO_VERSION" };
    await assert.rejects(() => linkedin.publish(config(), input()), /LinkedIn post failed \(403\).*Not enough permissions.*administrator of the Page/);
    failPosts = { status: 401, message: "Invalid access token" };
    await assert.rejects(() => linkedin.publish(config(), input()), /Reconnect LinkedIn in Settings/);
    failPosts = { status: 422, message: "Content is a duplicate" };
    await assert.rejects(() => linkedin.publish(config(), input()), /Content is a duplicate/);
    failPosts = null;
  });

  it("refuses to post with an expired sign-in, and says to reconnect", async () => {
    li.requests.length = 0;
    const old = { ...config(), tokenExpiresAt: new Date(Date.now() - 1000).toISOString() };
    await assert.rejects(() => linkedin.publish(old, input()), /expired.*Connect for LinkedIn/);
    assert.equal(li.requests.length, 0, "nothing was sent to LinkedIn");
  });

  it("can't hold a schedule, so it is posted by the app at the time", () => {
    assert.equal(linkedin.supportsServerSchedule, undefined);
  });

  it("checks media against LinkedIn's rules", async () => {
    assert.match((await linkedin.validateMedia!(mov, "video", config())) ?? "", /MP4/);
    assert.match((await linkedin.validateMedia!(tiny, "video", config())) ?? "", /75 KB/);
    assert.equal(await linkedin.validateMedia!(mp4, "video", config()), null);
    assert.equal(linkedin.accepts(null, config()), null, "text-only posts are fine");
    assert.equal(linkedin.textLimit(config()), 3000);
  });

  it("checks the sign-in is live and can post as a Page", async () => {
    const withApp = { ...config(), clientId: "CID", clientSecret: "CSECRET" };
    const ok = await linkedin.connect(withApp);
    assert.match(ok.detail, /LinkedIn Page "WikiTree"/);
    await assert.rejects(() => linkedin.connect({ ...withApp, accessToken: "NOPOST" }), /can't post as a Page/);
    await assert.rejects(() => linkedin.connect({ ...withApp, accessToken: "DEAD" }), /no longer active/);
  });

  it("renews itself only when LinkedIn has given the app a refresh token, and only when due", async () => {
    const saved: Record<string, unknown>[] = [];
    const ctx = { saveConfig: (p: Record<string, unknown>) => saved.push(p) };
    const soon = { ...config(), clientId: "CID", clientSecret: "CSECRET", refreshToken: "REFRESH1", tokenExpiresAt: new Date(Date.now() + 3 * 24 * 3_600_000).toISOString() };
    await linkedin.maintain!(soon, ctx);
    assert.equal(saved[0].accessToken, "RENEWED");
    assert.equal(saved[0].refreshToken, "REFRESH2");

    saved.length = 0;
    await linkedin.maintain!({ ...soon, tokenExpiresAt: new Date(Date.now() + 40 * 24 * 3_600_000).toISOString() }, ctx);
    await linkedin.maintain!({ ...soon, refreshToken: undefined }, ctx);
    assert.equal(saved.length, 0, "nothing to do when it isn't due, or when there is no refresh token");
  });

  describe("signing in", () => {
    const app = () => ({ clientId: "CID", clientSecret: "CSECRET", organizationId: "5515715", apiBase: li.base, authBase: li.base });

    it("sends the person to LinkedIn with the app, redirect, state and permissions", async () => {
      const { url } = await linkedinConnector.start(app(), "https://wikitree-social-scheduler.fly.dev/oauth/callback/linkedin", "STATE1");
      const u = new URL(url);
      assert.equal(u.pathname, "/oauth/v2/authorization");
      assert.equal(u.searchParams.get("response_type"), "code");
      assert.equal(u.searchParams.get("client_id"), "CID");
      assert.equal(u.searchParams.get("state"), "STATE1");
      assert.equal(u.searchParams.get("scope"), "w_organization_social r_organization_social");
      assert.equal(u.searchParams.get("redirect_uri"), "https://wikitree-social-scheduler.fly.dev/oauth/callback/linkedin");
    });

    it("insists on a numeric Page ID before sending anyone anywhere", async () => {
      await assert.rejects(() => linkedinConnector.start({ ...app(), organizationId: "wikitree" }, "https://x/cb", "S"), /numeric ID/);
      await assert.rejects(() => linkedinConnector.start({ ...app(), organizationId: "" }, "https://x/cb", "S"), /numeric ID/);
      const ok = await linkedinConnector.start({ ...app(), organizationId: "urn:li:organization:5515715" }, "https://x/cb", "S");
      assert.ok(ok.url);
    });

    it("turns the sign-in code into the Page, with its name and when the sign-in ends", async () => {
      li.requests.length = 0;
      const [found] = await linkedinConnector.finish(app(), "https://x/cb", q("code=CODE&state=S"), {});
      assert.equal(found.kind, "linkedin");
      assert.equal(found.label, "WikiTree (LinkedIn)");
      assert.equal(found.config.organizationId, "5515715");
      assert.equal(found.config.accessToken, "NEW-TOKEN");
      assert.ok(Date.parse(String(found.config.tokenExpiresAt)) - Date.now() > 59 * 24 * 3_600_000, "about 60 days");
      const exchange = li.to("/oauth/v2/accessToken")[0].form();
      assert.equal(exchange.get("grant_type"), "authorization_code");
      assert.equal(exchange.get("client_secret"), "CSECRET");
      assert.equal(exchange.get("redirect_uri"), "https://x/cb");
    });

    it("still works when LinkedIn won't say the Page's name", async () => {
      const [found] = await linkedinConnector.finish({ ...app(), organizationId: "999" }, "https://x/cb", q("code=C&state=S"), {});
      assert.equal(found.label, "Page 999 (LinkedIn)");
    });

    it("explains a refusal on LinkedIn's page", async () => {
      await assert.rejects(() => linkedinConnector.finish(app(), "https://x/cb", q("error=user_cancelled_authorize&state=S"), {}), /cancelled or refused/);
    });

    it("accepts a pasted token only if it is live and may post as a Page", async () => {
      const [found] = await linkedinConnector.finishWithToken!(app(), "  TOKEN  ");
      assert.equal(found.config.accessToken, "TOKEN");
      assert.ok(Date.parse(String(found.config.tokenExpiresAt)) > Date.now());
      await assert.rejects(() => linkedinConnector.finishWithToken!(app(), "NOPOST"), /w_organization_social/);
      await assert.rejects(() => linkedinConnector.finishWithToken!(app(), "DEAD"), /isn't active/);
      await assert.rejects(() => linkedinConnector.finishWithToken!(app(), "  "), /Paste the access token/);
    });
  });

  describe("reconnecting every two months", () => {
    it("updates the existing LinkedIn account instead of adding a duplicate, and keeps its name", async () => {
      setJsonSetting("app:linkedin", { clientId: "CID", clientSecret: "CSECRET", organizationId: "5515715", apiBase: li.base, authBase: li.base });
      async function signIn() {
        const { url } = await connect.startConnect("linkedin", 4173);
        return connect.completeConnect("linkedin", q(`code=C&state=${new URL(url).searchParams.get("state")}`), 4173);
      }
      const first = await connect.addPending(await signIn(), [{ index: 0, label: "WikiTree on LinkedIn" }]);
      assert.equal(first[0].ok, true, JSON.stringify(first));
      const again = await connect.addPending(await signIn(), [{ index: 0 }]);
      assert.match(again[0].detail, /^Updated\./);
      const rows = all("SELECT label FROM accounts WHERE kind = 'linkedin'");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].label, "WikiTree on LinkedIn");
    });

    it("never shows the client secret or token to the browser", () => {
      const view = JSON.stringify(connect.connectorViews(4173).find((c) => c.id === "linkedin"));
      assert.ok(!view.includes("CSECRET"));
    });
  });
});

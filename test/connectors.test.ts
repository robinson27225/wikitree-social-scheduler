import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startFake, type Fake } from "./fake.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connectors-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { meta } = await import("../src/connectors/meta.ts");
const { threadsConnector } = await import("../src/connectors/threads.ts");
const { xConnector } = await import("../src/connectors/x.ts");
const { google } = await import("../src/connectors/google.ts");
const { tiktokConnector } = await import("../src/connectors/tiktok.ts");
const { redditConnector } = await import("../src/connectors/reddit.ts");
const connect = await import("../src/connect.ts");
const { all, setJsonSetting } = await import("../src/db.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));
const q = (s: string) => new URLSearchParams(s);

describe("Facebook and Instagram sign-in", () => {
  let graph: Fake;
  let pages: unknown[] = [];
  const app = () => ({ appId: "APP", appSecret: "SECRET", graphBase: graph.base, dialogBase: "https://www.facebook.com/v25.0" });

  before(async () => {
    graph = await startFake((req) => {
      if (req.path === "/oauth/access_token") {
        return req.url.includes("fb_exchange_token") ? { json: { access_token: "LONG" } } : { json: { access_token: "SHORT" } };
      }
      if (req.path === "/me/accounts") return { json: { data: pages } };
      return { status: 404, json: { error: { message: "no route" } } };
    });
  });
  after(() => graph.close());

  it("builds the Facebook sign-in link with the app, redirect, state and permissions", async () => {
    const { url } = await meta.start({ ...app(), scopes: "pages_show_list,pages_manage_posts" }, "http://localhost:4173/oauth/callback/meta", "STATE1");
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, "https://www.facebook.com/v25.0/dialog/oauth");
    assert.equal(u.searchParams.get("client_id"), "APP");
    assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:4173/oauth/callback/meta");
    assert.equal(u.searchParams.get("state"), "STATE1");
    assert.equal(u.searchParams.get("scope"), "pages_show_list,pages_manage_posts");
  });

  it("finds every Page, and the Instagram account linked to each", async () => {
    pages = [
      { id: "P1", name: "WikiTree Official", access_token: "PT1", instagram_business_account: { id: "IG1", username: "wikitreers" } },
      { id: "P2", name: "US Black Heritage Project", access_token: "PT2" },
      { id: "P3", name: "WikiTree Week", access_token: "PT3" },
    ];
    graph.requests.length = 0;
    const found = await meta.finish(app(), "http://localhost:4173/oauth/callback/meta", q("code=CODE&state=S"), {});
    assert.deepEqual(found.map((f) => `${f.kind}:${f.label}`), [
      "facebook:WikiTree Official (Facebook)",
      "instagram:@wikitreers (Instagram)",
      "facebook:US Black Heritage Project (Facebook)",
      "facebook:WikiTree Week (Facebook)",
    ]);
    assert.equal(found[0].config.pageToken, "PT1");
    assert.equal(found[1].config.igUserId, "IG1");
    assert.equal(found[1].config.pageToken, "PT1", "Instagram posts with its Page's token");

    // The long-lived exchange is what makes the Page tokens non-expiring.
    const exchange = graph.requests.find((r) => r.url.includes("fb_exchange_token"))!;
    assert.match(exchange.url, /fb_exchange_token=SHORT/);
    assert.match(graph.to("/me/accounts")[0].url, /access_token=LONG/);
  });

  it("explains what to do when Facebook shares no Pages", async () => {
    pages = [];
    await assert.rejects(() => meta.finish(app(), "x", q("code=C"), {}), /shared no Pages.*tick every Page/);
  });

  it("explains a refusal in plain words", async () => {
    await assert.rejects(() => meta.finish(app(), "x", q("error=access_denied&error_description=nope"), {}), /cancelled or refused/);
    await assert.rejects(() => meta.finish(app(), "x", q(""), {}), /didn't send back a sign-in code/);
  });
});

describe("Threads sign-in", () => {
  it("exchanges the code for a long-lived token and reads the profile", async () => {
    const api = await startFake((req) => {
      if (req.path === "/oauth/access_token") return { json: { access_token: "SHORT", user_id: 77 } };
      if (req.path === "/access_token") return { json: { access_token: "LONG", expires_in: 5_184_000 } };
      if (req.path === "/v1.0/me") return { json: { id: "77", username: "wikitree" } };
      return { status: 404 };
    });
    try {
      const found = await threadsConnector.finish({ appId: "A", appSecret: "S", graphBase: api.base }, "http://localhost:4173/oauth/callback/threads", q("code=CODE%23_"), {});
      assert.equal(found[0].kind, "threads");
      assert.equal(found[0].config.threadsUserId, "77");
      assert.equal(found[0].config.accessToken, "LONG");
      assert.ok(Date.parse(String(found[0].config.tokenExpiresAt)) > Date.now() + 50 * 86_400_000);
      assert.equal(api.to("/oauth/access_token")[0].form().get("code"), "CODE", 'Threads\' trailing "#_" must be removed');
      assert.match(api.to("/access_token")[0].url, /grant_type=th_exchange_token/);
    } finally {
      api.close();
    }
  });
});

describe("X sign-in (OAuth 1.0a)", () => {
  it("gets a request token with the callback, then trades the verifier for the account's token", async () => {
    const api = await startFake((req) => {
      if (req.path === "/oauth/request_token") return { raw: "oauth_token=RT&oauth_token_secret=RS&oauth_callback_confirmed=true" };
      if (req.path === "/oauth/access_token") return { raw: "oauth_token=AT&oauth_token_secret=AS&user_id=42&screen_name=WTChallenge" };
      return { status: 404 };
    });
    try {
      const app = { consumerKey: "CK", consumerSecret: "CS", apiBase: api.base, authorizeBase: "https://api.x.com" };
      const started = await xConnector.start(app, "http://127.0.0.1:4173/oauth/callback/x", "unused");
      assert.equal(started.key, "RT", "X comes back with oauth_token, not state");
      assert.deepEqual(started.session, { tokenSecret: "RS" });
      assert.equal(started.url, "https://api.x.com/oauth/authorize?oauth_token=RT");
      const startAuth = String(api.to("/oauth/request_token")[0].headers.authorization);
      assert.match(startAuth, /oauth_callback="http%3A%2F%2F127\.0\.0\.1%3A4173%2Foauth%2Fcallback%2Fx"/);

      const found = await xConnector.finish(app, "x", q("oauth_token=RT&oauth_verifier=VER"), started.session!);
      const finishAuth = String(api.to("/oauth/access_token")[0].headers.authorization);
      assert.match(finishAuth, /oauth_verifier="VER"/);
      assert.match(finishAuth, /oauth_token="RT"/);
      assert.deepEqual(
        [found[0].kind, found[0].label, found[0].config.token, found[0].config.tokenSecret, found[0].config.username],
        ["x", "@WTChallenge (X)", "AT", "AS", "WTChallenge"],
      );
      await assert.rejects(() => xConnector.finish(app, "x", q("denied=RT"), {}), /cancelled or refused/);
    } finally {
      api.close();
    }
  });
});

describe("YouTube, TikTok and Reddit sign-in", () => {
  it("YouTube needs a lasting (refresh) token and finds the channel", async () => {
    let refresh: string | undefined = "REFRESH";
    const api = await startFake((req) => {
      if (req.path === "/token") return { json: { access_token: "AT", refresh_token: refresh, expires_in: 3600 } };
      if (req.path === "/youtube/v3/channels") return { json: { items: [{ id: "UC1", snippet: { title: "WikiTreers" } }] } };
      return { status: 404 };
    });
    try {
      const app = { clientId: "C", clientSecret: "S", tokenUrl: `${api.base}/token`, apiBase: api.base };
      const found = await google.finish(app, "http://localhost:4173/oauth/callback/google", q("code=C"), {});
      assert.equal(found[0].config.refreshToken, "REFRESH");
      assert.equal(found[0].config.channelId, "UC1");
      assert.equal(found[0].extraFields![0].name, "privacy");
      refresh = undefined;
      await assert.rejects(() => google.finish(app, "x", q("code=C"), {}), /didn't grant lasting access/);

      const start = new URL((await google.start({ clientId: "C", clientSecret: "S" }, "http://localhost:4173/oauth/callback/google", "ST")).url);
      assert.equal(start.searchParams.get("access_type"), "offline");
      assert.equal(start.searchParams.get("prompt"), "consent");
      assert.match(start.searchParams.get("scope")!, /youtube\.upload/);
    } finally {
      api.close();
    }
  });

  it("TikTok keeps both tokens' expiry and defaults to private posting", async () => {
    const api = await startFake((req) => {
      if (req.path === "/v2/oauth/token/") return { json: { access_token: "AT", refresh_token: "RT", open_id: "OPEN", expires_in: 86400, refresh_expires_in: 31_536_000 } };
      if (req.path === "/v2/user/info/") return { json: { data: { user: { display_name: "WikiTree" } } } };
      return { status: 404 };
    });
    try {
      const found = await tiktokConnector.finish({ clientKey: "K", clientSecret: "S", apiBase: api.base }, "https://localhost:4173/cb", q("code=a%2Fb"), {});
      assert.equal(found[0].config.openId, "OPEN");
      assert.equal(found[0].config.displayName, "WikiTree");
      assert.equal(found[0].extraFields!.find((f) => f.name === "privacyLevel")!.default, "SELF_ONLY");
      assert.equal(api.to("/v2/oauth/token/")[0].form().get("code"), "a/b", "the URL-encoded code is decoded");
    } finally {
      api.close();
    }
  });

  it("Reddit asks which subreddit and gets a permanent token", async () => {
    const api = await startFake((req) => {
      if (req.path === "/api/v1/access_token") return { json: { access_token: "AT", refresh_token: "RT", expires_in: 3600 } };
      if (req.path === "/api/v1/me") return { json: { name: "wikitreers" } };
      return { status: 404 };
    });
    try {
      const app = { clientId: "C", clientSecret: "S", authBase: api.base, oauthBase: api.base };
      const found = await redditConnector.finish(app, "http://localhost:4173/oauth/callback/reddit", q("code=C%23_"), {});
      assert.equal(found[0].config.username, "wikitreers");
      assert.equal(found[0].extraFields![0].required, true);
      assert.equal(api.to("/api/v1/access_token")[0].form().get("code"), "C");
      const start = new URL((await redditConnector.start({ clientId: "C", clientSecret: "S" }, "r", "ST")).url);
      assert.equal(start.searchParams.get("duration"), "permanent");
    } finally {
      api.close();
    }
  });
});

describe("the connect manager (state, secrets, de-duplication)", () => {
  let graph: Fake;
  before(async () => {
    graph = await startFake((req) => {
      if (req.path === "/oauth/access_token") return { json: { access_token: req.url.includes("fb_exchange") ? "LONG" : "SHORT" } };
      if (req.path === "/me/accounts") {
        return { json: { data: [{ id: "P1", name: "WikiTree Official", access_token: "PT-secret", instagram_business_account: { id: "IG1", username: "wikitreers" } }] } };
      }
      if (req.path === "/P1") return { json: { name: "WikiTree Official" } };
      if (req.path === "/IG1") return { json: { username: "wikitreers" } };
      return { status: 404, json: { error: { message: "no route" } } };
    });
    // Tests point the app at the fake server through settings only the test can write.
    setJsonSetting("app:meta", { appId: "APP", appSecret: "SECRET", graphBase: graph.base });
  });
  after(() => graph.close());

  it("keeps secrets out of what the browser sees, and keeps a saved secret when left blank", () => {
    connect.saveAppCreds("meta", { appId: "NEW-ID", appSecret: "NEW-SECRET" });
    connect.saveAppCreds("meta", { appId: "NEW-ID", appSecret: "" });
    const view = JSON.stringify(connect.connectorViews(4173));
    assert.equal(view.includes("NEW-SECRET"), false);
    assert.equal(connect.appCreds("meta").appSecret, "NEW-SECRET");
    const field = connect.connectorViews(4173).find((c) => c.id === "meta")!.appFields.find((f) => f.name === "appSecret")!;
    assert.equal(field.hasValue, true);
    setJsonSetting("app:meta", { appId: "APP", appSecret: "SECRET", graphBase: graph.base });
  });

  it("won't start until the developer-app details are saved", async () => {
    await assert.rejects(() => connect.startConnect("tiktok", 4173), /Save the Client key and Client secret first/);
  });

  it("rejects a sign-in it didn't start, and a replayed one", async () => {
    await assert.rejects(() => connect.completeConnect("meta", q("code=C&state=bogus"), 4173), /wasn't started here/);
    const { url } = await connect.startConnect("meta", 4173);
    const state = new URL(url).searchParams.get("state")!;
    await connect.completeConnect("meta", q(`code=C&state=${state}`), 4173);
    await assert.rejects(() => connect.completeConnect("meta", q(`code=C&state=${state}`), 4173), /wasn't started here/);
  });

  it("adds the chosen accounts, checks each with its platform, and refreshes instead of duplicating on reconnect", async () => {
    async function signIn() {
      const { url } = await connect.startConnect("meta", 4173);
      return connect.completeConnect("meta", q(`code=C&state=${new URL(url).searchParams.get("state")}`), 4173);
    }
    const token = await signIn();
    const view = connect.pendingView(token);
    assert.deepEqual(view.map((v) => [v.kind, v.alreadyAdded]), [["facebook", false], ["instagram", false]]);
    assert.equal(JSON.stringify(view).includes("PT-secret"), false, "tokens never go to the browser");

    const first = await connect.addPending(token, [{ index: 0, label: "WikiTree Official FB" }, { index: 1 }]);
    assert.deepEqual(first.map((r) => r.ok), [true, true]);
    assert.match(first[0].detail, /WikiTree Official/);
    assert.equal(all("SELECT * FROM accounts").length, 2);
    assert.equal(all("SELECT label FROM accounts WHERE kind = 'facebook'")[0].label, "WikiTree Official FB");

    const again = await connect.addPending(await signIn(), [{ index: 0 }, { index: 1 }]);
    assert.match(again[0].detail, /^Updated\./);
    assert.equal(all("SELECT * FROM accounts").length, 2, "reconnecting must not create duplicates");
    assert.equal(all("SELECT label FROM accounts WHERE kind = 'facebook'")[0].label, "WikiTree Official FB", "and keeps the name you chose");
  });

  it("requires the answers a platform needs (such as the subreddit) before adding", async () => {
    const reddit = await startFake((req) => {
      if (req.path === "/api/v1/access_token") return { json: { access_token: "AT", refresh_token: "RT", expires_in: 3600 } };
      if (req.path === "/api/v1/me") return { json: { name: "wikitreers" } };
      return { status: 404 };
    });
    try {
      setJsonSetting("app:reddit", { clientId: "C", clientSecret: "S", authBase: reddit.base, oauthBase: reddit.base });
      const { url } = await connect.startConnect("reddit", 4173);
      const token = await connect.completeConnect("reddit", q(`code=C&state=${new URL(url).searchParams.get("state")}`), 4173);
      const blank = await connect.addPending(token, [{ index: 0, extra: { subreddit: "" } }]);
      assert.equal(blank[0].ok, false);
      assert.match(blank[0].detail, /Subreddit.*required/);
      const filled = await connect.addPending(token, [{ index: 0, extra: { subreddit: "wikitree" } }]);
      assert.equal(filled[0].ok, true);
      assert.match(filled[0].detail, /r\/wikitree/);
    } finally {
      reddit.close();
    }
  });
});


describe("connecting Facebook and Instagram with a Graph API Explorer token", () => {
  let graph: Fake;
  before(async () => {
    graph = await startFake((req) => {
      if (req.path === "/oauth/access_token") {
        return req.url.includes("fb_exchange_token=EXPLORER-TOKEN")
          ? { json: { access_token: "LONG" } }
          : { status: 400, json: { error: { message: "Invalid OAuth access token." } } };
      }
      if (req.path === "/me/accounts") {
        return { json: { data: [{ id: "P9", name: "WikiTree Week", access_token: "PT9", instagram_business_account: { id: "IG9", username: "wikitreeweek" } }] } };
      }
      return { status: 404, json: { error: { message: "no route" } } };
    });
    setJsonSetting("app:meta", { appId: "1057535013708941", appSecret: "SECRET", graphBase: graph.base });
  });
  after(() => graph.close());

  it("turns the pasted token into permanent Page tokens", async () => {
    const found = await meta.finishWithToken!({ appId: "1057535013708941", appSecret: "SECRET", graphBase: graph.base }, "  EXPLORER-TOKEN \n");
    assert.deepEqual(found.map((f) => f.kind), ["facebook", "instagram"]);
    assert.equal(found[0].config.pageToken, "PT9");
    const exchange = graph.requests.find((r) => r.url.includes("fb_exchange_token"))!;
    assert.match(exchange.url, /client_id=1057535013708941/);
    assert.match(exchange.url, /client_secret=SECRET/);
    assert.match(graph.to("/me/accounts")[0].url, /access_token=LONG/, "Pages are listed with the long-lived token");
  });

  it("explains an empty or rejected token", async () => {
    await assert.rejects(() => meta.finishWithToken!({ appId: "A", appSecret: "S", graphBase: graph.base }, "   "), /Paste the access token/);
    await assert.rejects(() => meta.finishWithToken!({ appId: "A", appSecret: "S", graphBase: graph.base }, "expired"), /Invalid OAuth access token/);
  });

  it("goes through the same choose-and-add step as the sign-in page", async () => {
    const token = await connect.completeWithToken("meta", "EXPLORER-TOKEN");
    const view = connect.pendingView(token);
    assert.deepEqual(view.map((v) => v.label), ["WikiTree Week (Facebook)", "@wikitreeweek (Instagram)"]);
    assert.equal(JSON.stringify(view).includes("PT9"), false, "tokens never go to the browser");
  });

  it("is offered only where it makes sense, and refuses it elsewhere", async () => {
    const views = connect.connectorViews(4173);
    assert.deepEqual(views.filter((v) => v.acceptsToken).map((v) => v.id), ["meta", "threads", "linkedin"]);
    assert.ok(views.filter((v) => v.acceptsToken).every((v) => v.tokenHelp && v.tokenHelp.steps.length > 0), "each one explains how to make the token");
    await assert.rejects(() => connect.completeWithToken("reddit", "whatever"), /can't be connected with a pasted token/);
  });

  it("won't use a token until the app's ID and secret are saved", async () => {
    setJsonSetting("app:meta", {});
    await assert.rejects(() => connect.completeWithToken("meta", "EXPLORER-TOKEN"), /Save the App ID and App secret first/);
  });
});

describe("connecting Threads with a token from Meta's generator", () => {
  let mode: "short" | "long-old" | "long-new" = "short";
  let api: Fake;
  before(async () => {
    api = await startFake((req) => {
      if (req.path === "/v1.0/me") {
        return req.url.includes("access_token=BAD") ? { status: 400, json: { error: { message: "Invalid OAuth access token." } } } : { json: { id: "77", username: "wikitree" } };
      }
      if (req.path === "/access_token") {
        // exchanging only works for a short-lived token
        return mode === "short" ? { json: { access_token: "LONG-FROM-SHORT", expires_in: 5_184_000 } } : { status: 400, json: { error: { message: "already long-lived" } } };
      }
      if (req.path === "/refresh_access_token") {
        // renewing only works for a long-lived token that's over a day old
        return mode === "long-old" ? { json: { access_token: "RENEWED", expires_in: 5_184_000 } } : { status: 400, json: { error: { message: "token must be 24 hours old" } } };
      }
      return { status: 404 };
    });
  });
  after(() => api.close());
  const app = () => ({ appId: "A", appSecret: "S", graphBase: api.base });
  const days = (iso: unknown) => (Date.parse(String(iso)) - Date.now()) / 86_400_000;

  it("upgrades a short-lived token to a long-lived one", async () => {
    mode = "short";
    const [found] = await threadsConnector.finishWithToken!(app(), " SHORT-TOKEN ");
    assert.equal(found.config.accessToken, "LONG-FROM-SHORT");
    assert.equal(found.config.threadsUserId, "77");
    assert.ok(days(found.config.tokenExpiresAt) > 59);
  });

  it("renews a long-lived token that is more than a day old", async () => {
    mode = "long-old";
    const [found] = await threadsConnector.finishWithToken!(app(), "LONG-TOKEN");
    assert.equal(found.config.accessToken, "RENEWED");
    assert.ok(days(found.config.tokenExpiresAt) > 59);
  });

  it("keeps a fresh long-lived token as it is (it can't be renewed in its first day) and assumes a safe expiry", async () => {
    mode = "long-new";
    const [found] = await threadsConnector.finishWithToken!(app(), "FRESH-LONG-TOKEN");
    assert.equal(found.config.accessToken, "FRESH-LONG-TOKEN");
    const d = days(found.config.tokenExpiresAt);
    assert.ok(d > 50 && d < 58, `expected a conservative ~55 days, got ${d.toFixed(1)}`);
  });

  it("rejects an invalid or empty token with a readable message", async () => {
    await assert.rejects(() => threadsConnector.finishWithToken!(app(), "BAD"), /Threads token check failed.*Invalid OAuth access token/);
    await assert.rejects(() => threadsConnector.finishWithToken!(app(), "  "), /Paste the access token/);
  });
});

describe("platforms whose sign-in refuses http addresses", () => {
  it("blocks the Connect button for Threads unless an https redirect address is set, and leaves the others alone", () => {
    setJsonSetting("app:threads", { appId: "A", appSecret: "S" });
    let views = connect.connectorViews(4173);
    assert.equal(views.find((v) => v.id === "threads")!.connectBlocked, true);
    assert.equal(views.find((v) => v.id === "meta")!.connectBlocked, false);
    setJsonSetting("app:threads", { appId: "A", appSecret: "S", redirectUri: "https://localhost:4173/oauth/callback/threads" });
    views = connect.connectorViews(4173);
    assert.equal(views.find((v) => v.id === "threads")!.connectBlocked, false);
  });
});

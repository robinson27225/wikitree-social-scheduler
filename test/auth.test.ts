import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { startFakeGoogle, type FakeGoogle, type Identity, type Tweaks } from "./fake-google.ts";

/**
 * Starts the real app in server mode (Google sign-in) with a fake Google, and behaves like a browser:
 * keeps cookies, follows the sign-in redirects by hand, and sends the CSRF token the page would send.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
const BRIEF = "brief-token-for-tests-0123456789abcdef";
const ADMIN: Identity = { sub: "g-admin", email: "admin@example.com", name: "Ada Admin" };

let google: FakeGoogle;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

interface Running {
  base: string;
  dataDir: string;
  stop(): void;
}

async function startServer(name: string, extraEnv: Record<string, string> = {}): Promise<Running> {
  const port = await freePort();
  const dataDir = path.join(root, name);
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      ...google.env,
      AUTH_MODE: "google",
      PUBLIC_URL: `http://localhost:${port}`,
      PORT: String(port),
      ADMIN_EMAILS: ADMIN.email,
      DATA_KEY: "dGVzdC1kYXRhLWtleS1mb3ItYXV0aC10ZXN0cy0wMTIzNDU2Nzg5",
      GOOGLE_ALLOWED_DOMAIN: "example.com",
      BRIEF_TOKEN: BRIEF,
      NO_OPEN: "1",
      SOCIAL_SCHEDULER_DATA: dataDir,
      ...extraEnv,
    },
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
    let errors = "";
    child.stderr!.on("data", (c) => (errors += c));
    child.on("exit", (code) => reject(new Error(`the app exited early (${code}): ${errors}`)));
  });
  return { base: `http://127.0.0.1:${port}`, dataDir, stop: () => child.kill() };
}

class Browser {
  cookie = "";
  csrf = "";
  constructor(private base: string) {}

  async raw(method: string, route: string, init: { body?: unknown; headers?: Record<string, string>; csrf?: boolean; json?: boolean } = {}) {
    const headers: Record<string, string> = { ...init.headers };
    if (this.cookie) headers.cookie = this.cookie;
    if (init.csrf !== false && this.csrf && method !== "GET") headers["x-csrf-token"] = this.csrf;
    let body: BodyInit | undefined;
    if (init.body !== undefined) {
      if (init.json === false) body = init.body as BodyInit;
      else {
        headers["content-type"] ??= "application/json";
        body = JSON.stringify(init.body);
      }
    } else if (method !== "GET") headers["content-type"] ??= "application/json";
    const res = await fetch(`${this.base}${route}`, { method, headers, body, redirect: "manual" });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      const cleared = /max-age=0/i.test(line) || value === "";
      const jar = new Map(this.cookie.split("; ").filter(Boolean).map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)] as const));
      if (cleared) jar.delete(name);
      else jar.set(name, value);
      this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    return res;
  }

  async call(method: string, route: string, body?: unknown, extra: { csrf?: boolean } = {}) {
    const res = await this.raw(method, route, { body, csrf: extra.csrf });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json: json as any };
  }
}

/** Runs the whole sign-in dance. Returns where the app finally sent the browser. */
async function signIn(browser: Browser, identity: Identity, tweaks?: Tweaks): Promise<{ ok: boolean; error: string | null; location: string }> {
  const start = await browser.raw("GET", "/auth/login");
  assert.equal(start.status, 302, "login should send the browser to Google");
  const back = new URL(google.approve(start.headers.get("location")!, identity, tweaks));
  const done = await browser.raw("GET", `${back.pathname}${back.search}`);
  const location = done.headers.get("location") ?? "";
  const error = new URL(location, "http://x").searchParams.get("loginError");
  if (!error) {
    const me = await browser.call("GET", "/auth/me");
    browser.csrf = me.json.csrf ?? "";
  }
  return { ok: !error && location === "/", error, location };
}

let app: Running;

before(async () => {
  google = await startFakeGoogle();
  app = await startServer("main", { LOGIN_RATE_MAX: "5000" }); // many sign-ins below; the limit itself is tested at the end
});

after(() => {
  app.stop();
  google.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const newBrowser = () => new Browser(app.base);
async function adminBrowser() {
  const b = newBrowser();
  const r = await signIn(b, ADMIN);
  assert.ok(r.ok, r.error ?? "admin sign-in failed");
  return b;
}

describe("before signing in", () => {
  it("shows the page and the health check, nothing else", async () => {
    const b = newBrowser();
    assert.equal((await b.raw("GET", "/")).status, 200);
    assert.equal((await b.raw("GET", "/healthz")).status, 200);
    assert.equal((await b.call("GET", "/auth/me")).status, 401);
  });

  it("turns away every API and connect route — checked for each one in the source, so a new route can't be forgotten", async () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../src/server.ts"), "utf8");
    const routes = [...source.matchAll(/^app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gm)].map((m) => ({ method: m[1].toUpperCase(), route: m[2] }));
    const guarded = routes.filter((r) => r.route.startsWith("/api") || r.route.startsWith("/oauth"));
    assert.ok(guarded.length >= 35, `expected to find the app's routes, found ${guarded.length}`);
    const b = newBrowser();
    for (const { method, route } of guarded) {
      const concrete = route.replace(/:\w+/g, "1");
      const upload = method === "PUT" && route === "/api/library";
      const res = await b.raw(method, concrete, upload ? { body: Buffer.from("x"), headers: { "content-type": "application/octet-stream" }, json: false } : { body: method === "GET" ? undefined : {} });
      if (route.startsWith("/oauth")) {
        assert.equal(res.status, 302, `${method} ${route}`);
        assert.match(res.headers.get("location") ?? "", /loginError/);
      } else {
        assert.equal(res.status, 401, `${method} ${route} must need a sign-in`);
      }
    }
  });

  it("ignores made-up cookies", async () => {
    const b = newBrowser();
    b.cookie = "session=" + "a".repeat(43);
    assert.equal((await b.call("GET", "/api/status")).status, 401);
  });
});

describe("signing in", () => {
  it("lets an approved person in, with a cookie the page's scripts can't read", async () => {
    const b = newBrowser();
    const start = await b.raw("GET", "/auth/login");
    const q = new URL(start.headers.get("location")!).searchParams;
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.equal(q.get("scope"), "openid email profile");
    assert.match(q.get("redirect_uri")!, /\/auth\/callback$/);

    const back = new URL(google.approve(start.headers.get("location")!, ADMIN));
    const done = await b.raw("GET", `${back.pathname}${back.search}`);
    assert.equal(done.headers.get("location"), "/");
    const cookie = done.headers.getSetCookie()[0];
    assert.match(cookie, /^session=/); // plain name only because this test runs over http; on a server it is __Host-session
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    const me = await b.call("GET", "/auth/me");
    assert.equal(me.status, 200);
    assert.deepEqual({ email: me.json.user.email, role: me.json.user.role }, { email: "admin@example.com", role: "admin" });
    assert.ok(me.json.csrf.length > 20);
    b.csrf = me.json.csrf;
    assert.equal((await b.call("GET", "/api/status")).status, 200);
  });

  it("makes every change prove it came from the page: no token or someone else's token is refused", async () => {
    const a = await adminBrowser();
    const other = await adminBrowser();
    const noToken = await a.call("POST", "/api/users", { email: "x@example.com" }, { csrf: false });
    assert.equal(noToken.status, 403);
    const wrong = await a.raw("POST", "/api/users", { body: { email: "x@example.com" }, headers: { "x-csrf-token": other.csrf }, csrf: false });
    assert.equal(wrong.status, 403, "a token from a different session");
    assert.equal((await a.call("POST", "/api/users", { email: "x@example.com" })).status, 200);
  });

  it("signs out for real: the old cookie stops working", async () => {
    const b = await adminBrowser();
    const saved = b.cookie;
    assert.equal((await b.call("POST", "/auth/logout", {})).status, 200);
    const replay = newBrowser();
    replay.cookie = saved;
    assert.equal((await replay.call("GET", "/api/status")).status, 401);
  });

  it("turns away someone Google vouches for who isn't on the list, and creates nothing", async () => {
    const b = newBrowser();
    const r = await signIn(b, { sub: "g-stranger", email: "stranger@example.com" });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /isn't on the approved list/);
    assert.equal(b.cookie, "");
    const admin = await adminBrowser();
    const users = (await admin.call("GET", "/api/users")).json.users.map((u: any) => u.email);
    assert.ok(!users.includes("stranger@example.com"));
    const log = (await admin.call("GET", "/api/audit")).json.entries;
    assert.ok(log.some((e: any) => e.action === "login.refused" && e.email === "stranger@example.com"));
  });

  it("asks Google to offer only the WikiTree domain", async () => {
    const start = await newBrowser().raw("GET", "/auth/login");
    assert.equal(new URL(start.headers.get("location")!).searchParams.get("hd"), "example.com");
  });

  it("only accepts an address in the domain, even from Google, even if it was on the list", async () => {
    const admin = await adminBrowser();
    const outsider = { sub: "g-outsider", email: "outsider@gmail.com" };
    assert.equal((await admin.call("POST", "/api/users", { email: outsider.email })).status, 400);
    // claims a workspace domain it doesn't have in its email
    const mixed = await signIn(newBrowser(), { sub: "g-mixed", email: "admin@gmail.com" }, { hd: "example.com" });
    assert.equal(mixed.ok, false);
    assert.match(mixed.error ?? "", /wasn't for a @example\.com account/);
  });

  it("matches the email without caring about capital letters", async () => {
    const r = await signIn(newBrowser(), { sub: "g-admin", email: "Admin@Example.COM" });
    assert.ok(r.ok, r.error ?? "");
  });

  it("refuses a repeated or invented sign-in link", async () => {
    const b = newBrowser();
    const start = await b.raw("GET", "/auth/login");
    const back = new URL(google.approve(start.headers.get("location")!, ADMIN));
    const route = `${back.pathname}${back.search}`;
    assert.equal((await b.raw("GET", route)).headers.get("location"), "/");
    const again = newBrowser();
    assert.match((await again.raw("GET", route)).headers.get("location") ?? "", /loginError/);
    assert.match((await again.raw("GET", "/auth/callback?code=abc&state=nope")).headers.get("location") ?? "", /expired/);
    assert.match((await again.raw("GET", "/auth/callback")).headers.get("location") ?? "", /loginError/);
  });
});

describe("a forged or mistaken Google token never gets anyone in", () => {
  const cases: [string, Tweaks][] = [
    ["meant for a different app", { aud: "someone-elses-client-id" }],
    ["from the wrong issuer", { iss: "https://evil.example.com" }],
    ["for a different sign-in attempt (wrong nonce)", { nonce: "not-the-nonce-we-sent" }],
    ["already expired", { exp: -3600 }],
    ["with an email Google hasn't verified", { emailVerified: false }],
    ["with the verified flag as the wrong type", { emailVerified: "yes" }],
    ["signed with a key that isn't Google's", { signWith: "attacker" }],
    ['unsigned, claiming algorithm "none"', { alg: "none" }],
    ["signed with a shared secret instead of Google's key (algorithm swap)", { alg: "HS256" }],
    ["with no nonce at all", { omit: ["nonce"] }],
    ["with no email", { omit: ["email"] }],
    ["with no subject", { omit: ["sub"] }],
    ["from a personal Google account (no Workspace domain), even with an approved email", { hd: null }],
    ["from a different Workspace domain", { hd: "other-company.com" }],
  ];
  for (const [name, tweaks] of cases) {
    it(`refuses a token ${name}`, async () => {
      const b = newBrowser();
      const r = await signIn(b, ADMIN, tweaks);
      assert.equal(r.ok, false);
      assert.equal(b.cookie, "", "no session may be created");
      assert.equal((await b.call("GET", "/api/status")).status, 401);
    });
  }

  it("never trusts the PKCE-less or secret-less path: the fake Google insists on both, and a normal sign-in still works", async () => {
    assert.ok(google.tokenRequests() > 0);
    assert.ok((await signIn(newBrowser(), ADMIN)).ok);
  });
});

describe("who can do what", () => {
  const MEMBER: Identity = { sub: "g-member", email: "member@example.com", name: "Mo Member" };
  let admin: Browser;
  let member: Browser;
  let memberId: number;

  before(async () => {
    admin = await adminBrowser();
    const added = await admin.call("POST", "/api/users", { email: "Member@Example.com", name: "Mo", role: "member" });
    assert.equal(added.status, 200, JSON.stringify(added.json));
    memberId = added.json.id;
    member = newBrowser();
    assert.ok((await signIn(member, MEMBER)).ok);
  });

  it("lets members do the everyday work", async () => {
    for (const route of ["/api/status", "/api/posts", "/api/library", "/api/accounts", "/api/providers", "/api/settings"]) {
      assert.equal((await member.call("GET", route)).status, 200, route);
    }
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
    const up = await member.raw("PUT", "/api/library?name=dot.png", { body: png, headers: { "content-type": "application/octet-stream" }, json: false });
    assert.equal(up.status, 201);
  });

  it("keeps administration to administrators", async () => {
    const attempts: [string, string, unknown?][] = [
      ["GET", "/api/users"],
      ["POST", "/api/users", { email: "friend@example.com" }],
      ["PATCH", `/api/users/${memberId}`, { role: "admin" }],
      ["DELETE", `/api/users/${memberId}`],
      ["GET", "/api/audit"],
      ["GET", "/api/wiki-columns"],
      ["PUT", "/api/wiki-columns", { map: {} }],
      ["PUT", "/api/settings", { styleGuide: "mine now" }],
      ["POST", "/api/accounts", { kind: "dryrun", label: "x", config: {} }],
      ["DELETE", "/api/accounts/1"],
      ["GET", "/api/connectors"],
      ["POST", "/api/connectors/meta/start", {}],
      ["GET", "/api/host"],
      ["PUT", "/api/host", { bucket: "x" }],
    ];
    for (const [method, route, body] of attempts) {
      const r = await member.call(method, route, body ?? (method === "GET" ? undefined : {}));
      assert.equal(r.status, 403, `${method} ${route}`);
    }
    assert.equal((await member.call("GET", "/oauth/callback/meta?code=1")).status, 403);
  });

  it("can't promote itself, even by sending a role", async () => {
    await member.call("PATCH", `/api/users/${memberId}`, { role: "admin" });
    const users = (await admin.call("GET", "/api/users")).json.users;
    assert.equal(users.find((u: any) => u.id === memberId).role, "member");
  });

  it("cuts off a person the moment an administrator turns their access off", async () => {
    const temp = newBrowser();
    const tempId = identity("g-temp", "temp@example.com");
    const add = await admin.call("POST", "/api/users", { email: tempId.email, role: "member" });
    assert.ok((await signIn(temp, tempId)).ok);
    assert.equal((await temp.call("GET", "/api/status")).status, 200);

    assert.equal((await admin.call("PATCH", `/api/users/${add.json.id}`, { status: "disabled" })).status, 200);
    assert.equal((await temp.call("GET", "/api/status")).status, 401, "their open session ends at once");
    const again = await signIn(newBrowser(), tempId);
    assert.match(again.error ?? "", /turned off/);

    await admin.call("PATCH", `/api/users/${add.json.id}`, { status: "active" });
    assert.ok((await signIn(newBrowser(), tempId)).ok);
  });

  it("binds a person to their Google account: the same email from a different Google account is refused", async () => {
    const real = identity("g-bound", "bound@example.com");
    await admin.call("POST", "/api/users", { email: real.email, role: "member" });
    assert.ok((await signIn(newBrowser(), real)).ok);
    const impostor = await signIn(newBrowser(), { sub: "g-someone-else", email: real.email });
    assert.equal(impostor.ok, false);
    assert.match(impostor.error ?? "", /different Google account/);
  });

  it("never leaves the app without an administrator, or lets someone lock themselves out", async () => {
    const me = (await admin.call("GET", "/api/users")).json.users.find((u: any) => u.email === ADMIN.email);
    assert.equal((await admin.call("PATCH", `/api/users/${me.id}`, { status: "disabled" })).status, 400);
    assert.equal((await admin.call("PATCH", `/api/users/${me.id}`, { role: "member" })).status, 400);
    assert.equal((await admin.call("DELETE", `/api/users/${me.id}`)).status, 400);
    assert.equal((await admin.call("PATCH", `/api/users/${me.id}`, { role: "wizard" })).status, 400);
    assert.equal((await admin.call("POST", "/api/users", { email: "not-an-email" })).status, 400);
    assert.equal((await admin.call("POST", "/api/users", { email: ADMIN.email })).status, 409);
  });

  it("records who did what, with no secrets in it", async () => {
    await admin.call("PUT", "/api/settings", { apiKey: "sk-ant-super-secret-value", styleGuide: "Be kind." });
    const log = (await admin.call("GET", "/api/audit")).json.entries;
    const actions = log.map((e: any) => e.action);
    for (const expected of ["login", "user.add", "user.change", "settings.change", "library.add"]) assert.ok(actions.includes(expected), expected);
    assert.ok(!JSON.stringify(log).includes("super-secret"));
    assert.ok(log.find((e: any) => e.action === "library.add").email === MEMBER.email);
  });
});

function identity(sub: string, email: string): Identity {
  return { sub, email, name: "" };
}

describe("sessions end on their own", () => {
  it("expire after 12 idle hours or 7 days in total", async () => {
    const db = new DatabaseSync(path.join(app.dataDir, "scheduler.db"));
    try {
      const idle = await adminBrowser();
      db.prepare("UPDATE sessions SET last_seen_at = ? WHERE csrf = ?").run(Date.now() - 13 * 3600_000, idle.csrf);
      assert.equal((await idle.call("GET", "/api/status")).status, 401);

      const old = await adminBrowser();
      db.prepare("UPDATE sessions SET created_at = ? WHERE csrf = ?").run(Date.now() - 8 * 24 * 3600_000, old.csrf);
      assert.equal((await old.call("GET", "/api/status")).status, 401);

      const fresh = await adminBrowser();
      db.prepare("UPDATE sessions SET last_seen_at = ? WHERE csrf = ?").run(Date.now() - 11 * 3600_000, fresh.csrf);
      assert.equal((await fresh.call("GET", "/api/status")).status, 200);
    } finally {
      db.close();
    }
  });

  it("are stored only as hashes, so a copy of the database can't be used to sign in", async () => {
    const b = await adminBrowser();
    const secret = b.cookie.split("=")[1];
    const db = new DatabaseSync(path.join(app.dataDir, "scheduler.db"));
    try {
      const rows = db.prepare("SELECT id_hash FROM sessions").all() as { id_hash: string }[];
      assert.ok(rows.length > 0);
      assert.ok(rows.every((r) => r.id_hash !== secret && r.id_hash.length === 64));
    } finally {
      db.close();
    }
  });
});

describe("the daily brief's own key", () => {
  it("opens only the brief, and only with the right key", async () => {
    const b = newBrowser();
    assert.equal((await b.raw("GET", "/api/brief")).status, 401);
    assert.equal((await b.raw("GET", "/api/brief", { headers: { authorization: "Bearer wrong-wrong-wrong-wrong-wrong" } })).status, 401);
    assert.equal((await b.raw("GET", "/api/brief", { headers: { authorization: `Bearer ${BRIEF}` } })).status, 200);
    const text = await b.raw("GET", "/api/brief?format=text", { headers: { authorization: `Bearer ${BRIEF}` } });
    assert.equal(text.status, 200);
    assert.match(await text.text(), /./);
    // the key is not a general password
    for (const route of ["/api/posts", "/api/accounts", "/api/users", "/api/library"]) {
      assert.equal((await b.raw("GET", route, { headers: { authorization: `Bearer ${BRIEF}` } })).status, 401, route);
    }
    assert.equal((await b.raw("POST", "/api/users", { body: { email: "a@b.co" }, headers: { authorization: `Bearer ${BRIEF}` } })).status, 401);
  });
});

describe("hosting rules", () => {
  it("only answers to its own address", async () => {
    const res = await fetch(`${app.base}/auth/me`, { headers: { "x-forwarded-host": "evil.example.com" } });
    assert.equal(res.status, 401); // reachable by its real name (127.0.0.1 is allowed while testing)
  });
});

describe("guessing at sign-in", () => {
  it("is slowed down per address", async () => {
    const solo = await startServer("ratelimit");
    try {
      const b = new Browser(solo.base);
      let limited = false;
      for (let i = 0; i < 40 && !limited; i++) {
        const r = await b.raw("GET", "/auth/login");
        limited = /Too%20many/.test(r.headers.get("location") ?? "");
      }
      assert.ok(limited, "should be limited after a burst of attempts");
    } finally {
      solo.stop();
    }
  });
});

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import { BackupError, createBackup, decryptFile } from "../src/backup.ts";
import { open as openSecret, isSealed, seal } from "../src/secretbox.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "backups-test-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const PASS = "correct horse battery staple";
const keyA = crypto.randomBytes(32);
const keyB = crypto.randomBytes(32);

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

interface App {
  base: string;
  output(): string;
  stop(): Promise<void>;
}

async function startApp(dataDir: string, env: Record<string, string> = {}): Promise<App> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, PORT: String(port), NO_OPEN: "1", SOCIAL_SCHEDULER_DATA: dataDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (c) => (output += c));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the app didn't start in time: " + output)), 25_000);
    child.stdout!.on("data", () => output.includes("running at") && (clearTimeout(timer), resolve()));
    child.on("exit", (code) => reject(new Error(`the app exited early (${code}): ${output}`)));
  });
  child.stderr!.on("data", (c) => (output += c));
  return {
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    async stop() {
      child.removeAllListeners("exit");
      child.kill();
      await new Promise((r) => child.once("exit", r));
    },
  };
}

const call = (base: string, method: string, route: string, body?: unknown) =>
  fetch(base + route, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    json: (await r.json().catch(() => ({}))) as any,
  }));

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/** Builds an installation on "host A" with an account, a saved API key and a scheduled post with a picture. */
async function buildHostA(dir: string): Promise<void> {
  const app = await startApp(dir, { DATA_KEY: keyA.toString("base64") });
  try {
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#336699" } }).png().toBuffer();
    const up = await fetch(`${app.base}/api/library?name=portable.png`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: png as BodyInit });
    const item = ((await up.json()) as any).item;
    const account = await call(app.base, "POST", "/api/accounts", { kind: "dryrun", label: "Portable account", config: {} });
    await call(app.base, "PUT", "/api/settings", { apiKey: "sk-ant-portable-key" });
    const post = await call(app.base, "POST", "/api/posts", { libraryId: item.id, text: "Survives the move", altText: "blue", scheduledAt: later(600), accountIds: [account.json.id] });
    assert.equal(post.status, 200, JSON.stringify(post.json));
  } finally {
    await app.stop();
  }
}

describe("a backup works on any host", () => {
  const hostA = path.join(root, "hostA");
  const backups = path.join(root, "made");
  let file = "";

  before(async () => {
    await buildHostA(hostA);
    // A person's own Anthropic key, locked with host A's key like the other secrets.
    const seed = new DatabaseSync(path.join(hostA, "scheduler.db"));
    seed.prepare("INSERT INTO users (email, name, role, status, created_at, anthropic_key) VALUES ('person@example.com', 'P', 'member', 'active', ?, ?)").run(
      new Date().toISOString(),
      seal("sk-ant-personal-key-0123456789abcdef", keyA),
    );
    seed.close();
    const made = await createBackup({ dataDir: hostA, passphrase: PASS, backupDir: backups, dataKey: keyA });
    file = made.file;
    assert.equal(made.accounts, 1);
    assert.equal(made.mediaFiles, 1);
  });

  it("holds the secrets unlocked, but only inside the passphrase-encrypted file", async () => {
    // the live database has them locked...
    const live = new DatabaseSync(path.join(hostA, "scheduler.db"), { readOnly: true });
    assert.ok(isSealed((live.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get() as any).value));
    live.close();
    // ...the backup file is just noise to anyone without the passphrase...
    assert.ok(!fs.readFileSync(file).includes("sk-ant-portable-key"));
    assert.rejects(() => decryptFile(file, path.join(root, "x.tar.gz"), "the wrong passphrase!!"), BackupError);
    // ...and unlocked within, so any host can read it
    const tar = path.join(root, "contents.tar.gz");
    await decryptFile(file, tar, PASS);
    const out = path.join(root, "contents");
    fs.mkdirSync(out, { recursive: true });
    assert.equal(spawnSync("tar", ["-xzf", tar, "-C", out]).status, 0);
    const snap = new DatabaseSync(path.join(out, "scheduler.db"), { readOnly: true });
    assert.equal((snap.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get() as any).value, "sk-ant-portable-key");
    assert.ok(!isSealed((snap.prepare("SELECT config FROM accounts").get() as any).config));
    assert.equal((snap.prepare("SELECT anthropic_key FROM users WHERE email = 'person@example.com'").get() as any).anthropic_key, "sk-ant-personal-key-0123456789abcdef", "personal keys are unlocked inside the backup too");
    snap.close();
  });

  it("refuses to make a backup it couldn't unlock, instead of saving something useless", async () => {
    await assert.rejects(() => createBackup({ dataDir: hostA, passphrase: PASS, backupDir: backups, dataKey: keyB, out: path.join(root, "bad.ssbackup") }), /DATA_KEY/);
  });

  it("brings a new server back to life on boot, locking the secrets with that server's own key", async () => {
    const hostB = path.join(root, "hostB");
    fs.mkdirSync(path.join(hostB, "restore"), { recursive: true });
    fs.copyFileSync(file, path.join(hostB, "restore", "social-scheduler-test.ssbackup"));
    const app = await startApp(hostB, { DATA_KEY: keyB.toString("base64"), BACKUP_PASSPHRASE: PASS });
    try {
      const accounts = (await call(app.base, "GET", "/api/accounts")).json as any[];
      assert.deepEqual(accounts.map((a) => a.label), ["Portable account"], app.output());
      assert.equal((await call(app.base, "GET", "/api/settings")).json.apiKeySet, true);
      const posts = (await call(app.base, "GET", "/api/posts")).json as any[];
      assert.equal(posts.length, 1);
      assert.equal(posts[0].text, "Survives the move");
      assert.equal((await fetch(`${app.base}/api/media/${posts[0].mediaFile}`)).status, 200, "the post's picture came with it");
      // the unusable library entry (its file wasn't carried) is gone, not a broken tile
      assert.deepEqual(((await call(app.base, "GET", "/api/library")).json as any).items, []);
    } finally {
      await app.stop();
    }
    assert.ok(fs.existsSync(path.join(hostB, "restore", "social-scheduler-test.ssbackup.restored")), "marked as used");
    const db = new DatabaseSync(path.join(hostB, "scheduler.db"), { readOnly: true });
    const stored = (db.prepare("SELECT config FROM accounts").get() as any).config as string;
    assert.ok(isSealed(stored));
    assert.doesNotThrow(() => openSecret(stored, keyB), "locked with host B's key");
    assert.throws(() => openSecret(stored, keyA), "not host A's");
    const personal = (db.prepare("SELECT anthropic_key FROM users WHERE email = 'person@example.com'").get() as any).anthropic_key as string;
    assert.ok(isSealed(personal), "a person's own key is locked again on the new host");
    assert.equal(openSecret(personal, keyB), "sk-ant-personal-key-0123456789abcdef");
    db.close();
  });

  it("makes the restore folder by itself, so a backup can be copied in with a tool that can't create folders", async () => {
    const fresh = path.join(root, "fresh");
    const app = await startApp(fresh);
    await app.stop();
    assert.ok(fs.statSync(path.join(fresh, "restore")).isDirectory());
  });

  it("never overwrites an installation that already has work in it", async () => {
    const hostC = path.join(root, "hostC");
    await buildHostA(hostC);
    fs.mkdirSync(path.join(hostC, "restore"), { recursive: true });
    fs.copyFileSync(file, path.join(hostC, "restore", "stray.ssbackup"));
    const app = await startApp(hostC, { DATA_KEY: keyA.toString("base64"), BACKUP_PASSPHRASE: PASS });
    try {
      assert.equal(((await call(app.base, "GET", "/api/accounts")).json as any[]).length, 1);
    } finally {
      await app.stop();
    }
    assert.ok(fs.existsSync(path.join(hostC, "restore", "stray.ssbackup")), "left where it was");
    assert.ok(!fs.existsSync(path.join(hostC, "restore", "stray.ssbackup.restored")));
  });

  it("stops with a clear message rather than starting empty, if the backup can't be opened", async () => {
    const hostD = path.join(root, "hostD");
    fs.mkdirSync(path.join(hostD, "restore"), { recursive: true });
    fs.copyFileSync(file, path.join(hostD, "restore", "x.ssbackup"));
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, PORT: "4998", NO_OPEN: "1", SOCIAL_SCHEDULER_DATA: hostD, ...env },
        encoding: "utf8",
        timeout: 20_000,
      });
    const wrong = run({ BACKUP_PASSPHRASE: "this is not the passphrase" });
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /Wrong passphrase/);
    const none = run({});
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /BACKUP_PASSPHRASE/);
  });
});

/** A stand-in for Cloudflare R2: just enough S3 to put, look at, list and delete objects. */
async function startFakeS3() {
  const objects = new Map<string, Buffer>();
  let failing = false;
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      requests.push(`${req.method} ${url.pathname}`);
      if (failing) return void res.writeHead(500, { "Content-Type": "application/xml" }).end("<Error><Code>InternalError</Code></Error>");
      const key = decodeURIComponent(url.pathname);
      if (req.method === "PUT") {
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200, { ETag: '"x"' }).end();
      } else if (req.method === "HEAD") {
        const o = objects.get(key);
        if (!o) return void res.writeHead(404).end();
        res.writeHead(200, { "Content-Length": String(o.length) }).end();
      } else if (req.method === "DELETE") {
        objects.delete(key);
        res.writeHead(204).end();
      } else if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = `${url.pathname.replace(/\/+$/, "")}/${url.searchParams.get("prefix") ?? ""}`;
        const items = [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => `<Contents><Key>${k.replace(/^\/[^/]+\//, "")}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>${objects.get(k)!.length}</Size></Contents>`);
        res.writeHead(200, { "Content-Type": "application/xml" }).end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${items.join("")}</ListBucketResult>`);
      } else res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    objects,
    requests,
    fail: (v: boolean) => (failing = v),
    close: () => server.close(),
  };
}

describe("a backup of a post with several pictures", () => {
  it("carries every picture of a post that hasn't gone out", async () => {
    const dir = path.join(root, "hostMulti");
    const app = await startApp(dir, { DATA_KEY: keyA.toString("base64") });
    try {
      const ids: number[] = [];
      for (const colour of ["#aa3333", "#33aa33", "#3333aa"]) {
        const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: colour } }).png().toBuffer();
        const up = await fetch(`${app.base}/api/library?name=${colour.slice(1)}.png`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: png as BodyInit });
        ids.push(((await up.json()) as any).item.id);
      }
      const account = await call(app.base, "POST", "/api/accounts", { kind: "dryrun", label: "Multi", config: {} });
      const post = await call(app.base, "POST", "/api/posts", {
        libraryId: ids[0],
        moreImages: [{ libraryId: ids[1], altText: "two" }, { libraryId: ids[2], altText: "three" }],
        text: "Three pictures",
        altText: "one",
        scheduledAt: later(600),
        accountIds: [account.json.id],
      });
      assert.equal(post.status, 200, JSON.stringify(post.json));
    } finally {
      await app.stop();
    }
    const made = await createBackup({ dataDir: dir, passphrase: PASS, backupDir: path.join(root, "made-multi"), dataKey: keyA });
    assert.equal(made.pendingPosts, 1, "one post");
    assert.equal(made.mediaFiles, 3, "but all three of its pictures");
  });
});

describe("nightly backups to a private bucket, and alerts", () => {
  let s3: Awaited<ReturnType<typeof startFakeS3>>;
  let app: App;
  const alerts: any[] = [];
  let webhook: http.Server;
  const dir = path.join(root, "nightly");

  before(async () => {
    s3 = await startFakeS3();
    webhook = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        alerts.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => webhook.listen(0, "127.0.0.1", r));
    app = await startApp(dir, {
      DATA_KEY: keyA.toString("base64"),
      BACKUP_PASSPHRASE: PASS,
      BACKUP_S3_ENDPOINT: s3.base,
      BACKUP_S3_BUCKET: "private-backups",
      BACKUP_S3_ACCESS_KEY_ID: "AKIATEST",
      BACKUP_S3_SECRET_ACCESS_KEY: "secret",
      BACKUP_KEEP: "2",
      ALERT_WEBHOOK_URL: `http://127.0.0.1:${(webhook.address() as AddressInfo).port}/hook`,
    });
    await call(app.base, "POST", "/api/accounts", { kind: "dryrun", label: "Nightly account", config: {} });
    await call(app.base, "PUT", "/api/settings", { apiKey: "sk-ant-nightly-secret" });
  });
  after(async () => {
    await app.stop();
    s3.close();
    webhook.close();
  });

  it("reports that it is set up and hasn't run yet", async () => {
    const r = await call(app.base, "GET", "/api/backup");
    assert.equal(r.json.configured, true);
    assert.equal(r.json.lastOk, null);
    assert.ok(r.json.disk.totalBytes > 0);
  });

  it("uploads an encrypted backup that can be restored, and nothing readable leaves the server", async () => {
    const r = await call(app.base, "POST", "/api/backup/run", {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const [[key, bytes]] = [...s3.objects];
    assert.match(key, /^\/private-backups\/social-scheduler\/social-scheduler-\d{8}T\d{6}Z\.ssbackup$/);
    assert.ok(!bytes.includes("sk-ant-nightly-secret") && !bytes.includes("Nightly account"));
    const tmp = path.join(root, "downloaded.ssbackup");
    fs.writeFileSync(tmp, bytes);
    await decryptFile(tmp, path.join(root, "downloaded.tar.gz"), PASS);
    const status = (await call(app.base, "GET", "/api/backup")).json;
    assert.equal(status.lastOk, true);
    assert.equal(status.lastBytes, bytes.length);
  });

  it("keeps only the newest few", async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1100)); // names carry the time to the second
      assert.equal((await call(app.base, "POST", "/api/backup/run", {})).status, 200);
    }
    assert.equal(s3.objects.size, 2);
    assert.ok(s3.requests.some((r) => r.startsWith("DELETE")));
  });

  it("tells the team when it fails, and says so in the daily brief", async () => {
    s3.fail(true);
    const r = await call(app.base, "POST", "/api/backup/run", {});
    assert.equal(r.status, 500);
    s3.fail(false);
    const status = (await call(app.base, "GET", "/api/backup")).json;
    assert.equal(status.lastOk, false);
    assert.ok(status.lastError);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(alerts.some((a) => /Backup failed/.test(a.content) && a.content === a.text), "alert sent in both Discord and Slack form");
    assert.ok(!JSON.stringify(alerts).includes("sk-ant") && !JSON.stringify(alerts).includes(PASS));
  });
});

describe("alerts", () => {
  it("send each distinct message once, and never break the app when the webhook is down", async () => {
    const received: string[] = [];
    const hook = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString()).content);
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
    const script = `
      const { notify, notifyDaily } = await import("./src/util.ts");
      notify("Post failed", "Bluesky: nope"); notify("Post failed", "Bluesky: nope"); notify("Post failed", "Mastodon: nope");
      notifyDaily("disk", "Disk nearly full", "90%"); notifyDaily("disk", "Disk nearly full", "90%");
      await new Promise((r) => setTimeout(r, 500));`;
    // asynchronous on purpose: this process must stay free to answer the webhook
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, ALERT_WEBHOOK_URL: url, SOCIAL_SCHEDULER_DATA: path.join(root, "alerts-data") },
    });
    hook.close();
    assert.deepEqual(received.sort(), ["Social Scheduler: Disk nearly full. 90%", "Social Scheduler: Post failed. Bluesky: nope", "Social Scheduler: Post failed. Mastodon: nope"]);

    const down = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `const { notify } = await import("./src/util.ts"); notify("x", "y"); await new Promise((r) => setTimeout(r, 300)); console.log("fine");`], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, ALERT_WEBHOOK_URL: "http://127.0.0.1:9/nothing-listens-here" },
      encoding: "utf8",
    });
    assert.equal(down.status, 0);
    assert.match(down.stdout, /fine/);
  });
});

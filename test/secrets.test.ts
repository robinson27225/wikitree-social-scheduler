import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { isSealed, open, seal, SecretBoxError } from "../src/secretbox.ts";

const KEY = crypto.randomBytes(32);

describe("the secret box", () => {
  it("round-trips text, and the stored form reveals nothing", () => {
    const stored = seal('{"token":"EAAB-very-secret"}', KEY);
    assert.ok(isSealed(stored));
    assert.ok(!stored.includes("EAAB") && !stored.includes("token"));
    assert.equal(open(stored, KEY), '{"token":"EAAB-very-secret"}');
  });

  it("uses a fresh nonce each time, so the same secret never looks the same twice", () => {
    assert.notEqual(seal("same", KEY), seal("same", KEY));
  });

  it("refuses the wrong key, and a tampered value", () => {
    const stored = seal("secret", KEY);
    assert.throws(() => open(stored, crypto.randomBytes(32)), SecretBoxError);
    const flipped = stored.slice(0, -2) + (stored.endsWith("AA") ? "BB" : "AA");
    assert.throws(() => open(flipped, KEY), SecretBoxError);
    assert.throws(() => open("enc1:short", KEY), SecretBoxError);
  });

  it("hands back plain text that was stored before encryption existed, and stores plainly when there is no key", () => {
    assert.equal(open('{"a":1}', KEY), '{"a":1}');
    assert.equal(seal("plain", null), "plain");
    assert.throws(() => open(seal("x", KEY), null), /no DATA_KEY/);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function withApp<T>(dataDir: string, env: Record<string, string>, body: (base: string) => Promise<T>): Promise<T> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, PORT: String(port), NO_OPEN: "1", SOCIAL_SCHEDULER_DATA: dataDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the app didn't start in time")), 20_000);
    child.stdout!.on("data", (c) => String(c).includes("running at") && (clearTimeout(timer), resolve()));
    child.on("exit", (code) => reject(new Error(`the app exited early (${code})`)));
  });
  try {
    return await body(`http://127.0.0.1:${port}`);
  } finally {
    child.removeAllListeners("exit");
    child.kill();
    await new Promise((r) => child.once("exit", r));
  }
}

const post = (base: string, route: string, body: unknown, method = "POST") =>
  fetch(base + route, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));

const rawDb = (dir: string) => new DatabaseSync(path.join(dir, "scheduler.db"), { readOnly: true });

describe("secrets in the database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-test-"));
  const dir = path.join(root, "data");
  const key = KEY.toString("base64");

  it("stay readable as before when no key is set (your own computer)", async () => {
    await withApp(dir, {}, async (base) => {
      const r = await post(base, "/api/accounts", { kind: "dryrun", label: "Plain test", config: {} });
      assert.equal(r.status, 200);
      await post(base, "/api/settings", { apiKey: "sk-ant-plain-key" }, "PUT");
    });
    const db = rawDb(dir);
    const row = db.prepare("SELECT config FROM accounts").get() as { config: string };
    assert.ok(!isSealed(row.config));
    db.close();
  });

  it("are encrypted on the next start once a key is set, and everything still works", async () => {
    await withApp(dir, { DATA_KEY: key }, async (base) => {
      const accounts = (await (await fetch(base + "/api/accounts")).json()) as any[];
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].label, "Plain test");
      const settings = (await (await fetch(base + "/api/settings")).json()) as any;
      assert.equal(settings.apiKeySet, true);
      // new accounts and settings are encrypted as they are written
      assert.equal((await post(base, "/api/accounts", { kind: "dryrun", label: "Second", config: {} })).status, 200);
      await post(base, "/api/settings", { apiKey: "sk-ant-second-key" }, "PUT");
    });
    const db = rawDb(dir);
    for (const row of db.prepare("SELECT config FROM accounts").all() as { config: string }[]) assert.ok(isSealed(row.config), "account config is encrypted");
    const keyRow = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_api_key'").get() as { value: string };
    assert.ok(isSealed(keyRow.value));
    const dump = JSON.stringify(db.prepare("SELECT * FROM accounts").all()) + JSON.stringify(db.prepare("SELECT * FROM settings").all());
    assert.ok(!dump.includes("sk-ant"), "no API key in plain sight");
    db.close();
    // and not in the raw file either
    assert.ok(!fs.readFileSync(path.join(dir, "scheduler.db")).includes("sk-ant-second-key"));
  });

  it("refuse to start with the wrong key, rather than failing later in confusing ways", async () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, PORT: String(await freePort()), NO_OPEN: "1", SOCIAL_SCHEDULER_DATA: dir, DATA_KEY: crypto.randomBytes(32).toString("base64") },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /DATA_KEY/);
  });

  it("refuse to start without the key once they are encrypted", async () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, PORT: String(await freePort()), NO_OPEN: "1", SOCIAL_SCHEDULER_DATA: dir },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no DATA_KEY/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-accounts-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { all, get, readConfig, run, setSetting } = await import("../src/db.ts");
const { seedManualAccounts } = await import("../src/seedAccounts.ts");
const { installationIsEmpty } = await import("../src/boot.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const accounts = () => all("SELECT id, kind, label, config FROM accounts ORDER BY id");
const add = (kind: string, label: string) =>
  run("INSERT INTO accounts (kind, label, config, created_at) VALUES (?, ?, '{}', ?)", kind, label, new Date().toISOString());

describe("the TikTok and LinkedIn accounts that appear by themselves", () => {
  it("adds both as manual accounts, once", () => {
    assert.equal(seedManualAccounts(), 2);
    const rows = accounts();
    assert.deepEqual(rows.map((r) => [r.kind, r.label]), [["manual", "WikiTree on TikTok"], ["manual", "WikiTree on LinkedIn"]]);
    assert.equal(readConfig(rows[0].config).url, "https://www.tiktok.com/tiktokstudio/upload");
    assert.equal(readConfig(rows[1].config).maxChars, 3000);
    assert.equal(seedManualAccounts(), 0, "not again on the next start");
  });

  it("doesn't bring them back after the team removes one", () => {
    run("DELETE FROM accounts WHERE label = 'WikiTree on LinkedIn'");
    assert.equal(seedManualAccounts(), 0);
    assert.equal(get("SELECT 1 FROM accounts WHERE label LIKE '%LinkedIn%'"), undefined);
  });

  it("leaves things alone when the team already has such an account", () => {
    run("DELETE FROM accounts");
    setSetting("manual_accounts_seeded", "");
    add("linkedin", "WikiTree LinkedIn Page");
    add("manual", "WikiTreers (TikTok)");
    assert.equal(seedManualAccounts(), 0);
    assert.equal(accounts().length, 2, "nothing added");
  });

  it("adds only the one that is missing", () => {
    run("DELETE FROM accounts");
    setSetting("manual_accounts_seeded", "");
    add("linkedin", "WikiTree LinkedIn Page");
    assert.equal(seedManualAccounts(), 1);
    assert.deepEqual(accounts().map((r) => r.label), ["WikiTree LinkedIn Page", "WikiTree on TikTok"]);
  });
});

describe("a new server can still be restored from a backup", () => {
  it("counts as empty with only the accounts the app made itself, but not once the team has added one", () => {
    run("DELETE FROM accounts");
    setSetting("manual_accounts_seeded", "");
    seedManualAccounts();
    assert.equal(all("SELECT 1 FROM accounts").length, 2);
    assert.equal(installationIsEmpty(dir), true, "the app's own accounts aren't work worth protecting");
    add("dryrun", "A real account");
    assert.equal(installationIsEmpty(dir), false);
  });
});

describe("on a real start", () => {
  it("the Post to list has TikTok and LinkedIn without anyone adding them", async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "seed-start-"));
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), NO_OPEN: "1", SOCIAL_SCHEDULER_DATA: data };
    delete env.SEED_MANUAL_ACCOUNTS;
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: path.resolve(import.meta.dirname, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
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
      const list = (await (await fetch(`http://127.0.0.1:${port}/api/accounts`)).json()) as { label: string; manual: boolean }[];
      assert.deepEqual(list.map((a) => a.label), ["WikiTree on TikTok", "WikiTree on LinkedIn"]);
      assert.ok(list.every((a) => a.manual));
    } finally {
      child.kill();
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
});

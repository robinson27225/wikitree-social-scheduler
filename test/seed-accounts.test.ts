import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-accounts-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { all, get, readConfig, run, setSetting } = await import("../src/db.ts");
const { seedManualAccounts } = await import("../src/seedAccounts.ts");

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

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "handover-test-"));
const dataA = path.join(root, "original-data");
process.env.SOCIAL_SCHEDULER_DATA = dataA;
process.env.SOCIAL_SCHEDULER_BACKUPS = path.join(root, "backups");

const { run, MEDIA_DIR } = await import("../src/db.ts");
const { createBackup, restoreBackup, BackupError, encryptFile, decryptFile } = await import("../src/backup.ts");
const { buildPackage, PACKAGE_CONTENTS } = await import("../src/package.ts");
const { buildBrief } = await import("../src/brief.ts");

const SECRET = "EAAB-super-secret-page-token-12345";
const PASS = "correct horse battery staple";
after(() => fs.rmSync(root, { recursive: true, force: true }));

const now = new Date("2026-10-07T12:00:00-07:00");
const minutes = (n: number) => new Date(now.getTime() + n * 60_000).toISOString();

function seed() {
  const fb = run(
    "INSERT INTO accounts (kind, label, config, created_at) VALUES ('facebook', 'WikiTree (Facebook)', ?, ?)",
    JSON.stringify({ pageId: "1", pageToken: SECRET }),
    now.toISOString(),
  ).lastInsertRowid;
  const dry = run("INSERT INTO accounts (kind, label, config, created_at) VALUES ('dryrun', 'Bluesky stand-in', '{}', ?)", now.toISOString()).lastInsertRowid;
  const manual = run(
    "INSERT INTO accounts (kind, label, config, created_at) VALUES ('manual', 'Reddit (manual)', ?, ?)",
    JSON.stringify({ url: "https://www.reddit.com/r/wikitree/submit?title={title}", usesTitle: true }),
    now.toISOString(),
  ).lastInsertRowid;

  fs.writeFileSync(path.join(MEDIA_DIR, "pending.jpg"), "PENDING-PICTURE-BYTES");
  fs.writeFileSync(path.join(MEDIA_DIR, "done.jpg"), "ALREADY-POSTED-BYTES");
  const post = (text: string, media: string, due: string) =>
    run("INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at) VALUES (?, '', ?, '', ?, ?)", text, media, due, now.toISOString()).lastInsertRowid;
  const target = (p: unknown, a: unknown, status: string, extra = "") =>
    run(`INSERT INTO targets (post_id, account_id, status${extra ? ", " + extra.split("=")[0] : ""}) VALUES (?, ?, ?${extra ? ", ?" : ""})`, ...[p, a, status, ...(extra ? [extra.split("=")[1]] : [])]);

  const soon = post("Census 1920 showcase for tomorrow morning", "pending.jpg", minutes(14 * 60));
  target(soon, fb, "scheduled", "mode=remote");
  target(soon, dry, "scheduled");
  target(soon, manual, "scheduled");
  const old = post("A post that already went out", "done.jpg", minutes(-3 * 60));
  run("INSERT INTO targets (post_id, account_id, status, url, posted_at) VALUES (?, ?, 'posted', 'https://example.social/1', ?)", old, dry, minutes(-60));
  const broken = post("This one failed", "", minutes(-30));
  run("INSERT INTO targets (post_id, account_id, status, error) VALUES (?, ?, 'failed', 'Facebook said no')", broken, fb);
  const far = post("Next week's post", "", minutes(5 * 24 * 60));
  target(far, dry, "scheduled");
}
before(seed);

describe("the daily digest", () => {
  it("says what needs a person, what's coming, and what the app must be running for", () => {
    const b = buildBrief(now);
    assert.ok(b.text.includes("NEEDS ATTENTION"));
    assert.ok(b.needsAttention.some((n) => n.detail?.includes("Failed: Facebook said no")));
    assert.ok(b.text.includes("COMING UP IN THE NEXT 48 HOURS (1 post)"));
    const upcoming = b.upcoming[0];
    assert.equal(upcoming.appMustBeRunning, true, "the Bluesky stand-in is posted by this app");
    const how = Object.fromEntries(upcoming.channels.map((c) => [c.account, c.how]));
    assert.match(how["WikiTree (Facebook)"], /held by Facebook Page.*even if this Mac is off/);
    assert.match(how["Bluesky stand-in"], /this app, so the Mac must be on/);
    assert.match(how["Reddit (manual)"], /you post it by hand/);
    assert.equal(b.laterCount, 1, "the post five days out is counted, not listed");
    assert.equal(b.postedLast24h.length, 1);
    assert.match(b.text, /Plus 1 more post scheduled further ahead/);
  });

  it("flags a manual channel that still needs its title", () => {
    const b = buildBrief(now);
    assert.ok(b.needsAttention.some((n) => n.account === "Reddit (manual)" && /Needs a title/.test(n.detail ?? "")));
  });

  it("warns about missing backups, and never prints a token", () => {
    const b = buildBrief(now);
    assert.ok(b.warnings.some((w) => /no backup yet/.test(w)));
    assert.equal(b.text.includes(SECRET), false);
    assert.equal(JSON.stringify(b).includes(SECRET), false);
  });
});

describe("encrypted backup and restore", () => {
  let backupFile: string;
  const dataB = path.join(root, "new-computer-data");

  it("makes a file that doesn't contain the tokens in the clear", async () => {
    const r = await createBackup({ dataDir: dataA, passphrase: PASS, backupDir: process.env.SOCIAL_SCHEDULER_BACKUPS! });
    backupFile = r.file;
    assert.match(path.basename(backupFile), /^social-scheduler-\d{4}-\d{2}-\d{2}-\d{4}\.ssbackup$/);
    assert.equal(r.accounts, 3);
    assert.equal(r.posts, 4);
    assert.equal(r.mediaFiles, 1, "only the picture of the post that hasn't gone out is included");
    const raw = fs.readFileSync(backupFile);
    assert.equal(raw.includes(Buffer.from(SECRET)), false, "token must not appear in the clear");
    assert.equal(raw.includes(Buffer.from("scheduler")), false, "nor any recognisable file name");
    assert.equal(raw.includes(Buffer.from("SQLite format")), false);
    assert.equal((fs.statSync(backupFile).mode & 0o077), 0, "readable only by its owner");
  });

  it("restores the queue, the accounts and the pending picture on another computer", async () => {
    const r = await restoreBackup({ file: backupFile, passphrase: PASS, dataDir: dataB });
    assert.deepEqual([r.accounts, r.posts, r.mediaFiles, r.movedAside], [3, 4, 1, null]);
    assert.equal(fs.readFileSync(path.join(dataB, "media", "pending.jpg"), "utf8"), "PENDING-PICTURE-BYTES");
    assert.equal(fs.existsSync(path.join(dataB, "media", "done.jpg")), false);

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(dataB, "scheduler.db"), { readOnly: true });
    const fb = db.prepare("SELECT config FROM accounts WHERE kind = 'facebook'").get() as { config: string };
    assert.equal(JSON.parse(fb.config).pageToken, SECRET, "the sign-in comes through, so the new person may not need to reconnect");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM targets WHERE status = 'scheduled'").get() as { n: number }).n, 4);
    db.close();
  });

  it("moves existing data aside instead of deleting it", async () => {
    const r = await restoreBackup({ file: backupFile, passphrase: PASS, dataDir: dataB });
    assert.ok(r.movedAside && fs.existsSync(path.join(r.movedAside, "scheduler.db")));
  });

  it("refuses a wrong passphrase, a damaged file, and a file that isn't a backup", async () => {
    await assert.rejects(() => restoreBackup({ file: backupFile, passphrase: "totally the wrong passphrase", dataDir: path.join(root, "x1") }), /Wrong passphrase, or the backup file is damaged/);
    assert.equal(fs.existsSync(path.join(root, "x1")), false, "a failed restore must not create or touch anything");

    const damaged = path.join(root, "damaged.ssbackup");
    const bytes = fs.readFileSync(backupFile);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(damaged, bytes);
    await assert.rejects(() => restoreBackup({ file: damaged, passphrase: PASS, dataDir: path.join(root, "x2") }), BackupError);

    const notBackup = path.join(root, "notes.txt");
    fs.writeFileSync(notBackup, "just some text that is long enough to pass a size check ".repeat(3));
    await assert.rejects(() => restoreBackup({ file: notBackup, passphrase: PASS, dataDir: path.join(root, "x3") }), /isn't a Social Scheduler backup/);
  });

  it("insists on a decent passphrase and a real data folder", async () => {
    await assert.rejects(() => createBackup({ dataDir: dataA, passphrase: "short", backupDir: root }), /at least 12 characters/);
    await assert.rejects(() => createBackup({ dataDir: path.join(root, "nowhere"), passphrase: PASS, backupDir: root }), /No database found/);
  });

  it("the digest notices a recent backup and stops nagging", () => {
    const b = buildBrief(new Date());
    assert.equal(b.warnings.some((w) => /no backup yet/.test(w)), false);
  });

  it("works on large files by streaming (round-trips a 20 MB file)", async () => {
    const big = path.join(root, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(20_000_000, 9));
    await encryptFile(big, big + ".enc", PASS);
    await decryptFile(big + ".enc", big + ".out", PASS);
    assert.equal(fs.statSync(big + ".out").size, 20_000_000);
  });
});

describe("the hand-over package", () => {
  it("contains the program and guides, and nothing that belongs to the person who made it", async () => {
    // Put things that must never ship right where a careless copy would find them.
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.mkdirSync(path.join(project, "data", "media"), { recursive: true });
    fs.mkdirSync(path.join(project, "backups"));
    fs.mkdirSync(path.join(project, "node_modules", "x"), { recursive: true });
    fs.mkdirSync(path.join(project, "docs"));
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "social-scheduler", version: "9.9.9" }));
    fs.writeFileSync(path.join(project, "src", "server.ts"), "// program");
    fs.writeFileSync(path.join(project, "docs", "SETUP.md"), "# guide");
    fs.writeFileSync(path.join(project, "README.md"), "# readme");
    fs.writeFileSync(path.join(project, "data", "scheduler.db"), SECRET);
    fs.writeFileSync(path.join(project, "data", "media", "pic.jpg"), "x");
    fs.writeFileSync(path.join(project, "backups", "old.ssbackup"), SECRET);
    fs.writeFileSync(path.join(project, "node_modules", "x", "index.js"), "x");
    fs.writeFileSync(path.join(project, ".env"), `ANTHROPIC_API_KEY=${SECRET}`);
    fs.writeFileSync(path.join(project, "src", ".DS_Store"), "junk");

    const { file } = await buildPackage(project, path.join(root, "dist"));
    assert.match(path.basename(file), /^social-scheduler-9\.9\.9-\d{4}-\d{2}-\d{2}\.zip$/);
    const listing = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).split("\n").filter(Boolean);

    for (const wanted of ["social-scheduler/package.json", "social-scheduler/src/server.ts", "social-scheduler/docs/SETUP.md", "social-scheduler/README.md"]) {
      assert.ok(listing.includes(wanted), `missing ${wanted}`);
    }
    for (const entry of listing) {
      assert.equal(/\/(data|backups|node_modules)\//.test(entry) || /\.env$/.test(entry) || /\.ssbackup$/.test(entry) || /\.DS_Store$/.test(entry), false, `must not ship: ${entry}`);
    }
    const contents = execFileSync("unzip", ["-p", file], { encoding: "buffer", maxBuffer: 50_000_000 });
    assert.equal(contents.includes(Buffer.from(SECRET)), false, "no secret anywhere in the package");
  });

  it("only ever packages what is on the allow-list", () => {
    assert.deepEqual([...PACKAGE_CONTENTS].sort(), [".dockerignore", ".gitignore", "Dockerfile", "README.md", "docker-entrypoint.sh", "docs", "fly.toml", "package-lock.json", "package.json", "public", "scripts", "src", "test", "tsconfig.json"]);
    for (const banned of ["data", "backups", ".env", "node_modules", "dist"]) assert.equal(PACKAGE_CONTENTS.includes(banned), false);
  });
});


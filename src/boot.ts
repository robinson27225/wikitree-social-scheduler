/**
 * Runs before anything opens the database (it is the first thing server.ts imports), so a brand-new server
 * can be brought back from a backup: put a .ssbackup file in the data disk's "restore" folder and start the app.
 *
 * It only ever fills an EMPTY installation (no accounts and no posts). A server that already has data ignores
 * the file and says so, so a stray backup can never overwrite live work.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BackupError, restoreBackup } from "./backup.ts";
import { config } from "./config.ts";

const dataDir = path.resolve(process.env.SOCIAL_SCHEDULER_DATA ?? "data");
const restoreDir = path.join(dataDir, "restore");

/** True when there is nothing worth protecting: no database, or one with no accounts and no posts. */
export function installationIsEmpty(dir: string): boolean {
  const file = path.join(dir, "scheduler.db");
  if (!fs.existsSync(file)) return true;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const n = (table: string) => Number((db!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    // Accounts the app added by itself (the manual TikTok and LinkedIn ones) aren't work worth protecting.
    let seeded: number[] = [];
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'seeded_account_ids'").get() as { value: string } | undefined;
      seeded = row ? (JSON.parse(row.value) as number[]) : [];
    } catch {
      /* no settings table or an unreadable value: nothing was seeded */
    }
    const accounts = (db.prepare("SELECT id FROM accounts").all() as { id: number }[]).filter((a) => !seeded.includes(a.id)).length;
    return accounts === 0 && n("posts") === 0;
  } catch {
    return true; // a file with none of our tables is as good as empty
  } finally {
    db?.close();
  }
}

export async function restoreOnBoot(): Promise<void> {
  // Always make the folder, so someone can copy a backup into it with a plain file-transfer tool that can't create folders.
  try {
    fs.mkdirSync(restoreDir, { recursive: true });
  } catch {
    /* read-only disk or similar: nothing to restore from, and the app will say what's wrong when it can't write */
  }
  if (!fs.existsSync(restoreDir)) return;
  const files = fs
    .readdirSync(restoreDir)
    .filter((f) => f.endsWith(".ssbackup"))
    .map((f) => ({ f, at: fs.statSync(path.join(restoreDir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  if (files.length === 0) return;

  const newest = path.join(restoreDir, files[0].f);
  if (!installationIsEmpty(dataDir)) {
    console.log(`Found a backup to restore (${files[0].f}) but this installation already has accounts or posts, so it was left alone.`);
    return;
  }
  if (!config.backup.passphrase) {
    console.error(`Found a backup to restore (${files[0].f}) but BACKUP_PASSPHRASE isn't set, so it can't be opened. Set it and restart.`);
    process.exit(1);
  }
  try {
    const result = await restoreBackup({ file: newest, passphrase: config.backup.passphrase, dataDir, inPlace: true });
    fs.renameSync(newest, `${newest}.restored`); // never restore the same file twice
    console.log(`Restored from ${files[0].f}: ${result.accounts} accounts, ${result.posts} posts, ${result.mediaFiles} media files.`);
  } catch (error) {
    console.error(`Couldn't restore ${files[0].f}: ${error instanceof BackupError ? error.message : error}`);
    process.exit(1);
  }
}

await restoreOnBoot();

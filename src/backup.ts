import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";
import { isSealed, open as openSecret } from "./secretbox.ts";

/**
 * Encrypted backups, so someone else can take over the queue if the person running it can't.
 *
 * The database holds every account's sign-in tokens, so a backup is a password-protected file:
 * AES-256-GCM, with the key made from a passphrase by scrypt. Without the passphrase it is noise.
 * This file doesn't import db.ts on purpose: it must be able to run beside a running app.
 */

const run = promisify(execFile);
const MAGIC = Buffer.from("SSBK1\n");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const MIN_PASSPHRASE = 12;

export class BackupError extends Error {}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}

/** Encrypts a file to a new file: header (magic, salt, iv), then the ciphertext, then the 16-byte check tag. */
export async function encryptFile(input: string, output: string, passphrase: string): Promise<void> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  await fsp.writeFile(output, Buffer.concat([MAGIC, salt, iv]), { mode: 0o600 });
  await pipeline(fs.createReadStream(input), cipher, fs.createWriteStream(output, { flags: "a", mode: 0o600 }));
  await fsp.appendFile(output, cipher.getAuthTag());
}

/** Decrypts a file made by encryptFile. Throws a plain-English BackupError for a wrong passphrase or a damaged file. */
export async function decryptFile(input: string, output: string, passphrase: string): Promise<void> {
  const size = (await fsp.stat(input)).size;
  const headerBytes = MAGIC.length + SALT_BYTES + IV_BYTES;
  if (size < headerBytes + TAG_BYTES) throw new BackupError("That isn't a Social Scheduler backup (it's too small).");

  const handle = await fsp.open(input, "r");
  let header: Buffer;
  let tag: Buffer;
  try {
    header = Buffer.alloc(headerBytes);
    await handle.read(header, 0, headerBytes, 0);
    tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError("That isn't a Social Scheduler backup file.");

  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = header.subarray(MAGIC.length + SALT_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      fs.createReadStream(input, { start: headerBytes, end: size - TAG_BYTES - 1 }),
      decipher,
      fs.createWriteStream(output, { mode: 0o600 }),
    );
  } catch {
    await fsp.rm(output, { force: true });
    throw new BackupError("Wrong passphrase, or the backup file is damaged.");
  }
}

const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;

export interface BackupResult {
  file: string;
  bytes: number;
  accounts: number;
  posts: number;
  pendingPosts: number;
  mediaFiles: number;
}

/**
 * Backs up the database (a consistent snapshot, safe while the app is running) and the pictures and
 * videos of posts that haven't gone out yet. Posted posts' media is left out: it's no longer needed.
 */
export async function createBackup(options: {
  dataDir: string;
  passphrase: string;
  /** Where to write it. Defaults to a dated file in backupDir. */
  out?: string;
  backupDir: string;
  /** The key protecting stored secrets, to unlock them for the backup. Defaults to this installation's DATA_KEY. */
  dataKey?: Buffer | null;
}): Promise<BackupResult> {
  if (options.passphrase.length < MIN_PASSPHRASE) {
    throw new BackupError(`The passphrase must be at least ${MIN_PASSPHRASE} characters (a few random words is good).`);
  }
  const dbFile = path.join(options.dataDir, "scheduler.db");
  if (!fs.existsSync(dbFile)) throw new BackupError(`No database found at ${dbFile}. Is this the right data folder?`);

  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), "ss-backup-"));
  try {
    // A snapshot made by SQLite itself, so it's consistent even while the app is writing.
    const live = new DatabaseSync(dbFile, { readOnly: true });
    try {
      live.exec(`VACUUM INTO '${path.join(staging, "scheduler.db").replace(/'/g, "''")}'`);
    } finally {
      live.close();
    }

    // Stored secrets are locked with this installation's DATA_KEY. A backup has to work on any host, so inside
    // the (passphrase-encrypted) backup they are written unlocked, and the host that restores it locks them again.
    unsealSnapshot(path.join(staging, "scheduler.db"), options.dataKey === undefined ? config.dataKey : options.dataKey);

    const snapshot = new DatabaseSync(path.join(staging, "scheduler.db"), { readOnly: true });
    let counts: { accounts: number; posts: number };
    let pendingMedia: string[];
    try {
      const n = (sql: string) => Number((snapshot.prepare(sql).get() as { n: number }).n);
      counts = { accounts: n("SELECT COUNT(*) AS n FROM accounts"), posts: n("SELECT COUNT(*) AS n FROM posts") };
      pendingMedia = (
        snapshot
          .prepare(
            `SELECT DISTINCT p.media_file AS f FROM posts p JOIN targets t ON t.post_id = p.id
              WHERE p.media_file != '' AND t.status IN ('scheduled', 'posting', 'missed', 'failed', 'ready')`,
          )
          .all() as { f: string }[]
      ).map((r) => r.f);
    } finally {
      snapshot.close();
    }
    const pendingPosts = pendingMedia.length;

    await fsp.mkdir(path.join(staging, "media"));
    let mediaFiles = 0;
    for (const file of pendingMedia) {
      const from = path.join(options.dataDir, "media", path.basename(file));
      if (fs.existsSync(from)) {
        await fsp.copyFile(from, path.join(staging, "media", path.basename(file)), fs.constants.COPYFILE_FICLONE);
        mediaFiles++;
      }
    }
    await fsp.writeFile(path.join(staging, "manifest.json"), JSON.stringify({ app: "social-scheduler", version: 1, createdAt: new Date().toISOString() }));

    const tarball = path.join(os.tmpdir(), `ss-backup-${process.pid}-${Date.now()}.tar.gz`);
    await run("tar", ["-czf", tarball, "-C", staging, "."]);

    await fsp.mkdir(options.backupDir, { recursive: true, mode: 0o700 });
    const out = options.out ?? path.join(options.backupDir, `social-scheduler-${stamp()}.ssbackup`);
    try {
      await encryptFile(tarball, out, options.passphrase);
    } finally {
      await fsp.rm(tarball, { force: true });
    }
    return { file: out, bytes: (await fsp.stat(out)).size, ...counts, pendingPosts, mediaFiles };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

function unsealSnapshot(file: string, dataKey: Buffer | null): void {
  const db = new DatabaseSync(file);
  try {
    const unlock = (stored: string): string => {
      try {
        return openSecret(stored, dataKey);
      } catch {
        throw new BackupError("Some stored sign-in details are encrypted and DATA_KEY isn't set to the key they were encrypted with, so they can't go into a backup.");
      }
    };
    db.exec("BEGIN");
    for (const row of db.prepare("SELECT id, config FROM accounts").all() as { id: number; config: string }[]) {
      if (isSealed(row.config)) db.prepare("UPDATE accounts SET config = ? WHERE id = ?").run(unlock(row.config), row.id);
    }
    for (const row of db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[]) {
      if (isSealed(row.value)) db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(unlock(row.value), row.key);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

export interface RestoreResult {
  accounts: number;
  posts: number;
  mediaFiles: number;
  /** Where the data that was there before went, if there was any. */
  movedAside: string | null;
}

/** Puts a backup into a data folder. Whatever was there is moved aside, never deleted. */
export async function restoreBackup(options: {
  file: string;
  passphrase: string;
  dataDir: string;
  /** Restore into the folder as it is (for a mounted disk, which can't be moved aside), replacing only the database and media. */
  inPlace?: boolean;
}): Promise<RestoreResult> {
  if (!fs.existsSync(options.file)) throw new BackupError(`There's no file at ${options.file}.`);
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), "ss-restore-"));
  try {
    const tarball = path.join(staging, "backup.tar.gz");
    await decryptFile(options.file, tarball, options.passphrase);
    const extracted = path.join(staging, "contents");
    await fsp.mkdir(extracted);
    try {
      await run("tar", ["-xzf", tarball, "-C", extracted]);
    } catch {
      throw new BackupError("The backup decrypted but couldn't be unpacked. The file may be damaged.");
    }
    if (!fs.existsSync(path.join(extracted, "manifest.json")) || !fs.existsSync(path.join(extracted, "scheduler.db"))) {
      throw new BackupError("That file decrypted but doesn't look like a Social Scheduler backup.");
    }

    let movedAside: string | null = null;
    if (options.inPlace) {
      for (const suffix of ["", "-wal", "-shm"]) await fsp.rm(path.join(options.dataDir, `scheduler.db${suffix}`), { force: true });
    } else if (fs.existsSync(options.dataDir) && fs.readdirSync(options.dataDir).length > 0) {
      movedAside = `${options.dataDir}.before-restore-${stamp()}`;
      await fsp.rename(options.dataDir, movedAside);
    }
    await fsp.mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await fsp.copyFile(path.join(extracted, "scheduler.db"), path.join(options.dataDir, "scheduler.db"));
    await fsp.mkdir(path.join(options.dataDir, "media"), { recursive: true });
    await fsp.mkdir(path.join(options.dataDir, "thumbs"), { recursive: true });
    let mediaFiles = 0;
    for (const f of fs.existsSync(path.join(extracted, "media")) ? fs.readdirSync(path.join(extracted, "media")) : []) {
      await fsp.copyFile(path.join(extracted, "media", f), path.join(options.dataDir, "media", f));
      mediaFiles++;
    }

    const db = new DatabaseSync(path.join(options.dataDir, "scheduler.db"), { readOnly: true });
    try {
      const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
      return { accounts: n("SELECT COUNT(*) AS n FROM accounts"), posts: n("SELECT COUNT(*) AS n FROM posts"), mediaFiles, movedAside };
    } finally {
      db.close();
    }
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

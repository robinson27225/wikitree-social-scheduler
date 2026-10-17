/**
 * Nightly encrypted backup to a private S3-compatible bucket (Cloudflare R2), so the queue, the sign-ins and
 * the pictures of scheduled posts survive the loss of the server's disk. Each backup is encrypted on the server
 * with BACKUP_PASSPHRASE before it leaves, so the bucket only ever holds noise.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";
import { createBackup } from "./backup.ts";
import { config } from "./config.ts";
import { DATA_DIR, getJsonSetting, setJsonSetting, TMP_DIR } from "./db.ts";
import { clientFor } from "./publicHost.ts";
import { errMsg, notify, notifyDaily } from "./util.ts";

const LAST = "backup_last";

export interface BackupStatus {
  configured: boolean;
  /** When the last backup was tried, and whether it worked. */
  lastAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  lastBytes: number | null;
  lastKey: string | null;
  running: boolean;
  keep: number;
  hour: number;
}

interface Last {
  at: string;
  ok: boolean;
  error?: string;
  bytes?: number;
  key?: string;
}

let running = false;
let lastSuccessDay = "";

const localDay = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

export function backupStatus(): BackupStatus {
  const last = getJsonSetting<Last | null>(LAST, null);
  return {
    configured: config.backup.bucket !== null,
    lastAt: last?.at ?? null,
    lastOk: last ? last.ok : null,
    lastError: last?.error ?? null,
    lastBytes: last?.bytes ?? null,
    lastKey: last?.key ?? null,
    running,
    keep: config.backup.keep,
    hour: config.backup.hour,
  };
}

const stampUtc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** Makes one backup now and uploads it. Throws a plain-English error on failure (and records it). */
export async function runBackup(now = new Date()): Promise<{ key: string; bytes: number }> {
  const target = config.backup.bucket;
  const passphrase = config.backup.passphrase;
  if (!target || !passphrase) throw new Error("Automatic backups aren't set up. See docs/DEPLOY.md.");
  if (running) throw new Error("A backup is already running.");
  running = true;
  const temp = path.join(TMP_DIR, `backup-${stampUtc(now)}.ssbackup`);
  try {
    const made = await createBackup({ dataDir: DATA_DIR, passphrase, out: temp, backupDir: TMP_DIR });
    const key = `${target.prefix}social-scheduler-${stampUtc(now)}.ssbackup`;
    const client = clientFor(target);
    await new Upload({
      client,
      params: { Bucket: target.bucket, Key: key, Body: createReadStream(temp), ContentType: "application/octet-stream" },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    }).done();
    // Make sure it really arrived, at the size we sent.
    const head = await client.send(new HeadObjectCommand({ Bucket: target.bucket, Key: key }));
    if (Number(head.ContentLength) !== made.bytes) throw new Error("The uploaded backup isn't the size it should be.");

    await prune(client, target.bucket, target.prefix, config.backup.keep);
    setJsonSetting(LAST, { at: now.toISOString(), ok: true, bytes: made.bytes, key } satisfies Last);
    lastSuccessDay = localDay(now);
    return { key, bytes: made.bytes };
  } catch (error) {
    const message = errMsg(error);
    setJsonSetting(LAST, { at: now.toISOString(), ok: false, error: message } satisfies Last);
    notify("Backup failed", `The nightly backup didn't work: ${message}`);
    throw error;
  } finally {
    running = false;
    await fsp.rm(temp, { force: true });
  }
}

/** Keeps the newest `keep` backups and deletes the rest. Never touches anything that isn't one of ours. */
async function prune(client: ReturnType<typeof clientFor>, bucket: string, prefix: string, keep: number): Promise<void> {
  const ours: { key: string; at: number }[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      if (o.Key && /social-scheduler-\d{8}T\d{6}Z\.ssbackup$/.test(o.Key)) ours.push({ key: o.Key, at: o.LastModified?.getTime() ?? 0 });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  // The timestamp is in the name, so sort on that rather than trusting the store's clock.
  ours.sort((a, b) => b.key.localeCompare(a.key));
  for (const old of ours.slice(keep)) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: old.key }));
}

/**
 * Called once a minute. Runs the day's backup once the configured hour has come, and if it fails, tries again
 * every half hour until it works (the failure also alerts the team).
 */
export async function maybeRunNightly(now = new Date()): Promise<void> {
  if (!config.backup.bucket || running) return;
  if (now.getHours() < config.backup.hour) return;
  if (lastSuccessDay === localDay(now)) return;
  const last = getJsonSetting<Last | null>(LAST, null);
  if (last?.ok && localDay(new Date(last.at)) === localDay(now)) {
    lastSuccessDay = localDay(now); // done today, before a restart
    return;
  }
  if (last && !last.ok && now.getTime() - Date.parse(last.at) < 30 * 60_000) return; // wait before retrying
  await runBackup(now).catch(() => {}); // already recorded and alerted
}

/** How full the data disk is. Null if the system won't say. */
export async function diskUsage(): Promise<{ totalBytes: number; freeBytes: number; usedPercent: number } | null> {
  try {
    const s = await fsp.statfs(DATA_DIR);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return { totalBytes: total, freeBytes: free, usedPercent: total > 0 ? Math.round(((total - free) / total) * 100) : 0 };
  } catch {
    return null;
  }
}

/** Raises one alert a day while the disk is more than 85% full. */
export async function checkDisk(): Promise<void> {
  const disk = await diskUsage();
  if (disk && disk.usedPercent >= 85) {
    notifyDaily("disk", "Disk nearly full", `The server's data disk is ${disk.usedPercent}% full (${(disk.freeBytes / 1e9).toFixed(1)} GB free). Remove old files from the media library.`);
  }
}

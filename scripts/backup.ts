// Makes an encrypted backup of the queue, accounts and scheduled pictures:  npm run backup
// Needs a passphrase of 12+ characters. Give it with BACKUP_PASSPHRASE=... or type it when asked.
import path from "node:path";
import { BACKUP_DIR } from "../src/brief.ts";
import { BackupError, createBackup, MIN_PASSPHRASE } from "../src/backup.ts";
import { askHidden } from "./prompt.ts";

const dataDir = path.resolve(process.env.SOCIAL_SCHEDULER_DATA ?? "data");
const outIndex = process.argv.indexOf("--out");
const out = outIndex > -1 ? path.resolve(process.argv[outIndex + 1] ?? "") : undefined;

try {
  let passphrase = process.env.BACKUP_PASSPHRASE ?? "";
  if (!passphrase) {
    passphrase = await askHidden(`Passphrase for this backup (${MIN_PASSPHRASE}+ characters): `);
    if (passphrase !== (await askHidden("Type it again: "))) throw new BackupError("The two passphrases didn't match.");
  }
  const result = await createBackup({ dataDir, passphrase, out, backupDir: BACKUP_DIR });
  console.log(`\nBackup saved: ${result.file}`);
  console.log(`  ${result.accounts} accounts, ${result.posts} posts (${result.pendingPosts} not yet posted, ${result.mediaFiles} picture/video files), ${(result.bytes / 1024).toFixed(0)} KB, encrypted.`);
  console.log("\nKeep the passphrase in the team's password manager, NOT next to the file.");
  console.log("Copy the backup file somewhere a teammate can reach (a shared drive is fine, it's encrypted).");
} catch (e) {
  console.error(`\n${e instanceof BackupError ? e.message : e}`);
  process.exit(1);
}

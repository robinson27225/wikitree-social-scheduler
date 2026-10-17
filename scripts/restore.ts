// Loads an encrypted backup on this computer:  npm run restore -- path/to/file.ssbackup
// Whatever is in data/ now is moved aside, never deleted.
import path from "node:path";
import { BackupError, restoreBackup } from "../src/backup.ts";
import { askHidden } from "./prompt.ts";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run restore -- path/to/backup.ssbackup");
  process.exit(1);
}
const dataDir = path.resolve(process.env.SOCIAL_SCHEDULER_DATA ?? "data");

try {
  console.log("Before you restore: make sure the app is NOT running on the old computer or this one.");
  console.log("Two copies running at once would post the same things twice.\n");
  const passphrase = process.env.BACKUP_PASSPHRASE || (await askHidden("Passphrase: "));
  const r = await restoreBackup({ file: path.resolve(file), passphrase, dataDir });
  console.log(`\nRestored: ${r.accounts} accounts, ${r.posts} posts, ${r.mediaFiles} picture/video files.`);
  if (r.movedAside) console.log(`What was in data/ before is now at ${r.movedAside}`);
  console.log("\nNext: npm start, open Settings, and press Test next to each account.");
  console.log("Any that fail need reconnecting (see docs/HANDOVER.md).");
} catch (e) {
  console.error(`\n${e instanceof BackupError ? e.message : e}`);
  process.exit(1);
}

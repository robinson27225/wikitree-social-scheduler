import { all, getSetting, run, setSetting, writeConfig } from "./db.ts";

/** Places this app can't post to by itself (yet). They're added as manual accounts so they show in the "Post to" list. */
const MANUAL_SEEDS = [
  { match: /tiktok/i, label: "WikiTree on TikTok", config: { url: "https://www.tiktok.com/tiktokstudio/upload", maxChars: 2200 } },
  { match: /linkedin/i, label: "WikiTree on LinkedIn", config: { url: "https://www.linkedin.com/company/1360133/admin/", maxChars: 3000 } },
];

/**
 * Adds a manual TikTok account and a manual LinkedIn account, once, unless the team already has one of each (of any
 * kind, such as LinkedIn once it is connected properly). After that they belong to the team: rename or remove them in
 * Settings, and they are never added again.
 */
export function seedManualAccounts(): number {
  if (getSetting("manual_accounts_seeded") === "true") return 0;
  setSetting("manual_accounts_seeded", "true");
  const existing = all("SELECT kind, label FROM accounts");
  let added = 0;
  for (const seed of MANUAL_SEEDS) {
    if (existing.some((a) => seed.match.test(a.kind) || seed.match.test(a.label))) continue;
    run(
      "INSERT INTO accounts (kind, label, config, created_at) VALUES ('manual', ?, ?, ?)",
      seed.label,
      writeConfig(seed.config),
      new Date().toISOString(),
    );
    added++;
  }
  return added;
}

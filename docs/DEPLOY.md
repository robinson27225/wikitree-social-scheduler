# Putting the Social Scheduler on Fly.io

This is the one-time setup that moves the scheduler off a personal computer onto a small always-on server, so it keeps working when nobody's laptop is open and any approved WikiTree team member can use it from a browser.

You will need about 90 minutes, and a terminal. You never paste a secret into a chat or a document: you type or generate each one in your own terminal and save it in the team password manager.

**What you end up with**

- The app at `https://<your-app-name>.fly.dev`, signed in with Google (only approved `@wikitree.com` accounts).
- Sign-in tokens encrypted on the server's disk.
- A nightly encrypted backup in a private Cloudflare R2 bucket.
- Failure alerts in a Discord or Slack channel (optional).

Cost is roughly $5 a month for the server and disk, plus pennies for backups. Check Fly's current prices when you add a card.

---

## 1. Fly.io account and tools

1. Sign up at <https://fly.io> **with your `@wikitree.com` address** and add a payment card.
2. Install the command-line tool and sign in:

   ```bash
   brew install flyctl
   fly auth login
   ```

3. Put the app in an organization rather than your personal space, so it can have more than one owner. In the Fly dashboard, open **Organizations**, create one called `wikitree` (or similar), and invite a second administrator from the same page. Use `-o wikitree` in the commands below.

## 2. Choose the app's name

The name must be unique across Fly. Pick one, for example `wikitree-social-scheduler`. Your address will be `https://wikitree-social-scheduler.fly.dev`.

Edit [`fly.toml`](../fly.toml) in two places so they agree:

- `app = "wikitree-social-scheduler"`
- `PUBLIC_URL = "https://wikitree-social-scheduler.fly.dev"`

## 3. Google sign-in

1. Go to <https://console.cloud.google.com> signed in as your `@wikitree.com` account. Check that the project picker at the top shows the organization `wikitree.com`.
2. Create a **project** (for example "WikiTree Social Scheduler") with **Location** set to the `wikitree.com` organization. If Google won't let you, ask a Workspace administrator to allow it.
3. Search for **Google Auth Platform** and open it. If it shows **Get started**, press it and fill in: app name "WikiTree Social Scheduler", your email as the support and contact email, and for **Audience** choose **Internal**. Internal means only `@wikitree.com` accounts can ever sign in, and Google needs no review. If Internal isn't offered, the project isn't inside the organization.
4. In the left menu choose **Clients**, then **Create client**:
   - Application type: **Web application**
   - Authorized redirect URI: `https://wikitree-social-scheduler.fly.dev/auth/callback` (your real address, exactly). Leave "Authorized JavaScript origins" empty.
   (Older console layouts: **APIs & Services > Credentials > Create credentials > OAuth client ID**.)
5. Copy the **Client ID** and **Client secret** into the password manager for the next step. Google shows the secret in full only when it's created.

## 4. A private bucket for backups (Cloudflare R2)

You already have R2 for the public image host. Backups need a **separate, private** bucket.

1. In Cloudflare, **R2 > Create bucket**, named `wikitree-scheduler-backups`. Leave public access **off**.
2. **R2 > Manage API tokens > Create API token**: permission **Object Read & Write**, limited to **only that bucket**. Copy the Access Key ID and Secret Access Key.
3. Note the S3 address, shown on the R2 page: `https://<account-id>.r2.cloudflarestorage.com`.

## 5. Create the app and its disk

```bash
fly apps create wikitree-social-scheduler -o wikitree
fly volumes create data --size 3 --region sjc -a wikitree-social-scheduler
```

The disk (`data`) is where the database and uploaded media live. One machine only: the disk can't be shared, which is also what stops two copies from posting the same thing twice.

## 6. Set the secrets

Secrets live in Fly's settings, not on the disk next to the data. Generate three, **save each in the team password manager first**, then set everything:

```bash
openssl rand -base64 32     # DATA_KEY: encrypts the stored sign-in tokens
openssl rand -base64 24     # BACKUP_PASSPHRASE: encrypts every backup
openssl rand -base64 32     # BRIEF_TOKEN: lets the daily brief read the digest
```

> **Keep the backup passphrase safe.** Without it, a backup is unreadable noise. Keep `DATA_KEY` too, though a backup can be restored without it.

```bash
fly secrets set -a wikitree-social-scheduler \
  GOOGLE_CLIENT_ID="…" \
  GOOGLE_CLIENT_SECRET="…" \
  ADMIN_EMAILS="you@wikitree.com,second-admin@wikitree.com" \
  DATA_KEY="…" \
  BACKUP_PASSPHRASE="…" \
  BRIEF_TOKEN="…" \
  BACKUP_S3_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
  BACKUP_S3_BUCKET="wikitree-scheduler-backups" \
  BACKUP_S3_ACCESS_KEY_ID="…" \
  BACKUP_S3_SECRET_ACCESS_KEY="…"
```

Optional: `ALERT_WEBHOOK_URL` (a Discord or Slack "incoming webhook" address) so failed posts and failed backups post to a team channel.

What each one does:

| Secret | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `ADMIN_EMAILS` | Who is always an administrator. Every start makes these people active admins again, so this is also the way back in if admins lock themselves out. All must be `@wikitree.com`. |
| `DATA_KEY` | Encrypts stored sign-in tokens and API keys. The app refuses to start with the wrong one. |
| `BACKUP_PASSPHRASE` | Encrypts each backup before it leaves the server |
| `BRIEF_TOKEN` | Read-only key for the daily brief (`Authorization: Bearer …`) |
| `BACKUP_S3_*` | The private backup bucket |
| `ALERT_WEBHOOK_URL` | Optional chat alerts |
| `BACKUP_HOUR`, `BACKUP_KEEP` | Optional: hour of the nightly backup (default 3, server time) and how many to keep (default 14) |

Settings that are not secret (`PUBLIC_URL`, `GOOGLE_ALLOWED_DOMAIN`, `TZ`) are in `fly.toml`.

## 7. First deploy

```bash
fly deploy -a wikitree-social-scheduler
fly status -a wikitree-social-scheduler
fly logs -a wikitree-social-scheduler
```

The first build takes a few minutes. When it's up, open your address, press **Sign in with Google**, and sign in with an `ADMIN_EMAILS` account. If something is wrong, `fly logs` says what: the app refuses to start rather than run unsafely, and tells you which setting is missing.

## 8. After the first sign-in

1. **Settings > Team**: add each person (their `@wikitree.com` address). Check them against the [WikiTree Team list](https://www.wikitree.com/wiki/Help:WikiTree_Team) first. Members schedule and edit posts; administrators also manage accounts, settings and people.
2. **Settings > Backups and disk**: press **Back up now**. It should say "Last backup … encrypted". Confirm the file appears in the R2 bucket.
3. Add the platform sign-ins. Because the app now has a real `https` address, **Connect** works for Facebook/Instagram and Threads without the workarounds (see [SETUP.md](SETUP.md)). In each platform's developer settings, change the redirect address to `https://wikitree-social-scheduler.fly.dev/oauth/callback/<platform>` (the Settings screen shows the exact one).
4. **Settings > Image host**, **Claude**: enter the same details as before.

## Trying it first (recommended)

Before moving the real queue, deploy a throwaway copy to prove everything works:

```bash
fly apps create wikitree-social-scheduler-staging -o wikitree
fly volumes create data --size 1 --region sjc -a wikitree-social-scheduler-staging
# set the same secrets (use a different BACKUP_S3 prefix or bucket if you like)
fly deploy -a wikitree-social-scheduler-staging -e PUBLIC_URL=https://wikitree-social-scheduler-staging.fly.dev
```

Add `https://wikitree-social-scheduler-staging.fly.dev/auth/callback` to the Google OAuth client too. Test sign-in, uploading, scheduling to a **Test account** (kind "dry run"), **Back up now**, then destroy it with `fly apps destroy wikitree-social-scheduler-staging`.

A copy that has any account or post in it is "not empty", so it will not accept a restore. That is why the test runs in its own app.

---

## Restoring a backup (new server, or disaster)

A restore only fills an **empty** installation (no accounts and no posts). A server that already has work in it ignores restore files, so a stray file can never overwrite live data.

1. Get the backup file. From R2 (download from the bucket page), or a copy made on a Mac with `npm run backup`.
2. Make sure `BACKUP_PASSPHRASE` is set to the passphrase that backup was made with.
3. Copy it onto the server's disk:

   ```bash
   fly ssh sftp shell -a wikitree-social-scheduler
   # in the prompt that opens (the server creates /data/restore itself when it starts; this prompt has no mkdir):
   put social-scheduler-20261007T030000Z.ssbackup /data/restore/backup.ssbackup
   ```

4. Restart: `fly apps restart wikitree-social-scheduler`. The log says `Restored from …`, and the file is renamed `.restored`.

Restoring works on a server with a **different** `DATA_KEY`: backups carry the sign-ins unlocked (they are protected by the passphrase), and the new server locks them with its own key.

What a backup contains: accounts and sign-ins, posts and their state, settings, and the pictures/videos of posts that haven't gone out. It does not contain unused library files or posted posts' media.

## Everyday operation

| To… | Run |
|---|---|
| See what's happening | `fly logs -a wikitree-social-scheduler` |
| Update the app after changing code | `fly deploy -a wikitree-social-scheduler` |
| Restart | `fly apps restart wikitree-social-scheduler` |
| Look at the disk | `fly ssh console -a wikitree-social-scheduler` then `df -h /data` |
| Change a secret | `fly secrets set NAME="…" -a wikitree-social-scheduler` (restarts the app) |
| Give a second person control of Fly | Fly dashboard > Organizations > invite |

Deploys restart the single machine, so there is a short gap. Scheduled posts that fell due during it are caught up when it returns (within the grace period set in Settings). Mastodon and Facebook hold their own schedules, so they are unaffected.

## If something goes wrong

- **"Sign-in didn't work"** after pressing the button: the redirect address in the Google client must exactly match `PUBLIC_URL` + `/auth/callback`.
- **"isn't on the approved list"**: add the person in Settings > Team (an administrator can).
- **Locked out of admin**: change `ADMIN_EMAILS` with `fly secrets set` to include someone who can sign in. On restart they become administrators.
- **App won't start, log mentions `DATA_KEY`**: the key doesn't match what the stored sign-ins were encrypted with. Set back the original key, or restore a backup onto a fresh disk with a new key.
- **Backup failing**: Settings > Backups shows the reason. Usual causes are a wrong bucket name, or an R2 token scoped to a different bucket.
- **Disk filling**: remove old files in the media library. The brief and the alert channel warn at 85%.

## Not yet tested on this Mac

The Docker image could not be built on the machine this was written on (no Docker installed), so the **first `fly deploy` is the first real build**. Everything the container runs (the app, its tests with the server in sign-in mode against a stand-in Google, the backup and restore paths) was exercised outside Docker. If the build fails, send the error text from the deploy output.

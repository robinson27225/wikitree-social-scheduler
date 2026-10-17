# Taking over the Social Scheduler

For WikiTree team members. The scheduler runs on a small always-on server (Fly.io), not on anyone's computer, so **most "taking over" is just getting access**. The second half covers the rarer cases: you're the person who now runs the server, or the server has to be rebuilt.

The team's wiki page (Docs:) has the same material with links to where things are kept. This file travels with the program.

- **The app:** <https://wikitree-social-scheduler.fly.dev>
- **Who can use it:** people an administrator has added, signing in with their `@wikitree.com` Google account.

## I just need to use it

1. Ask an administrator to add your `@wikitree.com` address in **Settings > Team**. (They should check you against the [WikiTree Team list](https://www.wikitree.com/wiki/Help:WikiTree_Team) first.)
2. Open the app and press **Sign in with Google**.
3. **Members** can add pictures and videos, schedule posts, edit them per channel, post now, and manage the Queue. **Administrators** can also connect accounts, change settings, and manage who has access.

That's all. There is nothing to install and no computer has to stay on.

## How posts go out

| Channel | Who sends it |
|---|---|
| Facebook (3 Pages), Mastodon | The platform itself holds the schedule |
| Instagram, Threads, Bluesky, LinkedIn | The server, at the scheduled time (it's always running) |
| X, Reddit, YouTube Community tab | **You**: at the scheduled time the post shows as "Ready" in the Queue with Copy text, Download image, Open the page and Mark as posted |

## Every day

- On the **Schedule** tab, **Coming up from your templates** lists the regular posts due in the next 7 days (Question of the Week, One Name Tuesday and so on). Click one, fill in the blanks, add a picture, choose the channels, and schedule. A tick means it is already scheduled. The wording and days are edited in the **Templates** tab.
- If a hand-posted channel (X, Reddit, TikTok, YouTube Community) was marked posted on the wrong post, use **Not posted after all** on that channel's row to put it back as a reminder, or **Edit link** to correct its link.
- For X, Reddit and the YouTube Community tab: if you **Prepare now** and then schedule the post on that site's own tool, press **I've scheduled it there** in the Queue. It stops asking for attention until its time, then asks you to check it went out and mark it posted.
- To record a post on the wiki's social media posts table: in the **Queue**, **Wiki table row** on a posted post (or **Wiki table rows (last 7 days)**) gives the whole row to paste (day, subject, a link per platform, and the YouTube and G2G cell). If it asks for a blank (an image name, a profile id), fill it in. Paste each hand-posted (X, Reddit) link when you mark it posted, or its cell stays empty.
- Weeks differ with what is on the WikiTree calendar: click the small x on an item in **Coming up** to skip it that week.
- The **Stats** tab shows how posts did (views, reach, engagements, link clicks and so on) by channel, by regular post and one by one. The app reads them by itself a day, a week and a month after each post; **Refresh numbers now** does it straight away, and **Export (month)** downloads the month before last (on 5 October, August) as a spreadsheet with one row per day per channel, and then asks an administrator whether to clear that month's numbers from the app. Do it early each month, once the file is saved somewhere safe; the posts themselves are never removed. Once a month, use **Import TikTok file** with the content download from TikTok Studio. If a channel is missing numbers, the tab says which permission to add (usually: press Connect again for that platform in Settings).
- Open the **Queue**. Anything under **Needs attention** is waiting for a person: a failed post, a missed post, a manual post ready to be done by hand, or a title still to add.
- For a plain-English digest, see the daily brief section in `for-claude-and-daily-brief.md`.
- If the team chat webhook is set up, failed posts and failed backups also post there.

## I'm now the person who runs the server

You need:
- **Fly.io access:** the app lives in the `wikitree` organization on Fly. Ask a current owner to invite you (Fly dashboard > Organizations). Install `flyctl` (`brew install flyctl`) and run `fly auth login`.
- **The team password manager:** it holds `DATA_KEY`, `BACKUP_PASSPHRASE`, `BRIEF_TOKEN` and the other logins. Never put these on the wiki, in chat or in email.
- **This package** (`npm run package` makes a zip with no secrets) if code ever needs to change. Deploying is `fly deploy -a wikitree-social-scheduler` from that folder.

The full setup and recovery steps are in `DEPLOY.md`: creating the app, the Google sign-in, secrets, backups and restores.

### Reconnecting a channel

Press **Test** next to each account in Settings. Green means it works. Red means its sign-in no longer works and only that account needs reconnecting.

| Channel | What you need | How |
|---|---|---|
| **Mastodon** (genealysis.social) | Login to the @wikitree account | Preferences > Development > New application (scopes `read:accounts`, `read:statuses`, `write:media`, `write:statuses`). Then Settings > Add by hand > Mastodon |
| **Bluesky** | Login to the account | Settings > Privacy and security > App passwords > Add (never the main password). Then Settings > Add by hand > Bluesky |
| **Facebook Pages, Instagram** | Admin on each Page, plus a role (Admin or Developer) on the team's Meta app | Settings > Connect platforms > Facebook and Instagram. The app now has a real `https` address, so **Connect** should work; add the redirect address shown there to the Meta app's settings first. The older route (a token from Meta's Graph API Explorer, see `SETUP.md`) still works as a fallback |
| **Threads** | The @wikitreers profile added as a Threads Tester, and its login | Settings > Connect platforms > Threads. As above, **Connect** should now work over `https`; Meta's token generator is the fallback |
| **LinkedIn** (the WikiTree Page) | Administrator of the Page, and the team's LinkedIn developer app (approved for the Community Management API) | Settings > Connect platforms > LinkedIn > **Connect**, **about every two months**: LinkedIn sign-ins last 60 days and can't renew themselves. Setup is in `SETUP.md` > LinkedIn |
| **YouTube** (videos) | A Google account that manages the WikiTreers channel (a `@wikitree.com` one) | Settings > Connect platforms > YouTube > **Connect**. The client and API setup are in `SETUP.md` > YouTube. Google may keep API uploads private until it audits the project |
| **TikTok** | Nothing to connect: it's a manual account | Just be signed in to TikTok. At the post time the Queue has the text and video ready; you post it there and mark it posted, pasting the link |
| **X, Reddit, YouTube Community** | Nothing to connect: these are manual accounts | Just be signed in to those sites |
| **Image host** (Instagram and Threads pictures) | Access to the team's Cloudflare account | Settings > Image host: endpoint, bucket, public address, and an R2 API token. Press **Test** |
| **Claude drafting** (optional) | An Anthropic API key | Settings > Claude |

Tokens made from a person's own Facebook login can stop working if that person leaves the Page, changes their password or is removed from the Meta app. That is the usual reason a Test fails; the fix is to reconnect.

### Who can get in if the administrators are all away

`ADMIN_EMAILS` (a Fly secret) lists the people who are always administrators. Change it with `fly secrets set ADMIN_EMAILS="…" -a wikitree-social-scheduler`; on the restart those people become active administrators. Every address must be `@wikitree.com`.

## Backups

- **Automatic:** every night around 03:00 server time, the server makes an encrypted backup and uploads it to a private Cloudflare R2 bucket, keeping the newest 14. **Settings > Backups and disk** shows the last one and has a **Back up now** button.
- The passphrase (`BACKUP_PASSPHRASE`) is in the password manager. Without it a backup can't be opened.
- A backup carries the accounts and their sign-ins, posts and their state, settings, and the media of posts not yet sent. It does not carry unused library pictures or posted posts' media.
- **Restoring** onto a new or empty server is in `DEPLOY.md` ("Restoring a backup"). A server that already has accounts or posts ignores restore files, so a stray file can't overwrite live work.

## Rules that keep things safe

- **One server only.** The app must run as a single copy. Two copies would post the same things twice. (Fly is set up with exactly one machine and one disk.)
- **Never put passwords, tokens, backup files or the passphrase in the wiki, chat or email.** Use the password manager.
- **Don't share your sign-in.** Everyone uses their own Google account, and the activity log (Settings > Recent activity) records who did what.
- **Turn off access promptly.** When someone leaves the team, administrators press **Turn off** next to their name in Settings > Team. It takes effect at once.

## If something goes wrong

- **A failed post** shows the platform's own error in the Queue, with a **Retry** button. Nothing retries by itself, so nothing posts twice.
- **Can't sign in:** the error on the sign-in page says why. "Isn't on the approved list" means an administrator needs to add you.
- **The app is down:** `fly status -a wikitree-social-scheduler` and `fly logs -a wikitree-social-scheduler`. `fly apps restart wikitree-social-scheduler` is safe. Scheduled posts are saved on the server's disk.
- **Facebook and Mastodon posts** go out on their own even if the server is briefly down. Bluesky, Instagram and Threads posts that fell due during an outage are caught up when it returns, within the grace period in Settings; later ones show as Missed for a person to decide.

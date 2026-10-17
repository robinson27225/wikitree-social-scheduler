# Social Scheduler

A small web app for scheduling WikiTree's social media posts. Add images and videos by choosing or dragging them into the app (they go in a media library), write (or have Claude draft) the text, choose a date and time, and it posts to the accounts at that time.

**WikiTree runs it on a small always-on server (Fly.io)** at https://wikitree-social-scheduler.fly.dev, where team members sign in with their `@wikitree.com` Google account. See **[docs/HANDOVER.md](docs/HANDOVER.md)** to use it or take it over, and **[docs/DEPLOY.md](docs/DEPLOY.md)** to set up or rebuild the server. The same code also runs on one person's own computer (below), which is how it is developed and tested.

Posts automatically to Facebook Pages, Instagram, Threads, Mastodon, Bluesky, YouTube (video) and a LinkedIn Page (LinkedIn can only post as a Page once its Community Management API approves the app, and its sign-in must be renewed by hand every ~60 days). X, Reddit, TikTok and a YouTube channel's Community tab (which has no API) use *manual accounts*: a reminder at the scheduled time, with the platform's own page opened already filled in. Automatic routes for X, Reddit and TikTok are built too, under "More platforms" in Settings, for if you ever want them. See **[docs/SETUP.md](docs/SETUP.md)** for what to create on each platform, what it costs, and how long approvals take.

## Two ways to run it

| | On the server (how WikiTree uses it) | On one computer (development, or a fallback) |
|---|---|---|
| Setting | `AUTH_MODE=google` | `AUTH_MODE=local` (the default) |
| Who can use it | Approved `@wikitree.com` Google accounts, with administrator and member roles | Anyone at that computer: it only listens on `127.0.0.1` and has no login |
| Stored sign-ins | Encrypted with the `DATA_KEY` secret | Plain, in `data/` |
| Backups | Automatic nightly, encrypted, to a private bucket | `npm run backup` |
| Must the computer stay on? | No | Yes, for Bluesky, Instagram and Threads |

On your own computer:

```bash
npm install     # first time only
npm start       # opens http://localhost:4173
```

While it runs on a Mac it uses `caffeinate` so the Mac doesn't sleep (turn that off in Settings if you prefer). Mastodon and Facebook posts are handed to those platforms, which publish them on time even if the app is closed (see below).

## First-time setup (Settings tab)

- **Bluesky** and **Mastodon** are added by hand (Settings > Add by hand). For Bluesky use an *app password* (Settings > Privacy and security > App passwords), never your main password. For Mastodon create a new application on your instance with the scopes `read:accounts`, `read:statuses`, `write:media` and `write:statuses`.
- **Facebook, Instagram, Threads, LinkedIn and YouTube** use *Connect platforms*: save the developer-app details you create on each platform, press Connect, sign in on the platform's own page, and tick the accounts to add. Everything you need is in [docs/SETUP.md](docs/SETUP.md). **Start the slow ones (Reddit, TikTok, YouTube approvals) first.**
- **Image host** (Settings > Image host): needed for Instagram, Threads and TikTok photos, which only accept images from a public web address. A free Cloudflare R2 bucket is fine. The app uploads each image only for the moment it's needed and deletes it.
- **Claude (optional)**: paste an Anthropic API key (console.anthropic.com) to enable "Draft with Claude" and "Suggest alt text". Without a key you can write or paste text yourself. Edit the **Style guide** so drafts sound like you. The default model is `claude-opus-5-5`; you can change it in Settings (for example to a cheaper Sonnet) if you want lower cost. For a video, Claude sees a still frame.
- A **Test account** type posts nowhere (it writes to `data/dryrun.log`), handy for trying things out.

## How it behaves

- **Each post is a copy.** When you schedule, the image is copied into `data/media`, so moving or renaming the original is safe.
- **Images are resized automatically** to fit each site's limits (Bluesky's is about 1 MB). Your original is never changed.
- **Alt text** is sent with every image. Please fill it in; it's what makes the post accessible.
- **Videos** (mp4, mov) work like images. Platforms that can't take one (or can't take an image, or plain text) are greyed out in the form with the reason, so you can't schedule something that would be refused. Big videos are cloned or streamed rather than loaded into memory.
- **Per-channel control.** One post can go to everything at once, and still differ by channel:
  - **When scheduling**, each channel that can post without the picture has a "post without the image" switch (it remembers your choice, so Mastodon can always skip it). Channels that need a picture, such as Instagram, don't offer it.
  - **In the Queue**, every channel has its own row with its own **Edit** and **Post now**. Edit lets you give that channel its own text (for example different guest tags), its own title (Reddit), or drop the image. Each channel is checked against its own platform's limits, a channel with its own text shows a tag and a preview, and changing the shared text later doesn't touch it. If Facebook or Mastodon is holding the schedule for that channel, the app takes it back and hands over the new version.
  - **"Edit shared text & time"** changes what all the channels without their own text share, and the time.
- **Templates for recurring posts.** The **Templates** tab holds the wording for things that come round again (Question of the Week, One Name Tuesday, Member of the Week, the monthly Member Q&A...). Anyone signed in can add, edit, copy and delete them. A template has the text with `{{blanks}}` for what changes each time, the days it usually goes out (every week, or the 2nd Thursday / 4th Sunday of the month, and so on), and optionally which accounts it usually goes to. On the **Schedule** tab, "Coming up from your templates" lists what is due in the next 7 days (a tick means it is already scheduled); click one, fill in the blanks, and the text, date and time are put in the post for you. Blanks: `{{name}}` is required, `{{name=default}}` is pre-filled, `{{name?}}` may be left blank, `{{name|upper}}` is shown in capitals. A post with a blank still showing is refused, so `{{question}}` can never be published by mistake.
- **Titles.** Reddit and YouTube need a title (and TikTok photos can have one). A Title box appears when you tick one of those accounts. Manual accounts (such as Reddit) can be given their title later, from that channel's Edit button in the Queue; the Queue flags "needs a title" until then.
- **Facebook and YouTube hold their own schedules too**, like Mastodon, so those posts go out even if the Mac is off. For every platform the Queue says who is holding it: "Scheduled on Facebook", or plain "Scheduled" when this app will post it.
- **Manual reminders.** For accounts with no API, the post becomes "Ready" at the scheduled time with a notification, and the Queue offers **Copy text**, **Download the image**, **Open the page** and **Mark as posted**.
- **Notes.** If a platform accepts a post but with a caveat (for example YouTube or TikTok keeping an unaudited app's post private), the Queue shows it beside the post in grey instead of as an error.
- **Mastodon holds its own schedule** (the "Let Mastodon hold the schedule" option, on by default). When you schedule a post, the image and text are uploaded to Mastodon straight away with a publish time, and Mastodon publishes it, so it goes out even if this Mac is off or the app is closed. The Queue shows "Scheduled on Mastodon", and the post turns to "Posted" with a link the next time the app checks (it catches up when you start it).
  - Mastodon needs at least 5 minutes' notice. Posts scheduled sooner, or if Mastodon refuses the handover (for example too many scheduled posts that day; Mastodon limits this), fall back to this app posting at the time. The Queue tells you when that happens.
  - Edit, "Post now" and Cancel all take the copy off Mastodon's schedule first. If that can't be done (offline, or the post is no longer scheduled there), nothing is changed or posted, so you never get duplicates.
  - If a held post disappears from Mastodon without a matching published post (for example you deleted it there), it's flagged "Failed" so you can check before retrying.
- **Bluesky has no scheduling of its own**, so this app posts at the scheduled time and must be running. Posts less than 30 minutes late (adjustable) go out when it starts. Anything later is marked **Missed** in the Queue so you can choose to post it or reschedule it, rather than posting something stale.
- **If a post fails** you get a macOS notification (on a Mac) and a message in the team's Discord/Slack channel if `ALERT_WEBHOOK_URL` is set, and the Queue shows the error with a Retry button. Failures are never retried automatically, to avoid double-posting.
- **Edit or cancel** anything not yet posted from the Queue tab. Posted items stay in the list with a link.

## Daily summary, backups, and handing it over

- **The digest**: `npm run brief` on a computer, or on the server `GET /api/brief?format=text` with the read-only `BRIEF_TOKEN` as a bearer token. It prints a plain-English digest: what needs a person, what's coming in the next 48 hours (and which posts depend on the app running), what went out in the last 24 hours, and warnings such as a sign-in about to expire or no recent backup. It's meant for a daily brief or for Claude to read.
- **Post numbers (Stats tab).** About a day, a week and a month after a post goes out, the app reads its numbers from the platform and keeps them: views, reach, viewers, engagements, content interactions, link clicks, visits, follows, shares, comments, likes and saves, wherever the platform reports them. The tab totals them by channel and by regular post, and **Export (month)** downloads the month before last (on 5 October, August) as one row per day per channel, with each day's posts added up; it then offers to clear that month's numbers from the app (the posts stay), which an administrator confirms. Facebook and Instagram views and reach need the `read_insights` and `instagram_manage_insights` permissions, and Threads needs `threads_manage_insights`: press **Connect** again for those once. TikTok has no API here, so use **Import TikTok file** on the Stats tab with the CSV you download from TikTok Studio. X and Reddit report nothing.
- **Wiki table rows.** For the table on the wiki's social media posts page, each published post can be copied as one row of wiki markup, in that table's layout: `|-` (with the row color for features that have one), the day (`|Mon`), the subject cell (`!{{Tag Link|...}} ...` or `|`), one `|[link Link]` cell per platform in the table's order (Facebook, Twitter, Mastodon, Bluesky, LinkedIn, Instagram, Threads, TikTok, Reddit, with an empty `|` where the post didn't go), and the last cell (a YouTube Community post link, `{{YouTube|id|playlist=...}}`, and `{{G2GLink|id}}`). Use **Wiki table row** on a post in the Queue, or **Wiki table rows (last 7 days)** at the top, and edit the text before copying if you like.
  - Links are the real ones the platforms returned, tidied to match the page: `twitter.com` for X, Reddit without the title, a closing slash. For X and Reddit (posted by hand) the link is whatever you pasted when marking it posted; the dialog says when one is missing.
  - The YouTube video and the G2G post id are read from the post's own text (a `youtube.com/shorts/...` or `watch?v=` link, and a `wikitree.com/g2g/...` link).
  - The **subject cell** comes from the template (Templates tab, "For the wiki table"): its markup can use the same `{{blanks}}` as the post text (the answers are kept with the post), plus blanks that only the wiki needs, such as an image name or a profile id; the dialog asks for those. A template can also set the row color (`background:#F59122;`), whether the subject is bold (the table's `!` header style), and the YouTube playlist.
  - Which column each account uses is set in Settings > Accounts. WikiTree's project and event Facebook Pages are left out by default (only the main Page has a column). Name a manual account "...YouTube Community" and set it to the YouTube column to have its link in the last cell.
  - The same text is at `/api/export/wiki?post=ID&format=text` (or `?days=7`), with `tz=` for the time zone the day is read in.
- **YouTube thumbnail.** For a video going to YouTube, tick **use the first frame as the thumbnail** under that channel when scheduling (it's remembered). The first frame is taken on the server (ffmpeg) and set as the custom thumbnail after the upload. YouTube needs the channel to be verified for custom thumbnails; if it isn't, the video still posts and the Queue explains.
- **Skipping a week.** Each item in "Coming up from your templates" has a small x for a regular post that isn't happening that week (the wiki calendar changes week to week). It moves to a "Not this week" line, where one click brings it back.
- **Published posts with their platform IDs.** The Queue has a download of every published post as a CSV (or JSON at `/api/export/published?format=json`, optionally `from=` and `to=` dates): when, channel, platform, the platform's own post ID, the link, which template it came from, and the text. The ID is the platform's (a Mastodon status id, a Facebook post id, a LinkedIn post URN, and so on). Manual accounts (X, Reddit, the YouTube Community tab) have a link you pasted but no ID.
- **`npm run backup`** makes an encrypted backup (passphrase of 12+ characters) of the queue, the accounts' sign-ins and the pictures of posts not yet sent. It's safe to run while the app is running. **`npm run restore -- file.ssbackup`** loads one on another computer; whatever was in `data/` there is moved aside, never deleted.
- **`npm run package`** makes `dist/social-scheduler-<version>-<date>.zip` with the program and guides only: no accounts, tokens or scheduled posts (it only ever includes an allow-list of folders, so `data/`, `backups/` and `.env` can't slip in).
- **[docs/HANDOVER.md](docs/HANDOVER.md)** is the step-by-step for a team member taking over, and [docs/wikitree-docs-page.txt](docs/wikitree-docs-page.txt) is the same runbook as WikiTree wiki markup for a team-only Docs: page. [docs/for-claude-and-daily-brief.md](docs/for-claude-and-daily-brief.md) is a summary to paste into Claude's instructions or a daily brief.

## Keeping a Mac awake (caffeinate), when running on one

The app runs `caffeinate -i -s -w <its own pid>`: no idle sleep, and no system sleep while plugged in. It stops automatically when the app stops. The screen can still turn off. A closed laptop lid on battery power will still sleep, so leave the lid open and plugged in for overnight Bluesky posts. Mastodon posts held by Mastodon don't need this.

## Where things are stored

Everything is in one data folder (`data/` on a computer, the mounted disk `/data` on Fly), readable only by the app: the SQLite database (account tokens, saved developer-app secrets, users and the activity log), the media library, copied post media, and thumbnails. On the server, stored sign-ins and keys are encrypted with `DATA_KEY`; on your own computer they are plain, so treat `data/` like a password file.

In local mode the app only listens on `127.0.0.1` and rejects requests from other sites. In server mode every request needs a signed-in session, every change needs a CSRF token, and only `@wikitree.com` accounts that an administrator has added can sign in.

## Development

```bash
npm test          # unit tests: scheduler, every platform provider and sign-in flow against fake servers, image sizing, OAuth signing
npm run typecheck
npm run dev       # restarts on file changes
```

# Social scheduling: notes for Claude and the daily brief

(Paste or adapt into Claude's memory / project instructions and into the daily brief. Replace the [bracketed] bits.)

## What it is

WikiTree's social media posts are scheduled with the **Social Scheduler**, a small web app that runs on a server (Fly.io) and is open all day at **https://wikitree-social-scheduler.fly.dev**. Team members sign in with their `@wikitree.com` Google account. A post is one image/video plus text, a time, and a set of channels; any channel can have its own wording, title, or skip the image. The code is in `~/code/social-scheduler` (only needed to change the program).

Runbook for the team: [WIKI PAGE URL] (Docs: page, team members only). Setup and recovery: `docs/DEPLOY.md`. Access, reconnecting channels, taking over: `docs/HANDOVER.md`. Platform setup details: `docs/SETUP.md`.

## Channels and how each goes out

- **Facebook** (WikiTree, WikiTree's US Black Heritage Project, WikiTree Day & Symposium) and **Mastodon** (@wikitree on genealysis.social): the platform holds the schedule.
- **LinkedIn** (the WikiTree Page): posted by the server at the scheduled time (LinkedIn has no scheduling). Its sign-in lasts 60 days and must be reconnected by hand; the digest warns two weeks ahead.
- **Instagram** (@wikitreers), **Threads** (@wikitreers) and **Bluesky** (@wikitree.bsky.social): posted by the server at the scheduled time. No one's computer needs to be on. Instagram and Threads pictures go through a Cloudflare R2 image host.
- **X** (WikiTreers, WTChallenge), **Reddit** (r/wikitree) and the **YouTube Community tab**: manual. At post time the Queue shows "Ready" with Copy / Download the image / Open the page / Mark as posted. Reddit needs a title, which can be added later with that channel's Edit button.
- **YouTube** (https://www.youtube.com/@wikitreers, video only; connected in the app as "WikiTree"): the server uploads it, and YouTube holds the schedule. Google may keep API uploads private until it audits the project; the Queue says so beside the post. **TikTok**: manual (a reminder; you post it in TikTok and paste the link), like X and Reddit.

## Checking status (do this first when asked about posts)

The digest is a plain-English summary: NEEDS ATTENTION, the next 48 hours, what was posted in the last 24 hours, and heads-up warnings (expiring sign-ins, backup problems, disk nearly full, image host missing).

```bash
curl -s -H "Authorization: Bearer $SOCIAL_SCHEDULER_BRIEF_TOKEN" \
  "https://wikitree-social-scheduler.fly.dev/api/brief?format=text"
```

- The token (`BRIEF_TOKEN` in the Fly secrets) is **read-only and opens only the digest**, nothing else. Keep it in the team password manager and in whatever runs the daily brief (an environment variable, not typed into chat). The digest includes short previews of upcoming post text, so treat it as team-internal.
- If it returns an error or nothing, the server may be down: tell [the person who runs the server], who can run `fly status -a wikitree-social-scheduler`.

## What to flag in the daily brief

1. Anything under NEEDS ATTENTION (failed, missed, or "Ready" manual posts, or a missing title).
2. Posts due in the next 48 hours.
3. Heads-up warnings: a sign-in expiring soon, a failed or missing automatic backup, disk nearly full, image host not set up.

## Rules

- Scheduling and editing happen in the app, signed in as a person. Claude can help draft post text, titles and alt text, but should never ask for, paste or store tokens, passwords, backup files or the backup passphrase. Those live in [PASSWORD MANAGER NAME].
- Only one copy of the app runs, on purpose (two would post twice).
- Times in the digest are Pacific.

## Useful links

- App: https://wikitree-social-scheduler.fly.dev
- Fly.io dashboard: https://fly.io/dashboard
- Google Cloud (sign-in): https://console.cloud.google.com/
- Meta for Developers (Facebook, Instagram, Threads apps): https://developers.facebook.com/apps/
- LinkedIn developer apps: https://www.linkedin.com/developers/apps
- Graph API Explorer (fallback way to re-authorise Facebook/Instagram): https://developers.facebook.com/tools/explorer/
- Cloudflare dashboard (image host and backup bucket): https://dash.cloudflare.com/
- Anthropic console (API key for drafting): https://console.anthropic.com/
- Mastodon app tokens: https://genealysis.social/settings/applications
- Bluesky app passwords: https://bsky.app/settings/app-passwords

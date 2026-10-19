# Connecting each platform

Each platform wants you to register a small "developer app" before software like this may post for you. That's a one-time job per platform, done in your browser on their site, and then you press **Connect** in the app's Settings tab.

Platform websites change their menus often, so the steps below describe *what to create* rather than exact button labels. Where I could check a fact against the platform's own documentation I say so; where I'm relying on other sources I say that too.

## The plan we settled on

| Where | How | Why |
|---|---|---|
| Bluesky, Mastodon | already working | |
| **Facebook** (3 Pages), **Instagram**, **Threads** | **Connect** (sections below) | No approval needed for Pages you admin; Facebook holds the schedule itself |
| **LinkedIn** (the WikiTree Page) | **Connect** ([LinkedIn](#linkedin) below) | LinkedIn reviews the app before it may post as a Page; it can't hold a schedule, so this app posts at the time |
| **X** (2 accounts) | **Manual account** | X charges per post; manual avoids that |
| **Reddit** | **Manual account** | Reddit requires approval before any API use |
| **YouTube Community tab** | **Manual account** | YouTube has no API for Community posts at all |
| **YouTube** (videos) | **Connect** ([YouTube](#youtube-videos) below) | Uploads video to the channel; YouTube holds the schedule. Google may keep API uploads private until it audits the project. |
| **TikTok** | **Manual account** ([TikTok](#tiktok) below) | TikTok's API would need an audit and a per-post approval screen that doesn't fit scheduled posting, so you post by hand |

A **Manual account** costs nothing and needs no developer app. At the scheduled time the app notifies you, and the Queue opens the platform's own "new post" page already filled in, so posting is a couple of clicks. See [Manual accounts](#manual-accounts-x-reddit-the-youtube-community-tab-or-anything-else) below.

The sections for X, YouTube, TikTok and Reddit further down describe the automatic route, for if you ever want it.

## Start the slow ones first

Some of these involve waiting on a human at the platform. Do these before anything else:

| Platform | Waiting for | Typical wait |
|---|---|---|
| **Reddit** | Approval to use the API at all | Weeks. Their policy says approval is required before accessing data (confirmed on Reddit's own Responsible Builder Policy page). Some sources say new requests close on 31 October 2026; I couldn't confirm that, so apply now. |
| **TikTok** | An audit of your app, before posts can be public | Days to weeks. Until then everything posts private (visible only to you). Confirmed in TikTok's documentation. |
| **YouTube** | An audit of your API project, before uploads can be public | Days to weeks. Until then API uploads are locked private. Confirmed in Google's documentation. |
| **LinkedIn** | Approval of the Community Management API for your app (needed to post as a Page) | Not stated by LinkedIn. Apply early. |
| **Meta (Facebook, Instagram, Threads)** | Nothing beyond being an admin of the Pages, **but the app must be in Live mode** (Development mode hides the posts from the public; see below) | None |
| **X** | Buying API credits | Minutes |

## What each platform can and can't do

| Platform | Text | Image | Video | Who holds the schedule |
|---|---|---|---|---|
| Facebook Pages | yes | yes | yes | **Facebook** (even if your Mac is off), 10 min to 30 days ahead |
| Instagram | no | yes (JPEG, 4:5 to 1.91:1) | yes (Reels) | this app |
| Threads | yes | yes | yes | this app |
| LinkedIn Page | yes | yes (JPEG, PNG, GIF) | yes (MP4, 3 s to 30 min, up to 500 MB) | this app (LinkedIn has no scheduling) |
| X | yes | yes | yes | this app |
| Mastodon | yes | yes | yes | **Mastodon** |
| Bluesky | yes | yes | not yet | this app |
| YouTube | no | no | yes | **YouTube** (uploaded private, with a publish time) |
| TikTok | no | yes (needs a verified web address) | yes | this app |
| Reddit | yes | yes | not yet | this app |
| YouTube Community tab | n/a | n/a | n/a | **No API exists.** Use a *Manual* account: the app reminds you and gets the text and image ready. |

"This app" means the app must be running at the post time. Posts less than 30 minutes late go out when it starts; later ones wait for you.

## Image host (needed for Instagram, Threads and TikTok photos)

Those three fetch the image themselves from a web address, so a file on your Mac won't do. The app uploads each image to a bucket you own for the few seconds it's needed, then deletes it.

Any S3-compatible store works. Cloudflare R2 is simple and its free tier is plenty:

1. In Cloudflare, create an **R2 bucket** (for example `wikitree-social-media`).
2. Make it publicly readable: either enable the bucket's **`r2.dev` public address** (looks like `https://pub-….r2.dev`; fine for Instagram and Threads, though Cloudflare rate-limits it), or connect a **custom domain** you control (sturdier, and required for TikTok photos).
3. Create an **API token** with *Object Read & Write* access to that bucket. Cloudflare shows an **Access Key ID** and **Secret Access Key** once. Copy both.
4. In the app: Settings > **Image host**. Endpoint is `https://<your-account-id>.r2.cloudflarestorage.com`, region `auto`, bucket name, the public address from step 2, and the two keys.
5. Press **Test**. It uploads a tiny image, fetches it from the public address, and deletes it. It tells you what's wrong if any step fails. (An empty bucket answering "404" at its public address is normal; the Test fetches a real file.)

Nothing stays in the bucket afterwards.

## Facebook Pages and Instagram

You are an admin of the three Pages, which is what makes this work without Meta's app review.

1. Go to **developers.facebook.com** and create an app (type **Business**).
2. Add the **Facebook Login** (or Facebook Login for Business) product. In its settings add this app's address as a **Valid OAuth Redirect URI**. The app shows you the exact address in Settings > Connect platforms > Facebook and Instagram.
3. Leave the app in **Development** mode. Don't switch it live.
4. Copy the **App ID** and **App secret** (App settings > Basic) into the app and press **Connect Facebook and Instagram**.
5. On Facebook's page, choose to continue as yourself and **tick all three Pages** (and any linked Instagram accounts) when asked which to allow.
6. Back in the app, tick the accounts you want to add.

### If Meta says "Facebook Login for Business requires advanced access"

Meta's newer dashboard steers Business apps toward *Facebook Login for Business*, which is a different product (it signs in through "configurations", and it wants Meta's Advanced Access before it works). **You don't need it.** Use the token route instead, which needs no sign-in page and no approval:

1. In Settings > Connect platforms > Facebook and Instagram, save the **App ID** and **App secret** (App settings > Basic).
2. Open **developers.facebook.com/tools/explorer** and choose your app in the *Meta App* box.
3. Add the permissions `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic` and `instagram_content_publish` (plus `publish_video` for video), then press **Generate Access Token**. Tick **all three Pages** (and the Instagram account) when Facebook asks.
4. Copy the token, open "Use a token from the Graph API Explorer instead" in the app, paste it, and press **Use this token**. The app exchanges it for permanent Page tokens and lists your Pages and Instagram accounts to add.

If the Explorer won't offer a permission, your app needs the matching *use case* added in the dashboard (for example "Manage everything on your Page" for the `pages_*` permissions, and an Instagram content-publishing use case for the `instagram_*` ones). Meta renames these now and then, so look for the one that lists the permission you need.

The token you paste is only used once, to get the permanent Page tokens. It isn't kept.

Notes:

- Instagram must be a **Professional (Business or Creator)** account **linked to one of your Pages**, or it won't be found.
- The default permission list includes `publish_video`. If Facebook says a permission name is invalid, delete it from the "Permissions to request" box and try again. Meta renames these now and then.
- Facebook holds the schedule itself for Page posts, including photos and videos.
- Instagram: images are converted to JPEG automatically. The shape must be between 4:5 (portrait) and 1.91:1 (landscape); the app tells you when you schedule if a picture is outside that. Instagram allows 100 API-published posts per 24 hours.
- Page access tokens obtained this way don't expire, so there's nothing to renew.

## Threads

Threads refuses any sign-in address that starts with `http://` ("Insecure Login Blocked"), and this app runs on `http://localhost`. So use Meta's **token generator** instead; it needs no sign-in page and no redirect address.

1. In the same Meta app (or a new one), add the **Threads API** use case (Use cases > Access the Threads API > Customize).
2. Add your Threads profile as a **Threads Tester** (App roles > Roles), then **accept the invitation inside Threads** (Threads app or threads.net > Settings > Account > Website permissions > Invites). Without this nothing works.
3. In the Threads use case's settings find the **Threads App ID** and **Threads App secret**. They differ from the main App ID. In the app, open Settings > Connect platforms > Threads and save them.
4. Still in the Threads settings, find the **User Token Generator**, press **Generate Access Token** next to your profile and approve it. Meta's menus move around; look for "User Token Generator" or "Generate access token".
5. Copy the token, open "Use Meta's token generator instead" in the app, paste it, and press **Use this token**. The app checks it, makes it long-lived, and adds your profile.

(The ordinary Connect button also exists. It only works if Meta accepts an `https` redirect address: register `https://localhost:4173/oauth/callback/threads`, put the same address in the Redirect address box, press Connect, and when the page then fails to load, copy its address into the "platform wouldn't send me back" box. The token route above is simpler.)

Threads tokens last 60 days. The app renews them automatically (when they're 30+ days old, and again before a post if one is close to expiring), as long as the app runs at least once every couple of months.

Limits: 500 characters (emoji count as 4), 250 posts per 24 hours. Images and videos go through your image host.

## LinkedIn

Posts to **a LinkedIn Page** (the WikiTree company page) as the Page. LinkedIn does not allow this for just anyone: the developer app has to be approved for the **Community Management API**, and the person who signs in has to be an administrator of the Page. Posting as your own profile is a different, self-serve permission and is *not* what this does.

What LinkedIn's own documentation says (checked October 2026):

- **No scheduling.** A post can only be created as published, so this app sends it at the scheduled time. The server is always on, so that is fine.
- **Sign-ins last 60 days and don't renew themselves.** Programmatic refresh tokens are given only to a limited set of partners. So about every two months someone presses **Connect** for LinkedIn again (one click and an approval; it updates the same account, no duplicate). The daily brief and Settings warn two weeks ahead.
- **Versions.** Every request names an API version (the app uses `202609`). LinkedIn retires each version after about a year, so someone updates `LINKEDIN_VERSION` in `src/providers/linkedin.ts` about once a year (the current versions are listed in LinkedIn's docs).

Set up:

1. Find your Page's numeric ID: open the Page as an administrator, and look at the address, for example `linkedin.com/company/12345678/admin/`. The number is the ID.
2. At <https://www.linkedin.com/developers/apps/new> create an app. Name it, and choose your **LinkedIn Page** in the "LinkedIn Page" box. A Page administrator must then verify the app (Settings tab > Verify).
3. On the app's **Products** tab, request the **Community Management API** (the development tier is enough: this app makes a handful of calls a day). Complete the access form; LinkedIn reviews it. Request it on a **new** app that has no other products: the request is greyed out otherwise.
4. When approved, the **Auth** tab lists the permissions the app has. You need `w_organization_social`. In **Authorized redirect URLs** add `https://wikitree-social-scheduler.fly.dev/oauth/callback/linkedin` (Settings shows the exact address).
5. Copy the **Client ID** and **Client secret** (Auth tab). In the app: Settings > Connect platforms > LinkedIn, save the Client ID, Client secret and Page ID, then press **Connect**, approve as a Page administrator, and tick the Page.

If LinkedIn says a permission is invalid, the box "Permissions to request" can be edited to match the Auth tab. If the Connect button isn't available (running on a computer, where LinkedIn wants `https`), use "Use a token made in LinkedIn's developer portal instead": the token generator at <https://www.linkedin.com/developers/tools/oauth/token-generator> makes one you paste in.

Limits: 3,000 characters; hashtags stay hashtags and the characters LinkedIn treats as formatting (`( ) [ ] { } @ * _ ~ | < >`) are escaped for you, otherwise LinkedIn can cut a post short. Pictures are sent as JPEG; videos must be MP4 (convert `.mov`).

**Not yet tried against the real LinkedIn.** The code follows LinkedIn's documentation and passes its tests against a stand-in LinkedIn, but nobody has posted for real. Expect to adjust something on the first live attempt, and use a test post first.

## X (Twitter): automatic route (optional)

Cost first, because it's different from the others: since February 2026 X charges per use, and the cost depends on the post. The figures I found (from third-party write-ups, not X's own page, so check **developer.x.com** before relying on them) are about $0.015 for a plain text post and about **$0.20 for a post containing a link**. Most WikiTree posts contain a link.

1. At **developer.x.com**, create a project and an app. Buy some API credits.
2. Under the app's **User authentication settings**, choose **OAuth 1.0a**, permission **Read and write**, and add this app's address as a **Callback URI** (use the `127.0.0.1` address the app shows; X is fussy about `localhost`). The Website URL can be any address.
3. Copy the **API Key** and **API Key Secret** into the app.
4. **Sign in to the right X account in your browser first**, then press **Connect X**. Approve it. Repeat for the second account: sign out, sign in as the other account, Connect again. Each one is added separately.

Posts that include media upload the file first (X's v2 media upload) and then post. Alt text is sent when you provide it; if X refuses the alt text the post still goes out. If an account has X Premium, the app detects the longer limit when you connect.

## YouTube videos

Your channel's **Community** tab can't be automated: YouTube's API has no way to create those posts, and that has stayed true through 2026 (the sources I found for that are third-party, but nothing from Google suggests otherwise). Use a **Manual** account for it (below). This section is for uploading actual video.

1. **Use a separate Google Cloud project for YouTube.** The project that signs people in to this app has an *Internal* consent screen, which accepts only real members of the `wikitree.com` organization. A YouTube channel is usually a **Brand Account**, which is *not* a member, so Google refuses it with `Error 403: org_internal`. So make a second project (for example "WikiTree YouTube") and, under **Google Auth Platform**, set **Audience** to **External** and publish it **In production**. It stays unverified, which Google allows for up to 100 users: you see a "Google hasn't verified this app" screen once (Advanced, then Go to the app). Your sign-in project stays Internal.
2. In that project open **APIs & Services > Library**, search for **YouTube Data API v3** and **Enable** it.
3. Under **Google Auth Platform > Clients > Create client** make an OAuth client of type **Web application** and add `https://wikitree-social-scheduler.fly.dev/oauth/callback/google` as an **Authorized redirect URI**. Copy its **Client ID** and **Client secret**.
4. In the app: Settings > Connect platforms > YouTube. Save the Client ID and Client secret, press **Connect**, and approve. In Google's account list choose the **channel** (the Brand Account, for example "WikiTree"). The signed-in person must be an owner or manager of that channel (YouTube Studio: Settings > Permissions). The app reports which channel it connected; if that isn't the right one, remove it and connect again.
5. **Possible private lock.** Google's documentation says videos uploaded by the API from an unaudited project created after July 2020 are locked to **private**. The app asks for public (or a scheduled public time), reads back what YouTube actually did, and if YouTube kept it private says so beside the post in the Queue. To lift the lock, apply for Google's **YouTube API Services audit** (the "Audit and Quota Extension" form: it asks for the organization's details, a privacy policy URL, and evidence of the app). Whether Google approves is up to Google. Until then, change the video to Public in YouTube Studio by hand.

Titles are required for YouTube (it's the video title; the post text becomes the description). YouTube holds the schedule: the app uploads the video private with a publish time.

**Thumbnail.** When you schedule a video to a YouTube channel, a box under that channel says **use the first frame as the thumbnail** (it's remembered for next time). The app then takes the very first frame of the video, makes it a JPEG within YouTube's limits, and sets it after the upload. YouTube only allows custom thumbnails on a **verified channel** (youtube.com/verify, a phone check). If the channel isn't verified, the video still goes up and the Queue says why the thumbnail wasn't set. Without the box ticked, YouTube picks its own.

Quota: an unverified project gets 10,000 units a day, enough for several uploads.

## TikTok

TikTok is a **Manual account**: at the scheduled time the app reminds you, and you post it in TikTok. There is no TikTok developer app to set up.

Why not automatic: TikTok's Direct Post API needs an app audit (posts are private until then), and its rules require the person to choose the privacy level and agree to terms on *each* post, which doesn't fit a scheduler posting later with nobody at the screen. Its upload-to-inbox route still needs a person to finish every post in TikTok, and an approved developer app and demo video.

Add it: Settings > Add by hand > Type **Manual**:
- **Name:** WikiTree on TikTok (the wiki table uses "TikTok" in the name to put its link in the TikTok column).
- **Where you post it:** `https://www.tiktok.com/tiktokstudio/upload`
- **Character limit:** 2200

At the scheduled time the post shows as "Ready" in the Queue with **Copy text**, **Download the video**, **Open the page** and **Mark as posted**. If you schedule it on TikTok's own tool, press **I've scheduled it there** and the Queue stops asking until its time. Paste the link to the TikTok post when you mark it posted, so it appears in the wiki table row.

The automatic route is still in the app (Settings > Connect platforms > More platforms > TikTok) if the team ever wants to go through TikTok's audit.

## Reddit: automatic route (optional)

Reddit requires approval before any new app uses its API, and it can take weeks.

1. File a request at **support.reddithelp.com** (search for "Responsible Builder Policy" and use the API access request form). Describe it honestly: posting official WikiTree announcements to r/wikitree, your own subreddit, using one account, a handful of posts a week.
2. When approved, at **reddit.com/prefs/apps** create an app of type **web app** and add this app's address as the **redirect uri**.
3. Copy the **client ID** (under the app's name) and **secret** into the app and press **Connect Reddit**.
4. Choose the subreddit when adding the account (default `wikitree`).

Every Reddit post needs a **title**; the app asks for one when you tick a Reddit account. Text goes in as the post body. For an image post, Reddit doesn't allow body text, so the app adds your text as the first comment.

## Manual accounts (X, Reddit, the YouTube Community tab, or anything else)

Settings > **Add by hand** > type **Manual**. Give it a name (for example `X: WikiTreers`) and fill in:

- **Where you post it**: the web address the Queue's **Open the page** button goes to. Put `{text}` and `{title}` in it and they're replaced with the post's text and title, so the page opens already written.
- **Character limit** (optional): warns you while writing if the post is too long for that place.
- **Count links as 23 characters** (tick for X): so a post with a long link isn't wrongly flagged as too long.
- **This place needs a title** (tick for Reddit): adds a required Title box.

Recipes:

| For | Where you post it | Character limit | Ticks |
|---|---|---|---|
| X: WikiTreers | `https://x.com/intent/post?text={text}` | 280 | count links like X |
| X: WTChallenge | `https://x.com/intent/post?text={text}` | 280 | count links like X |
| Reddit r/wikitree | `https://www.reddit.com/r/wikitree/submit?type=TEXT&title={title}&text={text}` | | needs a title |
| YouTube Community | `https://www.youtube.com/@WikiTreers/community` | | |

At the scheduled time the app sends a macOS notification and the post moves to **Needs attention** in the Queue with buttons: **Copy title** (if it has one), **Copy text**, **Download the image**, **Open the page**, and **Mark as posted** (which can record the post's link).

Things to know:

- Each channel can have its **own text and title**: in the Queue press that channel's **Edit**. For example, add the Reddit title there, or add a guest's @tag only on X. "Open the page" then uses that channel's own words.
- The links above open the platform in your browser, so you must be **signed in to the right account there**. For the two X accounts, sign in as the right one before pressing Open (or use two browser profiles).
- Links can pre-fill **text and titles but not images**. Use *Download the image* and drag the picture in.
- X's page opens at x.com's own composer, Reddit's at its submit page. If either site changes its address format, edit the account's address in Settings; nothing else changes.
- YouTube Studio can also schedule Community posts on its own, which may suit you better for that one.

## Post numbers (the Stats tab)

The app reads each posted post's numbers about a day, a week and a month after it goes out. Some need a permission added once:

| Channel | Numbers | What to do |
|---|---|---|
| Mastodon, Bluesky, YouTube | Likes, shares/reposts, comments (YouTube: views too) | Nothing |
| Facebook | Likes, comments, shares now. **Views, viewers and link clicks** need `read_insights` | Settings > Connect platforms > Facebook and Instagram > Connect again (the new permissions are asked for automatically unless you changed the list of permissions by hand; if you did, add `read_insights` and `instagram_manage_insights`) |
| Instagram | Likes and comments now. **Views, reach, shares, saves, follows, profile visits** need `instagram_manage_insights` | The same Connect |
| Threads | Views, likes, replies, reposts, quotes | In the Threads app's dashboard (developers.facebook.com) add the `threads_manage_insights` permission, then Settings > Connect platforms > Threads > Connect again |
| LinkedIn | Impressions (views), unique impressions (reach), clicks, reactions, comments, shares | Nothing beyond the permissions already asked for (`r_organization_social`); it works once the Community Management API is approved |
| TikTok | Whatever is in TikTok Studio's download | Stats tab > **Import TikTok file**, with the per-video content file. Rows are matched by the video's link, or by the day it was posted. Importing again replaces earlier numbers |
| X, Reddit, YouTube Community | None | They can't be read |

The Meta app must be in **Live** mode, which needs no Meta review while the app only touches Pages its role holders administer: people with a role on the app (you and the second admin) can use these permissions on Standard access. If a number is missing, the Stats tab says which permission to add, per channel. **Refresh numbers now** reads everything again straight away.

## Meta app mode: Live, not Development

Keep the Meta app (Facebook and Instagram, and the Threads app) in **Live** mode. While an app is in Development mode, Facebook shows the posts it publishes only to people with a role on the app. They look normal to the team but never reach the public, and their view counts stay near zero. We lost about a week of Facebook posts to this (11 to 19 October 2026) before the Stats tab showed it.

To switch: developers.facebook.com > the app > **App settings > Basic**: fill in the Privacy Policy URL, the app icon and the category, then change **App Mode** at the top from Development to Live. After any change to the app, schedule one test post and open it in a private browser window (not signed in to Facebook) to confirm it is public.

## When something goes wrong

- A failed post shows the platform's own error message in the Queue, with a **Retry** button. Nothing retries automatically, so nothing is ever posted twice.
- **Test** next to an account re-checks its sign-in and renews any token that needs it.
- A token that was revoked, or an app that lost access, shows up as a failed Test. Run **Connect** again for that platform; the app refreshes the existing account rather than adding a duplicate.

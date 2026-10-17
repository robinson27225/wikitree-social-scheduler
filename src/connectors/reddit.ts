import { fetchJson, form } from "../http.ts";
import { assertAuthorized, type Connector } from "./types.ts";

export const redditConnector: Connector = {
  id: "reddit",
  label: "Reddit",
  provides: "Your Reddit account, posting to the subreddit you choose",
  optional: true,
  redirectHost: "localhost",
  help:
    "Reddit now requires approval before any new app can use its API: file a request at support.reddithelp.com (Responsible Builder Policy) and wait for a reply, which can take weeks. " +
    "Once approved, at reddit.com/prefs/apps create an app of type web app with this address as its redirect uri, and paste its client ID (under the app's name) and secret here.",
  appFields: [
    { name: "clientId", label: "Client ID", type: "text", required: true },
    { name: "clientSecret", label: "Client secret", type: "password", required: true },
    { name: "redirectUri", label: "Redirect address (only if you need a different one)", type: "url" },
  ],

  async start(app, redirectUri, state) {
    const base = app.authorizeBase || "https://www.reddit.com";
    return {
      url: `${base}/api/v1/authorize?${form({
        client_id: app.clientId,
        response_type: "code",
        state,
        redirect_uri: redirectUri,
        duration: "permanent", // gives us a refresh token
        scope: "identity submit read",
      })}`,
    };
  },

  async finish(app, redirectUri, query) {
    const code = assertAuthorized(query).replace(/#_$/, "");
    const authBase = (app.authBase || "https://www.reddit.com").replace(/\/+$/, "");
    const oauthBase = (app.oauthBase || "https://oauth.reddit.com").replace(/\/+$/, "");
    const basic = Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64");
    const ua = "social-scheduler/0.1";
    const tokens = await fetchJson<{ access_token: string; refresh_token?: string; expires_in: number }>(
      `${authBase}/api/v1/access_token`,
      {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "User-Agent": ua },
        body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
      },
      "Reddit sign-in",
    );
    if (!tokens.refresh_token) throw new Error("Reddit didn't grant lasting access. Try Connect again.");
    const me = await fetchJson<{ name: string }>(
      `${oauthBase}/api/v1/me`,
      { headers: { Authorization: `Bearer ${tokens.access_token}`, "User-Agent": ua } },
      "Reddit profile",
    );
    return [
      {
        kind: "reddit",
        label: `u/${me.name} (Reddit)`,
        detail: `Reddit account u/${me.name}`,
        config: {
          clientId: app.clientId,
          clientSecret: app.clientSecret,
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          username: me.name,
          ...(app.authBase ? { authBase: app.authBase } : {}),
          ...(app.oauthBase ? { oauthBase: app.oauthBase } : {}),
        },
        extraFields: [
          { name: "subreddit", label: "Subreddit to post to, without r/", type: "text", default: "wikitree", required: true },
        ],
      },
    ];
  },
};

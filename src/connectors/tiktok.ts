import { fetchJson, form } from "../http.ts";
import { assertAuthorized, type Connector } from "./types.ts";

export const tiktokConnector: Connector = {
  id: "tiktok",
  label: "TikTok",
  provides: "Your TikTok account",
  optional: true,
  redirectHost: "localhost",
  help:
    "At developers.tiktok.com create an app, add the Login Kit and Content Posting API products (scopes user.info.basic and video.publish) and register a redirect address. " +
    "TikTok may insist on https: if so, register https://localhost:4173/oauth/callback/tiktok, put the same address in the box below, and after you approve, copy the failed page's address into the box that appears. " +
    "Posts stay private (only you can see them) until TikTok audits the app, and photo posts also need your image host's address verified in the TikTok developer portal.",
  appFields: [
    { name: "clientKey", label: "Client key", type: "text", required: true },
    { name: "clientSecret", label: "Client secret", type: "password", required: true },
    { name: "redirectUri", label: "Redirect address (only if you need a different one)", type: "url" },
  ],

  async start(app, redirectUri, state) {
    const base = app.authorizeBase || "https://www.tiktok.com";
    return {
      url: `${base}/v2/auth/authorize/?${form({
        client_key: app.clientKey,
        scope: "user.info.basic,video.publish",
        response_type: "code",
        redirect_uri: redirectUri,
        state,
      })}`,
    };
  },

  async finish(app, redirectUri, query) {
    const code = assertAuthorized(query);
    const api = (app.apiBase || "https://open.tiktokapis.com").replace(/\/+$/, "");
    const tokens = await fetchJson<{
      access_token: string;
      refresh_token: string;
      open_id: string;
      expires_in: number;
      refresh_expires_in: number;
    }>(
      `${api}/v2/oauth/token/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({
          client_key: app.clientKey,
          client_secret: app.clientSecret,
          code: decodeURIComponent(code),
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
      },
      "TikTok sign-in",
    );
    const info = await fetchJson<{ data?: { user?: { display_name?: string } } }>(
      `${api}/v2/user/info/?${form({ fields: "open_id,display_name" })}`,
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      "TikTok profile",
    ).catch(() => ({}) as { data?: { user?: { display_name?: string } } });
    const name = info.data?.user?.display_name ?? "TikTok";
    return [
      {
        kind: "tiktok",
        label: `${name} (TikTok)`,
        detail: `TikTok account ${name}`,
        config: {
          clientKey: app.clientKey,
          clientSecret: app.clientSecret,
          openId: tokens.open_id,
          displayName: name,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          refreshTokenExpiresAt: new Date(Date.now() + tokens.refresh_expires_in * 1000).toISOString(),
          ...(app.apiBase ? { apiBase: app.apiBase } : {}),
        },
        extraFields: [
          {
            name: "privacyLevel",
            label: "Who can see posts",
            type: "text",
            default: "SELF_ONLY",
            help: "SELF_ONLY (private; the only choice until TikTok audits your app), PUBLIC_TO_EVERYONE, FOLLOWER_OF_CREATOR or MUTUAL_FOLLOW_FRIENDS",
          },
          { name: "username", label: "TikTok handle, without @ (used for links)", type: "text", default: "wikitreers" },
        ],
      },
    ];
  },
};

import { fetchJson, form } from "../http.ts";
import { assertAuthorized, type Connector } from "./types.ts";

const SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl";

export const google: Connector = {
  id: "google",
  label: "YouTube",
  provides: "Your YouTube channel, for uploading video",
  redirectHost: "localhost",
  help:
    "Uploads videos to your YouTube channel (YouTube's API cannot post to the Community tab: use a Manual account for that). " +
    "In the Google Cloud project (console.cloud.google.com) turn on the YouTube Data API v3, then create an OAuth client ID of type Web application " +
    "and add this redirect address to it. Paste the Client ID and Client secret here, press Connect, and sign in with a Google account that manages the channel. " +
    "Google may keep API uploads private until it audits the project; the Queue says so beside the post if that happens. Details are in docs/SETUP.md.",
  appFields: [
    { name: "clientId", label: "Client ID", type: "text", required: true },
    { name: "clientSecret", label: "Client secret", type: "password", required: true },
    { name: "redirectUri", label: "Redirect address (only if you need a different one)", type: "url" },
  ],

  async start(app, redirectUri, state) {
    const base = app.authorizeBase || "https://accounts.google.com";
    return {
      url: `${base}/o/oauth2/v2/auth?${form({
        client_id: app.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPES,
        access_type: "offline", // gives us a refresh token
        prompt: "consent", // makes Google send the refresh token every time
        state,
      })}`,
    };
  },

  async finish(app, redirectUri, query) {
    const code = assertAuthorized(query);
    const tokenUrl = app.tokenUrl || "https://oauth2.googleapis.com/token";
    const tokens = await fetchJson<{ access_token: string; refresh_token?: string; expires_in: number }>(
      tokenUrl,
      {
        method: "POST",
        body: form({
          code,
          client_id: app.clientId,
          client_secret: app.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      },
      "Google sign-in",
    );
    if (!tokens.refresh_token) {
      throw new Error("Google didn't grant lasting access. Remove this app at myaccount.google.com/permissions and run Connect again.");
    }
    const api = app.apiBase || "https://www.googleapis.com";
    const channels = await fetchJson<{ items?: { id: string; snippet: { title: string } }[] }>(
      `${api}/youtube/v3/channels?${form({ part: "snippet", mine: "true" })}`,
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      "YouTube channel lookup",
    );
    const channel = channels.items?.[0];
    if (!channel) throw new Error("That Google account has no YouTube channel.");
    return [
      {
        kind: "youtube",
        label: `${channel.snippet.title} (YouTube)`,
        detail: `YouTube channel ${channel.snippet.title}`,
        config: {
          clientId: app.clientId,
          clientSecret: app.clientSecret,
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
          channelId: channel.id,
          channelTitle: channel.snippet.title,
          ...(app.apiBase ? { apiBase: app.apiBase } : {}),
          ...(app.tokenUrl ? { tokenUrl: app.tokenUrl } : {}),
        },
        extraFields: [
          { name: "privacy", label: "Visibility of uploads", type: "text", default: "public", help: "public, unlisted or private" },
        ],
      },
    ];
  },
};

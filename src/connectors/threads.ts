import { fetchJson, form } from "../http.ts";
import { assertAuthorized, type Connector } from "./types.ts";

export const threadsConnector: Connector = {
  id: "threads",
  label: "Threads",
  provides: "Your Threads profile",
  redirectHost: "localhost",
  needsHttps: true,
  help:
    "Threads refuses the http:// address this app uses, so use the token generator below instead of the Connect button. " +
    "In your Meta app add the Threads API use case, add your Threads profile as a Threads Tester and accept the invitation inside Threads. " +
    "Save the Threads App ID and Threads App secret (shown under the Threads settings; they differ from the main App ID), then generate a token and paste it below.",
  appFields: [
    { name: "appId", label: "Threads App ID", type: "text", required: true },
    { name: "appSecret", label: "Threads App secret", type: "password", required: true },
    { name: "redirectUri", label: "Redirect address (only if you need a different one)", type: "url" },
  ],

  async start(app, redirectUri, state) {
    const base = app.authorizeBase || "https://threads.net";
    return {
      url: `${base}/oauth/authorize?${form({
        client_id: app.appId,
        redirect_uri: redirectUri,
        scope: "threads_basic,threads_content_publish,threads_manage_insights",
        response_type: "code",
        state,
      })}`,
    };
  },

  async finish(app, redirectUri, query) {
    const code = assertAuthorized(query);
    const graph = app.graphBase || "https://graph.threads.net";
    const short = await fetchJson<{ access_token: string; user_id: string | number }>(
      `${graph}/oauth/access_token`,
      {
        method: "POST",
        body: form({
          client_id: app.appId,
          client_secret: app.appSecret,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          code: code.replace(/#_$/, ""), // Threads appends "#_" to the code
        }),
      },
      "Threads sign-in",
    );
    const long = await fetchJson<{ access_token: string; expires_in: number }>(
      `${graph}/access_token?${form({ grant_type: "th_exchange_token", client_secret: app.appSecret, access_token: short.access_token })}`,
      {},
      "Threads token exchange",
    );
    const me = await fetchJson<{ id: string; username: string }>(
      `${graph}/v1.0/me?${form({ fields: "id,username", access_token: long.access_token })}`,
      {},
      "Threads profile",
    );
    const now = new Date();
    return [
      {
        kind: "threads",
        label: `@${me.username} (Threads)`,
        detail: `Threads profile @${me.username}`,
        config: {
          threadsUserId: me.id,
          username: me.username,
          accessToken: long.access_token,
          tokenRefreshedAt: now.toISOString(),
          tokenExpiresAt: new Date(now.getTime() + long.expires_in * 1000).toISOString(),
          ...(app.graphBase ? { threadsBase: `${app.graphBase}/v1.0`, threadsRefreshBase: app.graphBase } : {}),
        },
      },
    ];
  },

  tokenHelp: {
    summary: "Use Meta's token generator instead (no sign-in page; works when Threads refuses the redirect address)",
    steps: [
      "Save the Threads App ID and App secret above first.",
      "In your Meta app's dashboard open the Threads API use case (Use cases > Access the Threads API > Customize), then its Settings or Permissions page. Make sure your Threads profile is added as a Threads Tester and that you accepted the invitation inside Threads.",
      "Find the User Token Generator, press Generate Access Token next to your profile, and approve it. (Meta's menu names change, so look for \"User Token Generator\" or \"Generate access token\".)",
      "Copy the token, paste it below, and press Use this token.",
    ],
  },

  async finishWithToken(app, pasted) {
    const token = pasted.trim();
    if (!token) throw new Error("Paste the access token from Meta's token generator.");
    const graph = app.graphBase || "https://graph.threads.net";
    const me = await fetchJson<{ id: string; username: string }>(
      `${graph}/v1.0/me?${form({ fields: "id,username", access_token: token })}`,
      {},
      "Threads token check",
    );

    // A generated token is either short-lived (1 hour) or already long-lived (60 days).
    // Try to make it long-lived, else renew it, so we know exactly when it expires.
    let access = token;
    let expiresInSeconds = 55 * 24 * 3600; // assumed if neither call works (a long-lived token under a day old can't be renewed yet)
    try {
      const long = await fetchJson<{ access_token: string; expires_in: number }>(
        `${graph}/access_token?${form({ grant_type: "th_exchange_token", client_secret: app.appSecret, access_token: token })}`,
        {},
        "Threads token exchange",
      );
      access = long.access_token;
      expiresInSeconds = long.expires_in;
    } catch {
      try {
        const renewed = await fetchJson<{ access_token: string; expires_in: number }>(
          `${graph}/refresh_access_token?${form({ grant_type: "th_refresh_token", access_token: token })}`,
          {},
          "Threads token renewal",
        );
        access = renewed.access_token;
        expiresInSeconds = renewed.expires_in;
      } catch {
        /* keep the assumption above */
      }
    }

    const now = new Date();
    return [
      {
        kind: "threads",
        label: `@${me.username} (Threads)`,
        detail: `Threads profile @${me.username}`,
        config: {
          threadsUserId: me.id,
          username: me.username,
          accessToken: access,
          tokenRefreshedAt: now.toISOString(),
          tokenExpiresAt: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
          ...(app.graphBase ? { threadsBase: `${app.graphBase}/v1.0`, threadsRefreshBase: app.graphBase } : {}),
        },
      },
    ];
  },
};

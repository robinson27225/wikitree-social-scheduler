import { oauth1Header } from "../oauth1.ts";
import type { Connector } from "./types.ts";

/** X still uses OAuth 1.0a here: its tokens don't expire, and it's what media uploads require. */
export const xConnector: Connector = {
  id: "x",
  label: "X (Twitter)",
  provides: "One X account per sign-in. Run it once per account (WikiTreers, WTChallenge)",
  optional: true,
  redirectHost: "127.0.0.1",
  stateParam: "oauth_token",
  help:
    "At developer.x.com create a project and app. Under User authentication settings choose OAuth 1.0a with Read and write permission, " +
    "and add this address as a Callback URI (also fill the Website URL with any address). Paste the API Key and API Key Secret here. " +
    "Before each Connect, make sure your browser is signed in to the X account you want to add: run it once for each account. " +
    "X now charges per post (credits are bought in the developer portal).",
  appFields: [
    { name: "consumerKey", label: "API Key", type: "text", required: true },
    { name: "consumerSecret", label: "API Key Secret", type: "password", required: true },
  ],

  async start(app, redirectUri) {
    const base = app.apiBase || "https://api.x.com";
    const creds = { consumerKey: app.consumerKey, consumerSecret: app.consumerSecret };
    const url = `${base}/oauth/request_token`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: oauth1Header("POST", url, creds, { oauth: { oauth_callback: redirectUri } }) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`X sign-in (start) failed (${res.status}): ${text.slice(0, 200)}`);
    const reply = new URLSearchParams(text);
    const token = reply.get("oauth_token");
    const secret = reply.get("oauth_token_secret");
    if (!token || !secret) throw new Error("X didn't return a sign-in token.");
    return {
      url: `${app.authorizeBase || "https://api.x.com"}/oauth/authorize?oauth_token=${encodeURIComponent(token)}`,
      session: { tokenSecret: secret },
      key: token, // X sends this back as oauth_token, instead of a state value
    };
  },

  async finish(app, _redirectUri, query, session) {
    if (query.get("denied")) throw new Error("Sign-in was cancelled or refused on X's page.");
    const requestToken = query.get("oauth_token");
    const verifier = query.get("oauth_verifier");
    if (!requestToken || !verifier) throw new Error("X didn't send back what's needed to finish signing in. Try Connect again.");

    const base = app.apiBase || "https://api.x.com";
    const url = `${base}/oauth/access_token`;
    const creds = {
      consumerKey: app.consumerKey,
      consumerSecret: app.consumerSecret,
      token: requestToken,
      tokenSecret: session.tokenSecret,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: oauth1Header("POST", url, creds, { oauth: { oauth_verifier: verifier } }) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`X sign-in (finish) failed (${res.status}): ${text.slice(0, 200)}`);
    const reply = new URLSearchParams(text);
    const username = reply.get("screen_name") ?? "";
    return [
      {
        kind: "x",
        label: `@${username} (X)`,
        detail: `X account @${username}`,
        config: {
          consumerKey: app.consumerKey,
          consumerSecret: app.consumerSecret,
          token: reply.get("oauth_token") ?? "",
          tokenSecret: reply.get("oauth_token_secret") ?? "",
          username,
          userId: reply.get("user_id") ?? "",
          ...(app.apiBase ? { apiBase: app.apiBase } : {}),
        },
      },
    ];
  },
};


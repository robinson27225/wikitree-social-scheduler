import { fetchJson, form } from "../http.ts";
import { GRAPH_VERSION } from "../providers/graph.ts";
import { assertAuthorized, type Connector } from "./types.ts";

/** Before post statistics were added. A saved setting that is exactly this was never customised, so it gets the new permissions too. */
const PREVIOUS_DEFAULT_SCOPES = "pages_show_list,pages_manage_posts,pages_read_engagement,instagram_basic,instagram_content_publish,publish_video";
const DEFAULT_SCOPES = `${PREVIOUS_DEFAULT_SCOPES},read_insights,instagram_manage_insights`;

const scopesFor = (saved: unknown): string => (!saved || saved === PREVIOUS_DEFAULT_SCOPES ? DEFAULT_SCOPES : String(saved));

interface PageRow {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}

export const meta: Connector = {
  id: "meta",
  label: "Facebook and Instagram",
  provides: "Facebook Pages, and the Instagram accounts linked to them",
  redirectHost: "localhost",
  help:
    "At developers.facebook.com create an app (type: Business), add the Facebook Login for Business or Facebook Login product, and under its settings add this address as a Valid OAuth Redirect URI. " +
    "Switch the app to Live mode once its privacy policy address, icon and category are filled in (App settings > Basic): in Development mode Facebook shows posts made by the app only to people with a role on the app, not to the public. Standard access is enough for Pages you administer, so no Meta review is needed. Then paste the App ID and App Secret here. " +
    "When Facebook asks which Pages to allow, tick all of them.",
  appFields: [
    { name: "appId", label: "App ID", type: "text", required: true },
    { name: "appSecret", label: "App secret", type: "password", required: true },
    {
      name: "scopes",
      label: "Permissions to request",
      type: "text",
      default: DEFAULT_SCOPES,
      help: "Meta occasionally retires permission names. If Facebook says a permission is invalid, remove it here.",
    },
    { name: "redirectUri", label: "Redirect address (only if you need a different one)", type: "url" },
  ],

  async start(app, redirectUri, state) {
    const base = app.dialogBase || `https://www.facebook.com/${GRAPH_VERSION}`;
    const url = `${base}/dialog/oauth?${form({
      client_id: app.appId,
      redirect_uri: redirectUri,
      state,
      response_type: "code",
      scope: scopesFor(app.scopes),
    })}`;
    return { url };
  },

  async finish(app, redirectUri, query) {
    const code = assertAuthorized(query);
    const graph = app.graphBase || `https://graph.facebook.com/${GRAPH_VERSION}`;
    const short = await fetchJson<{ access_token: string }>(
      `${graph}/oauth/access_token?${form({ client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code })}`,
      {},
      "Facebook sign-in",
    );
    return discover(app, short.access_token);
  },

  tokenHelp: {
    summary: "Use a token from the Graph API Explorer instead (no sign-in page needed)",
    steps: [
      "Save the App ID and App secret above first.",
      "Open developers.facebook.com/tools/explorer and pick your app in the Meta App box.",
      "Add the permissions pages_show_list, pages_manage_posts, pages_read_engagement, instagram_basic and instagram_content_publish (plus publish_video for video), then press Generate Access Token. Tick all your Pages, and the Instagram account, when Facebook asks.",
      "Copy the token, paste it below, and the app turns it into permanent Page tokens.",
    ],
  },

  async finishWithToken(app, token) {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Paste the access token from the Graph API Explorer.");
    return discover(app, trimmed);
  },
};

/** From any user token: make it long-lived (which makes the Page tokens non-expiring), then list Pages and Instagram accounts. */
async function discover(app: Record<string, string>, userToken: string) {
  const graph = app.graphBase || `https://graph.facebook.com/${GRAPH_VERSION}`;
  const long = await fetchJson<{ access_token: string }>(
    `${graph}/oauth/access_token?${form({
      grant_type: "fb_exchange_token",
      client_id: app.appId,
      client_secret: app.appSecret,
      fb_exchange_token: userToken,
    })}`,
    {},
    "Facebook token exchange",
  );
  const pages = await fetchJson<{ data: PageRow[] }>(
    `${graph}/me/accounts?${form({
      fields: "id,name,access_token,instagram_business_account{id,username}",
      limit: 100,
      access_token: long.access_token,
    })}`,
    {},
    "Facebook Pages list",
  );
  if (!pages.data?.length) {
    throw new Error(
      "Facebook signed you in but shared no Pages. You need to be an admin of them, the permissions must include pages_show_list, and when Facebook asks which Pages to allow you must tick every Page. Then try again.",
    );
  }

  const found = [];
  for (const page of pages.data) {
    found.push({
      kind: "facebook",
      label: `${page.name} (Facebook)`,
      detail: `Page ${page.name}`,
      config: { pageId: page.id, pageName: page.name, pageToken: page.access_token, ...(app.graphBase ? { graphBase: app.graphBase } : {}) },
    });
    if (page.instagram_business_account) {
      const ig = page.instagram_business_account;
      found.push({
        kind: "instagram",
        label: `@${ig.username ?? page.name} (Instagram)`,
        detail: `Instagram linked to ${page.name}`,
        config: { igUserId: ig.id, username: ig.username ?? "", pageToken: page.access_token, ...(app.graphBase ? { graphBase: app.graphBase } : {}) },
      });
    }
  }
  return found;
}

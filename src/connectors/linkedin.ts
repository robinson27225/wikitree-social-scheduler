import { fetchJson, form } from "../http.ts";
import { LINKEDIN_VERSION } from "../providers/linkedin.ts";
import { assertAuthorized, type AppCreds, type Connector, type DiscoveredAccount } from "./types.ts";

const DEFAULT_SCOPE = "w_organization_social r_organization_social";
const DAY = 24 * 3_600_000;

const authBase = (app: AppCreds) => (app.authBase || "https://www.linkedin.com").replace(/\/+$/, "");
const apiBase = (app: AppCreds) => (app.apiBase || "https://api.linkedin.com").replace(/\/+$/, "");

function organizationId(app: AppCreds): string {
  const id = String(app.organizationId ?? "").trim().replace(/^urn:li:organization:/, "");
  if (!/^\d+$/.test(id)) {
    throw new Error("Enter the Page's numeric ID (the number in the address of the Page's admin view, linkedin.com/company/<number>/admin/).");
  }
  return id;
}

/** The Page's name, if LinkedIn will say. Not needed for posting, so a refusal here is not an error. */
async function pageName(app: AppCreds, token: string, id: string): Promise<string | null> {
  try {
    const org = await fetchJson<{ localizedName?: string }>(
      `${apiBase(app)}/rest/organizations/${id}`,
      { headers: { Authorization: `Bearer ${token}`, "Linkedin-Version": LINKEDIN_VERSION, "X-Restli-Protocol-Version": "2.0.0" } },
      "LinkedIn Page lookup",
    );
    return org.localizedName ?? null;
  } catch {
    return null;
  }
}

async function account(
  app: AppCreds,
  tokens: { access_token: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number },
  expiresAt: string,
): Promise<DiscoveredAccount[]> {
  const id = organizationId(app);
  const name = (await pageName(app, tokens.access_token, id)) ?? `Page ${id}`;
  const now = Date.now();
  return [
    {
      kind: "linkedin",
      label: `${name} (LinkedIn)`,
      detail: `LinkedIn Page ${name}`,
      config: {
        organizationId: id,
        organizationName: name,
        accessToken: tokens.access_token,
        tokenExpiresAt: expiresAt,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(tokens.refresh_token_expires_in ? { refreshTokenExpiresAt: new Date(now + tokens.refresh_token_expires_in * 1000).toISOString() } : {}),
        ...(app.apiBase ? { apiBase: app.apiBase } : {}),
        ...(app.authBase ? { authBase: app.authBase } : {}),
      },
    },
  ];
}

export const linkedinConnector: Connector = {
  id: "linkedin",
  label: "LinkedIn",
  provides: "Your LinkedIn Page",
  redirectHost: "localhost",
  needsHttps: true,
  help:
    "LinkedIn only lets an app post as a Page after reviewing it, and it cannot hold a schedule, so this app posts at the scheduled time. " +
    "At linkedin.com/developers create an app and associate it with your Page (a Page administrator then verifies it). On the app's Products tab request the " +
    "Community Management API (development tier is enough) and wait for approval. On the Auth tab add this redirect address, then paste the Client ID and Client secret here, " +
    "along with the Page's numeric ID (the number in linkedin.com/company/<number>/admin/). LinkedIn sign-ins last 60 days, so this must be reconnected about every two months. " +
    "Details are in docs/SETUP.md.",
  appFields: [
    { name: "clientId", label: "Client ID", type: "text", required: true },
    { name: "clientSecret", label: "Client secret", type: "password", required: true },
    { name: "organizationId", label: "Page ID (the number in the Page's admin address)", type: "text", required: true },
    { name: "scope", label: "Permissions to request (leave as is unless LinkedIn says a permission is invalid)", type: "text", default: DEFAULT_SCOPE },
    { name: "redirectUri", label: "Redirect address (only if you need a different one)", type: "url" },
  ],

  async start(app, redirectUri, state) {
    organizationId(app); // fail now, not after the person has signed in
    return {
      url: `${authBase(app)}/oauth/v2/authorization?${form({
        response_type: "code",
        client_id: app.clientId,
        redirect_uri: redirectUri,
        state,
        scope: app.scope || DEFAULT_SCOPE,
      })}`,
    };
  },

  async finish(app, redirectUri, query) {
    const code = assertAuthorized(query);
    const tokens = await fetchJson<{ access_token: string; expires_in: number; refresh_token?: string; refresh_token_expires_in?: number }>(
      `${authBase(app)}/oauth/v2/accessToken`,
      {
        method: "POST",
        body: form({
          grant_type: "authorization_code",
          code,
          client_id: app.clientId,
          client_secret: app.clientSecret,
          redirect_uri: redirectUri,
        }),
      },
      "LinkedIn sign-in",
    );
    return account(app, tokens, new Date(Date.now() + tokens.expires_in * 1000).toISOString());
  },

  tokenHelp: {
    summary: "Use a token made in LinkedIn's developer portal instead (when the Connect button isn't available)",
    steps: [
      "Save the Client ID, Client secret and Page ID above first.",
      "At linkedin.com/developers/tools/oauth/token-generator choose your app, tick w_organization_social (and r_organization_social), and press Request access token. Approve it as a Page administrator.",
      "Copy the access token, paste it below, and press Use this token.",
    ],
  },

  async finishWithToken(app, pasted) {
    const token = pasted.trim();
    if (!token) throw new Error("Paste the access token from LinkedIn's token generator.");
    organizationId(app);
    // LinkedIn will say how long this token has and what it may do.
    const check = await fetchJson<{ active?: boolean; scope?: string; expires_at?: number }>(
      `${authBase(app)}/oauth/v2/introspectToken`,
      { method: "POST", body: form({ client_id: app.clientId, client_secret: app.clientSecret, token }) },
      "LinkedIn token check",
    );
    if (!check.active) throw new Error("LinkedIn says that token isn't active. Generate a new one.");
    if (!String(check.scope ?? "").split(/[\s,]+/).includes("w_organization_social")) {
      throw new Error("That token doesn't include permission to post as a Page (w_organization_social). Tick it in the token generator and try again.");
    }
    const expiresAt = check.expires_at ? new Date(check.expires_at * 1000).toISOString() : new Date(Date.now() + 59 * DAY).toISOString();
    return account(app, { access_token: token }, expiresAt);
  },
};

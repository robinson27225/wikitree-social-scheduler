import type { Config, FieldSpec } from "../providers/types.ts";

/** The developer-app credentials a person creates on each platform (client id, secret, ...). */
export type AppCreds = Record<string, string>;

/** An account found after signing in, waiting for the person to choose whether to add it. */
export interface DiscoveredAccount {
  /** Provider kind, for example "facebook". */
  kind: string;
  label: string;
  detail: string;
  config: Config;
  /** Extra answers needed before adding (for example which subreddit). */
  extraFields?: FieldSpec[];
}

export interface Connector {
  id: string;
  label: string;
  /** Plain-English steps shown in Settings: what to create on the platform and which address to register. */
  help: string;
  /** Short list of the accounts this connects, shown beside the button. */
  provides: string;
  appFields: FieldSpec[];
  /** The platform's sign-in page refuses http:// addresses, so Connect only works with an https redirect address. */
  needsHttps?: boolean;
  /** Shown under "More platforms": each needs a paid plan or a platform approval before it's useful. */
  optional?: boolean;
  /** Platforms differ on which loopback name they accept in a redirect address. */
  redirectHost: "localhost" | "127.0.0.1";
  /** Which query parameter comes back identifying the sign-in. OAuth 1.0a returns oauth_token, not state. */
  stateParam?: "state" | "oauth_token";
  start(app: AppCreds, redirectUri: string, state: string): Promise<{ url: string; session?: Record<string, string>; key?: string }>;
  finish(app: AppCreds, redirectUri: string, query: URLSearchParams, session: Record<string, string>): Promise<DiscoveredAccount[]>;
  /**
   * Optional: skip the sign-in page and start from a token the person generated on the platform's own
   * tools (for example Meta's Graph API Explorer). Useful when the platform's sign-in product is gated.
   */
  finishWithToken?(app: AppCreds, token: string): Promise<DiscoveredAccount[]>;
  /** What to show above the paste box: a title and numbered steps for making the token. */
  tokenHelp?: { summary: string; steps: string[] };
}

/** Throws a readable error if the platform sent the person back with a refusal. */
export function assertAuthorized(query: URLSearchParams): string {
  const error = query.get("error") ?? query.get("error_reason");
  if (error) {
    const why = query.get("error_description") ?? query.get("error_message") ?? error;
    throw new Error(
      error === "access_denied" || error.startsWith("user_cancelled") ? "Sign-in was cancelled or refused on the platform's page." : `The platform refused the sign-in: ${why}`,
    );
  }
  const code = query.get("code");
  if (!code) throw new Error("The platform didn't send back a sign-in code. Try Connect again.");
  return code;
}

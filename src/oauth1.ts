import crypto from "node:crypto";

/** OAuth 1.0a request signing (HMAC-SHA1). X still uses it for user-context calls, and its tokens don't expire. */

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
}

/** RFC 3986 percent-encoding, which is stricter than encodeURIComponent. */
export function pct(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SignOptions {
  /** Extra oauth_* parameters, such as oauth_callback or oauth_verifier. */
  oauth?: Record<string, string>;
  /** Parameters from a form-encoded body. JSON and multipart bodies are NOT part of the signature. */
  bodyParams?: Record<string, string>;
  /** Fixed values, for tests. */
  nonce?: string;
  timestamp?: string;
}

/** Builds the Authorization header for a request. Query-string parameters are read from the URL. */
export function oauth1Header(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  options: SignOptions = {},
): string {
  const parsed = new URL(url);
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: options.nonce ?? crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: options.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...(creds.token ? { oauth_token: creds.token } : {}),
    ...options.oauth,
  };

  const signed: [string, string][] = [];
  for (const [k, v] of Object.entries(oauthParams)) signed.push([pct(k), pct(v)]);
  for (const [k, v] of parsed.searchParams) signed.push([pct(k), pct(v)]);
  for (const [k, v] of Object.entries(options.bodyParams ?? {})) signed.push([pct(k), pct(v)]);
  signed.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));

  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const baseString = [method.toUpperCase(), pct(baseUrl), pct(signed.map(([k, v]) => `${k}=${v}`).join("&"))].join("&");
  const key = `${pct(creds.consumerSecret)}&${pct(creds.tokenSecret ?? "")}`;
  const signature = crypto.createHmac("sha1", key).update(baseString).digest("base64");

  const header = { ...oauthParams, oauth_signature: signature };
  return (
    "OAuth " +
    Object.entries(header)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
      .join(", ")
  );
}

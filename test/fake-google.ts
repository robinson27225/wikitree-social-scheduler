import crypto from "node:crypto";
import { startFake, type Fake } from "./fake.ts";

export interface Identity {
  sub: string;
  email: string;
  name?: string;
}

/** Ways to make the ID token wrong, to prove the app refuses each one. */
export interface Tweaks {
  aud?: string | string[];
  iss?: string;
  nonce?: string;
  /** Seconds from now; negative means already expired. */
  exp?: number;
  emailVerified?: boolean | string;
  /** Sign with a key Google doesn't publish. */
  signWith?: "attacker";
  /** An unsigned token claiming alg "none", or an HMAC token using the public key as the secret. */
  alg?: "none" | "HS256";
  /** The Workspace domain claim. Left out by default it matches the email's domain; null leaves it out, like a personal Gmail account. */
  hd?: string | null;
  omit?: string[];
}

const b64 = (value: object | Buffer) => (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString("base64url");

export interface FakeGoogle {
  fake: Fake;
  clientId: string;
  clientSecret: string;
  env: Record<string, string>;
  /** Plays the part of the person approving at Google. Returns the address Google would send the browser back to. */
  approve(authorizeUrl: string, identity: Identity, tweaks?: Tweaks): string;
  /** For trying the app by hand in a browser: when set, visiting the sign-in page approves this person automatically. */
  autoApprove: Identity | null;
  tokenRequests(): number;
  close(): void;
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const clientId = "test-client.apps.googleusercontent.com";
  const clientSecret = "test-client-secret";
  const good = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const attacker = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = { ...good.publicKey.export({ format: "jwk" }), kid: "good-key", alg: "RS256", use: "sig" };

  interface Issued {
    idToken: string;
    challenge: string;
    redirectUri: string;
    used: boolean;
  }
  const codes = new Map<string, Issued>();
  let tokenCalls = 0;
  let base = "";

  let self: FakeGoogle;
  const fake = await startFake((req) => {
    if (req.path === "/authorize" && self.autoApprove) {
      return { status: 302, headers: { Location: self.approve(`${base}${req.url}`, self.autoApprove) } };
    }
    if (req.path === "/jwks") return { json: { keys: [publicJwk] } };
    if (req.path === "/token" && req.method === "POST") {
      tokenCalls++;
      const form = req.form();
      const issued = codes.get(form.get("code") ?? "");
      if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) return { status: 401, json: { error: "invalid_client" } };
      if (!issued || issued.used || form.get("grant_type") !== "authorization_code") return { status: 400, json: { error: "invalid_grant" } };
      issued.used = true;
      const verifier = form.get("code_verifier") ?? "";
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (challenge !== issued.challenge || form.get("redirect_uri") !== issued.redirectUri) return { status: 400, json: { error: "invalid_grant" } };
      return { json: { id_token: issued.idToken, access_token: "unused", token_type: "Bearer" } };
    }
    return { status: 404, json: {} };
  });
  base = fake.base;

  const sign = (header: object, payload: object, key: crypto.KeyObject | null) => {
    const input = `${b64(header)}.${b64(payload)}`;
    if (!key) return `${input}.`;
    return `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`;
  };

  self = {
    autoApprove: null,
    fake,
    clientId,
    clientSecret,
    env: {
      GOOGLE_CLIENT_ID: clientId,
      GOOGLE_CLIENT_SECRET: clientSecret,
      GOOGLE_AUTH_URL: `${base}/authorize`,
      GOOGLE_TOKEN_URL: `${base}/token`,
      GOOGLE_JWKS_URL: `${base}/jwks`,
      GOOGLE_ISSUER: "https://accounts.google.com",
    },
    approve(authorizeUrl, identity, tweaks = {}) {
      const url = new URL(authorizeUrl);
      const q = url.searchParams;
      if (q.get("client_id") !== clientId || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256") {
        throw new Error("the app sent a malformed authorization request: " + authorizeUrl);
      }
      if (!q.get("state") || !q.get("nonce") || !q.get("code_challenge")) throw new Error("state, nonce and PKCE challenge are all required");
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        iss: tweaks.iss ?? "https://accounts.google.com",
        aud: tweaks.aud ?? clientId,
        sub: identity.sub,
        email: identity.email,
        email_verified: tweaks.emailVerified ?? true,
        name: identity.name ?? "",
        nonce: tweaks.nonce ?? q.get("nonce"),
        iat: now,
        exp: now + (tweaks.exp ?? 3600),
      };
      const hd = tweaks.hd === undefined ? identity.email.split("@")[1] : tweaks.hd;
      if (hd) claims.hd = hd;
      for (const key of tweaks.omit ?? []) delete claims[key];

      let idToken: string;
      if (tweaks.alg === "none") idToken = sign({ alg: "none", typ: "JWT" }, claims, null);
      else if (tweaks.alg === "HS256") {
        const input = `${b64({ alg: "HS256", typ: "JWT", kid: "good-key" })}.${b64(claims)}`;
        const secret = JSON.stringify(publicJwk);
        idToken = `${input}.${crypto.createHmac("sha256", secret).update(input).digest("base64url")}`;
      } else {
        idToken = sign({ alg: "RS256", typ: "JWT", kid: "good-key" }, claims, tweaks.signWith === "attacker" ? attacker.privateKey : good.privateKey);
      }

      const code = crypto.randomBytes(16).toString("hex");
      const redirectUri = q.get("redirect_uri")!;
      codes.set(code, { idToken, challenge: q.get("code_challenge")!, redirectUri, used: false });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state")!);
      return back.toString();
    },
    tokenRequests: () => tokenCalls,
    close: () => fake.close(),
  };
  return self;
}

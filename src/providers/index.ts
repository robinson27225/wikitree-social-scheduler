import { bluesky } from "./bluesky.ts";
import { dryrun } from "./dryrun.ts";
import { facebook } from "./facebook.ts";
import { instagram } from "./instagram.ts";
import { linkedin } from "./linkedin.ts";
import { manual } from "./manual.ts";
import { mastodon } from "./mastodon.ts";
import { reddit } from "./reddit.ts";
import { threads } from "./threads.ts";
import { tiktok } from "./tiktok.ts";
import { x } from "./x.ts";
import { youtube } from "./youtube.ts";
import type { Config, Provider } from "./types.ts";

export const providers: Record<string, Provider> = {
  [bluesky.kind]: bluesky,
  [mastodon.kind]: mastodon,
  [facebook.kind]: facebook,
  [instagram.kind]: instagram,
  [threads.kind]: threads,
  [linkedin.kind]: linkedin,
  [x.kind]: x,
  [youtube.kind]: youtube,
  [tiktok.kind]: tiktok,
  [reddit.kind]: reddit,
  [manual.kind]: manual,
  [dryrun.kind]: dryrun,
};

export function providerFor(kind: string): Provider {
  const provider = providers[kind];
  if (!provider) throw new Error(`Unknown account type "${kind}"`);
  return provider;
}

/** Config with secrets (password-type fields) removed, safe to send to the browser. */
export function publicConfig(provider: Provider, config: Config): Config {
  const secret = new Set([
    ...provider.fields.filter((f) => f.type === "password").map((f) => f.name),
    ...(provider.secretKeys ?? []),
  ]);
  return Object.fromEntries(Object.entries(config).filter(([key]) => !secret.has(key)));
}

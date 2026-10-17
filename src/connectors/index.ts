import { google } from "./google.ts";
import { linkedinConnector } from "./linkedin.ts";
import { meta } from "./meta.ts";
import { redditConnector } from "./reddit.ts";
import { threadsConnector } from "./threads.ts";
import { tiktokConnector } from "./tiktok.ts";
import type { Connector } from "./types.ts";
import { xConnector } from "./x.ts";

export const connectors: Connector[] = [meta, threadsConnector, linkedinConnector, google, tiktokConnector, xConnector, redditConnector];

export function connectorFor(id: string): Connector {
  const found = connectors.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown connection "${id}"`);
  return found;
}

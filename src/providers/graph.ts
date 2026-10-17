import { ApiError } from "../http.ts";
import type { Config } from "./types.ts";

/** Bump when Meta retires this version (they support each for about two years). */
export const GRAPH_VERSION = "v25.0";

export function graphBase(config: Config): string {
  // `graphBase` exists so tests can point at a fake server.
  return String(config.graphBase || `https://graph.facebook.com/${GRAPH_VERSION}`).replace(/\/+$/, "");
}

/** True when a Graph API error means the object doesn't exist (any more). */
export function isGone(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  const err = (e.body as any)?.error;
  if (e.status === 404) return true;
  if (err?.code === 100) return err?.error_subcode === 33 || /does not exist/i.test(err?.message ?? "");
  // (#10) "Object does not exist, cannot be loaded due to missing permission or reviewable feature": what a Page token gets for
  // a scheduled post that has been deleted (or that Facebook dropped), so there is nothing there to read.
  return err?.code === 10 && /does not exist/i.test(err?.message ?? "");
}

/** Facebook's answer when you ask a node for a field it doesn't have (for example is_published on a Photo). That is a mistake in the question, not proof the post is gone. */
export function isNoSuchField(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  return /nonexisting field/i.test((e.body as any)?.error?.message ?? "");
}

/** The first web address in some text, used to give Facebook a link preview. */
export function firstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s]+/)?.[0]?.replace(/[.,;:!?)]+$/, "");
}

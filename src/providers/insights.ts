import { ApiError } from "../http.ts";
import type { MetricKey, PostStats } from "./types.ts";

/** Fills in the two totals every platform shares, unless the platform gave its own. */
export function withTotals(metrics: PostStats["metrics"]): PostStats["metrics"] {
  const out = { ...metrics };
  const sum = (keys: MetricKey[]) => keys.reduce((n, k) => n + (out[k] ?? 0), 0);
  const any = (keys: MetricKey[]) => keys.some((k) => out[k] !== undefined);
  // "Content interactions": the ways a person responds to the post itself.
  if (out.interactions === undefined && any(["likes", "comments", "shares", "saves"])) {
    out.interactions = sum(["likes", "comments", "shares", "saves"]);
  }
  // "Engagements": the same, plus clicks on its link.
  if (out.engagements === undefined && (out.interactions !== undefined || out.link_clicks !== undefined)) {
    out.engagements = (out.interactions ?? 0) + (out.link_clicks ?? 0);
  }
  return out;
}

/** Facebook-style insight responses: { data: [{ values: [{ value }] }] }, or Instagram's total_value. Objects (clicks by type) pass through. */
export function insightValue(response: any): number | Record<string, number> | undefined {
  const item = response?.data?.[0];
  if (!item) return undefined;
  const value = item.values?.[0]?.value ?? item.total_value?.value;
  if (typeof value === "number") return value;
  if (value && typeof value === "object") return value as Record<string, number>;
  return undefined;
}

/** True for the answers a platform gives when the sign-in lacks permission to read insights. */
export function isPermissionProblem(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  const err = (e.body as any)?.error;
  return e.status === 401 || e.status === 403 || [10, 200, 190, 3].includes(Number(err?.code)) || /permission|scope|not authorized/i.test(String(err?.message ?? ""));
}

/**
 * Asks for each metric on its own. A platform fails the whole request when it doesn't know one name, and they rename
 * metrics now and then, so one retired name must not cost us the others. Stops early on a permission problem, since
 * every further call would fail the same way. Network and other unexpected failures are thrown so the attempt is retried.
 */
export async function eachMetric<T>(
  names: string[],
  ask: (name: string) => Promise<T>,
): Promise<{ values: Record<string, T>; permissionDenied: boolean; unavailable: string[] }> {
  const values: Record<string, T> = {};
  const unavailable: string[] = [];
  for (const name of names) {
    try {
      values[name] = await ask(name);
    } catch (e) {
      if (isPermissionProblem(e)) return { values, permissionDenied: true, unavailable };
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        unavailable.push(name);
        continue;
      }
      throw e;
    }
  }
  return { values, permissionDenied: false, unavailable };
}

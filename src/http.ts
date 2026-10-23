/** Small helpers shared by every platform integration. */

export function form(params: Record<string, string | number | boolean | undefined | null>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return body;
}

/** Pulls the most useful message out of the many shapes platforms use for errors. */
export function errorDetail(body: unknown, fallback: string): string {
  if (typeof body === "string") return body.slice(0, 300) || fallback;
  if (body && typeof body === "object") {
    const b = body as Record<string, any>;
    const candidates = [
      b.error?.message, // Meta, Google
      b.error_description,
      typeof b.error === "string" ? b.error : undefined, // Mastodon, Reddit
      b.message,
      b.detail, // X
      b.errors?.[0]?.message,
      b.error?.error_user_msg,
      b.json?.errors?.[0]?.join?.(": "), // Reddit submit
    ].filter((x) => typeof x === "string" && x);
    if (candidates.length) return String(candidates[0]).slice(0, 300);
  }
  return fallback;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

/** Fetches and parses a response, throwing an ApiError with a readable message if it wasn't OK. */
export async function fetchJson<T = any>(url: string, init: RequestInit = {}, what = "request"): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* not JSON: keep the text */
  }
  if (!res.ok) {
    throw new ApiError(`${what} failed (${res.status}): ${errorDetail(body, res.statusText)}`, res.status, body);
  }
  return body as T;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Calls `check` until it returns a value or the time runs out. */
export async function pollUntil<T>(
  what: string,
  check: () => Promise<T | undefined>,
  { everyMs, timeoutMs }: { everyMs: number; timeoutMs: number },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

/**
 * Gives every network call without its own deadline one (default 30 minutes, long enough for the biggest video upload on a
 * slow line). Without it a connection that stalls could hold a post, and the posts behind it, until the app is restarted.
 */
export function installFetchTimeout(ms = 30 * 60_000): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    original(input, init?.signal ? init : { ...init, signal: AbortSignal.timeout(ms) })) as typeof fetch;
}

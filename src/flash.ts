import type { Response } from "express";
import { config } from "./config.ts";

/**
 * A one-off message for the page the browser is being sent to (a sign-in problem, a platform's refusal). It travels in a
 * short-lived cookie that only this server sets, not in the web address: an address can be written by anyone, so a link
 * could otherwise put misleading words on the sign-in page.
 */
export const FLASH_COOKIE = "flash_error";

export function flashAndRedirect(res: Response, message: string, to = "/", flag = "loginError"): void {
  const value = encodeURIComponent(message.slice(0, 400));
  res.append("Set-Cookie", `${FLASH_COOKIE}=${value}; Path=/; Max-Age=60; SameSite=Lax${config.secureCookies ? "; Secure" : ""}`);
  res.redirect(`${to}?${flag}=1`);
}

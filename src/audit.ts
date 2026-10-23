import type { Request } from "express";
import { all, run } from "./db.ts";

export interface Actor {
  id: number | null;
  email: string;
}

/** Writes one line to the record of who did what. It never throws: a logging problem must not block the action. */
export function audit(who: Actor | Request | null | undefined, action: string, detail = ""): void {
  try {
    let actor: Actor = { id: null, email: "system" };
    if (who && "headers" in who) actor = { id: who.user?.id ?? null, email: who.user?.email ?? "unknown" };
    else if (who) actor = who;
    run("INSERT INTO audit (at, user_id, email, action, detail) VALUES (?, ?, ?, ?, ?)", new Date().toISOString(), actor.id, actor.email, action, detail.slice(0, 500));
  } catch (error) {
    console.error("Couldn't write the audit log:", error);
  }
}

/** The record of who did what is kept for this many days, then trimmed so it can't grow for ever. */
export const AUDIT_KEEP_DAYS = 400;

export function pruneAudit(days = AUDIT_KEEP_DAYS): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return Number(run("DELETE FROM audit WHERE at < ?", cutoff).changes);
}

export function recentAudit(limit = 200) {
  const n = Math.min(Math.max(Math.floor(limit) || 200, 1), 1000);
  return all("SELECT id, at, email, action, detail FROM audit ORDER BY id DESC LIMIT ?", n);
}

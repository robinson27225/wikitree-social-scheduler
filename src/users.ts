import { config } from "./config.ts";
import { all, get, run } from "./db.ts";
import { HttpError } from "./util.ts";

export type Role = "admin" | "member";
export type Status = "active" | "disabled";

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  status: Status;
  googleSub: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (raw: unknown) => String(raw ?? "").trim().toLowerCase();

function userOf(row: Record<string, any>): User {
  return {
    id: Number(row.id),
    email: String(row.email),
    name: String(row.name ?? ""),
    role: row.role === "admin" ? "admin" : "member",
    status: row.status === "disabled" ? "disabled" : "active",
    googleSub: row.google_sub ? String(row.google_sub) : null,
    createdAt: String(row.created_at),
    lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
  };
}

export const listUsers = (): User[] => all("SELECT * FROM users ORDER BY role, email").map(userOf);
export const userById = (id: number): User | null => {
  const row = get("SELECT * FROM users WHERE id = ?", id);
  return row ? userOf(row) : null;
};
export const userByEmail = (email: string): User | null => {
  const row = get("SELECT * FROM users WHERE email = ?", normalizeEmail(email));
  return row ? userOf(row) : null;
};
export const userBySub = (sub: string): User | null => {
  const row = get("SELECT * FROM users WHERE google_sub = ?", sub);
  return row ? userOf(row) : null;
};

const activeAdminCount = () => Number(get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'")?.n ?? 0);

export function addUser(emailRaw: unknown, nameRaw: unknown, roleRaw: unknown): User {
  const email = normalizeEmail(emailRaw);
  if (!EMAIL.test(email)) throw new HttpError(400, "Enter a valid email address.");
  if (config.allowedDomain && !email.endsWith(`@${config.allowedDomain}`)) {
    throw new HttpError(400, `Only @${config.allowedDomain} addresses can be added: that is who Google will let sign in.`);
  }
  if (userByEmail(email)) throw new HttpError(409, "That person is already on the list.");
  const role: Role = roleRaw === "admin" ? "admin" : "member";
  const name = String(nameRaw ?? "").trim().slice(0, 100);
  const result = run("INSERT INTO users (email, name, role, status, created_at) VALUES (?, ?, ?, 'active', ?)", email, name, role, new Date().toISOString());
  return userById(Number(result.lastInsertRowid))!;
}

/** Changes a person's role or access. Refuses anything that could leave nobody able to administer the app. */
export function updateUser(id: number, actingUserId: number | null, changes: { role?: unknown; status?: unknown; name?: unknown }): User {
  const user = userById(id);
  if (!user) throw new HttpError(404, "No such person.");
  const role = changes.role === undefined ? user.role : changes.role === "admin" ? "admin" : changes.role === "member" ? "member" : null;
  const status = changes.status === undefined ? user.status : changes.status === "active" ? "active" : changes.status === "disabled" ? "disabled" : null;
  if (role === null || status === null) throw new HttpError(400, "Role must be admin or member, and status active or disabled.");

  const losesAdmin = user.role === "admin" && user.status === "active" && (role !== "admin" || status !== "active");
  if (losesAdmin) {
    if (id === actingUserId) throw new HttpError(400, "You can't remove your own administrator access. Ask another administrator.");
    if (activeAdminCount() <= 1) throw new HttpError(400, "There must always be at least one active administrator.");
  }
  const name = changes.name === undefined ? user.name : String(changes.name ?? "").trim().slice(0, 100);
  run("UPDATE users SET role = ?, status = ?, name = ? WHERE id = ?", role, status, name, id);
  if (status === "disabled") run("DELETE FROM sessions WHERE user_id = ?", id); // takes effect immediately
  return userById(id)!;
}

export function removeUser(id: number, actingUserId: number | null): User {
  const user = userById(id);
  if (!user) throw new HttpError(404, "No such person.");
  if (id === actingUserId) throw new HttpError(400, "You can't remove yourself. Ask another administrator.");
  if (user.role === "admin" && user.status === "active" && activeAdminCount() <= 1) {
    throw new HttpError(400, "There must always be at least one active administrator.");
  }
  run("DELETE FROM users WHERE id = ?", id);
  return user;
}

/**
 * Makes sure everyone named in ADMIN_EMAILS is an active administrator. This is the way back in if the
 * administrators ever lock themselves out: change the secret and restart.
 */
export function seedAdmins(emails: string[]): void {
  for (const email of emails) {
    const existing = userByEmail(email);
    if (!existing) addUser(email, "", "admin");
    else if (existing.role !== "admin" || existing.status !== "active") run("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?", existing.id);
  }
}

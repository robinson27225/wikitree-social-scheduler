/**
 * Encryption at rest for the things in the database that could be used to post as WikiTree: every
 * account's tokens and the saved API keys. AES-256-GCM, with the key taken from the DATA_KEY secret that
 * lives only in the server's settings, never on the disk next to the data.
 *
 * Values are stored as "enc1:" + base64url(iv + tag + ciphertext). Anything without the prefix is
 * treated as not-yet-encrypted, which lets an existing installation upgrade in place.
 *
 * With no DATA_KEY (your own computer) values stay as they were. This file imports only the config,
 * so the backup tool can use it beside a running app.
 */
import crypto from "node:crypto";
import { config } from "./config.ts";

const PREFIX = "enc1:";
const AAD = Buffer.from("social-scheduler:v1");

export class SecretBoxError extends Error {}

let derived: { source: Buffer; key: Buffer } | null = null;

function keyFor(raw: Buffer | null): Buffer | null {
  if (!raw) return null;
  if (derived?.source === raw) return derived.key;
  // Stretch whatever was supplied to exactly 32 bytes, so a longer secret is fine.
  const key = Buffer.from(crypto.hkdfSync("sha256", raw, Buffer.alloc(0), "social-scheduler secretbox v1", 32));
  derived = { source: raw, key };
  return key;
}

export const isSealed = (stored: string) => stored.startsWith(PREFIX);

export function seal(plain: string, dataKey: Buffer | null = config.dataKey): string {
  const key = keyFor(dataKey);
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function open(stored: string, dataKey: Buffer | null = config.dataKey): string {
  if (!isSealed(stored)) return stored;
  const key = keyFor(dataKey);
  if (!key) throw new SecretBoxError("The stored sign-in details are encrypted, but no DATA_KEY is set.");
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64url");
  if (raw.length < 12 + 16) throw new SecretBoxError("A stored secret is damaged.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAAD(AAD);
  decipher.setAuthTag(raw.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretBoxError("The stored sign-in details couldn't be decrypted. Is DATA_KEY the same one that was used before?");
  }
}

export const sealJson = (value: unknown, dataKey?: Buffer | null) => seal(JSON.stringify(value), dataKey);
export const openJson = <T = Record<string, any>>(stored: string, dataKey?: Buffer | null): T => JSON.parse(open(stored, dataKey)) as T;

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import sharp from "sharp";
import { all, get, LIBRARY_DIR, MEDIA_DIR, run, THUMB_DIR, TMP_DIR } from "./db.ts";
import { mediaKindOf, type MediaKind } from "./media.ts";
import { HttpError } from "./util.ts";

/** Posts made from a library item remember it as `library:<id>` in posts.source_path. */
export const sourceRef = (id: number) => `library:${id}`;

/** A post of pictures can carry this many (Threads and LinkedIn take 20, the most of any platform here). */
export const MAX_IMAGES_PER_POST = 20;

/** The pictures after the first, as stored on a post: our own copy's file name, the library item it came from, and its description. */
export interface ExtraImage {
  file: string;
  source: string;
  alt: string;
}

export function extraImagesOf(raw: unknown): ExtraImage[] {
  try {
    const list = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(list) ? list.filter((e) => e && typeof e.file === "string").map((e) => ({ file: e.file, source: String(e.source ?? ""), alt: String(e.alt ?? "") })) : [];
  } catch {
    return [];
  }
}
export const libraryIdOf = (sourcePath: string): number | null => {
  const m = /^library:(\d+)$/.exec(sourcePath);
  return m ? Number(m[1]) : null;
};

export interface LibraryItem {
  id: number;
  name: string;
  kind: MediaKind;
  size: number;
  createdAt: string;
  state: "new" | "scheduled" | "posted" | "attention";
}

/** The name shown to people: no folders, no control characters, not absurdly long. */
export function cleanName(raw: string): string {
  const base = path.basename(String(raw).replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (base || "upload").slice(0, 120);
}

const IMAGE_FORMAT_EXT: Record<string, string> = { jpeg: ".jpg", png: ".png", webp: ".webp", gif: ".gif" };

/** MP4 / MOV / M4V files carry "ftyp" (or the older "moov"/"mdat") right after a 4-byte size. */
function looksLikeVideo(head: Buffer): boolean {
  if (head.length < 12) return false;
  const tag = head.subarray(4, 8).toString("latin1");
  return tag === "ftyp" || tag === "moov" || tag === "mdat" || tag === "free" || tag === "wide";
}

async function readHead(file: string, bytes = 16): Promise<Buffer> {
  const handle = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export interface Uploaded {
  item: LibraryItem;
  duplicate: boolean;
}

/**
 * Receives one upload as a stream (never held in memory), checks that it really is a picture or video of a
 * kind we allow, and files it under its content hash. Sending the same file twice returns the first copy.
 */
export async function saveUpload(body: Readable, rawName: string, maxBytes: number, reserveBytes = 256 * 1024 * 1024): Promise<Uploaded> {
  const name = cleanName(rawName);
  const kindByName = mediaKindOf(name);
  if (!kindByName) throw new HttpError(400, "Only jpg, png, webp, gif, mp4, mov and m4v files can be added.");

  const free = await fsp.statfs(LIBRARY_DIR).then((s) => Number(s.bavail) * Number(s.bsize), () => Infinity);
  if (free < reserveBytes) throw new HttpError(507, "The server is nearly out of disk space. Delete some files from the library first.");

  const temp = path.join(TMP_DIR, `${crypto.randomUUID()}.part`);
  const hash = crypto.createHash("sha256");
  let size = 0;
  const gate = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(new HttpError(413, `That file is larger than the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`));
      if (size > free - reserveBytes) return cb(new HttpError(507, "Not enough disk space left for that file."));
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(body, gate, fs.createWriteStream(temp, { mode: 0o600 }));
    if (size === 0) throw new HttpError(400, "That file is empty.");

    // The extension we keep comes from what the file really is, not just what it's called.
    let ext: string;
    let kind: MediaKind;
    if (kindByName === "image") {
      let format: string | undefined;
      try {
        format = (await sharp(temp, { failOn: "none" }).metadata()).format;
      } catch {
        format = undefined;
      }
      if (!format || !IMAGE_FORMAT_EXT[format]) throw new HttpError(400, "That doesn't look like a jpg, png, webp or gif picture.");
      ext = IMAGE_FORMAT_EXT[format];
      kind = "image";
    } else {
      if (!looksLikeVideo(await readHead(temp))) throw new HttpError(400, "That doesn't look like an mp4 or mov video.");
      ext = path.extname(name).toLowerCase();
      kind = "video";
    }

    const digest = hash.digest("hex");
    const existing = get("SELECT * FROM library WHERE sha256 = ?", digest);
    if (existing) {
      await fsp.rm(temp, { force: true });
      return { item: itemOf(existing), duplicate: true };
    }
    const stored = `${digest}${ext}`;
    await fsp.rename(temp, path.join(LIBRARY_DIR, stored));
    const row = run(
      "INSERT INTO library (name, stored, sha256, kind, size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      name,
      stored,
      digest,
      kind,
      size,
      new Date().toISOString(),
    );
    return { item: itemOf(get("SELECT * FROM library WHERE id = ?", row.lastInsertRowid)!), duplicate: false };
  } catch (error) {
    await fsp.rm(temp, { force: true });
    throw error;
  }
}

function itemOf(row: Record<string, any>, statuses?: Set<string>): LibraryItem {
  const s = statuses ?? new Set<string>();
  return {
    id: Number(row.id),
    name: String(row.name),
    kind: row.kind as MediaKind,
    size: Number(row.size),
    createdAt: String(row.created_at),
    state:
      s.has("failed") || s.has("missed") || s.has("ready")
        ? "attention"
        : s.has("scheduled") || s.has("posting")
          ? "scheduled"
          : s.has("posted")
            ? "posted"
            : "new",
  };
}

/** Everything in the library, newest first, with whether it has been used. */
export function listLibrary(): LibraryItem[] {
  const used = new Map<number, Set<string>>();
  for (const row of all("SELECT p.source_path, p.extra_media, t.status FROM posts p JOIN targets t ON t.post_id = p.id WHERE p.source_path LIKE 'library:%'")) {
    // The first picture and every extra one count as used by this post.
    for (const source of [String(row.source_path), ...extraImagesOf(row.extra_media).map((e) => e.source)]) {
      const id = libraryIdOf(source);
      if (id === null) continue;
      if (!used.has(id)) used.set(id, new Set());
      used.get(id)!.add(String(row.status));
    }
  }
  return all("SELECT * FROM library ORDER BY id DESC").map((row) => itemOf(row, used.get(Number(row.id))));
}

/** The stored file for a library item, or a 404. The path comes from our own table, never from the request. */
export function libraryFile(id: number): { file: string; row: Record<string, any> } {
  const row = Number.isInteger(id) ? get("SELECT * FROM library WHERE id = ?", id) : undefined;
  if (!row) throw new HttpError(404, "That file isn't in the library.");
  return { file: path.join(LIBRARY_DIR, String(row.stored)), row };
}

/**
 * Removes a file from the library. Posts already made from it keep their own copy, so they are unaffected.
 */
export async function deleteFromLibrary(id: number): Promise<void> {
  const { file, row } = libraryFile(id);
  run("DELETE FROM library WHERE id = ?", id);
  await fsp.rm(file, { force: true });
  for (const edge of [360, 1400]) {
    const key = crypto.createHash("sha1").update(`${row.stored}|${edge}`).digest("hex");
    await fsp.rm(path.join(THUMB_DIR, `${key}.jpg`), { force: true });
  }
}

/**
 * Deletes the pictures and videos in the posts' own folder that no post uses any more (a cancelled post, a failed save). A
 * file younger than `minAgeMs` is left alone, in case a post is being made right now. Returns how many it removed.
 */
export function pruneOrphanMedia(minAgeMs = 24 * 3_600_000): number {
  const used = new Set<string>();
  for (const row of all("SELECT media_file, extra_media FROM posts")) {
    if (row.media_file) used.add(String(row.media_file));
    for (const extra of extraImagesOf(row.extra_media)) used.add(extra.file);
  }
  let removed = 0;
  for (const name of fs.readdirSync(MEDIA_DIR)) {
    if (used.has(name)) continue;
    const file = path.join(MEDIA_DIR, name);
    try {
      const stat = fs.statSync(file);
      // ctime moves when a second name is made for the file, so a library file just linked into a new post counts as new.
      if (!stat.isFile() || (minAgeMs > 0 && Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs) < minAgeMs)) continue;
      fs.rmSync(file, { force: true });
      removed++;
    } catch {
      /* gone already, or not ours to touch */
    }
  }
  return removed;
}

/** Forgets library entries whose file isn't on the disk (for example after restoring a backup, which carries only the media of posts not yet sent). */
export function pruneMissingFiles(): number {
  let removed = 0;
  for (const row of all("SELECT id, stored FROM library")) {
    if (!fs.existsSync(path.join(LIBRARY_DIR, String(row.stored)))) {
      run("DELETE FROM library WHERE id = ?", row.id);
      removed++;
    }
  }
  return removed;
}

export const thumbKey = (stored: string, edge: number) => crypto.createHash("sha1").update(`${stored}|${edge}`).digest("hex");

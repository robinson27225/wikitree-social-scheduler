import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { mediaKindOf } from "./media.ts";

export { IMAGE_EXTENSIONS } from "./media.ts";

export interface PreparedImage {
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
}

const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Returns the original bytes when they already fit the platform's limits,
 * otherwise a downscaled/recompressed JPEG that does.
 */
export async function prepareImage(
  file: string,
  limits: { maxBytes: number; maxEdge: number },
): Promise<PreparedImage> {
  const original = await fs.readFile(file);
  const meta = await sharp(original, { failOn: "none" }).metadata();
  if (!meta.width || !meta.height || !meta.format) {
    throw new Error(`${path.basename(file)} is not a readable image`);
  }

  // EXIF orientations 5-8 mean the stored width/height are swapped.
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;
  const needsOrientationFix = (meta.orientation ?? 1) !== 1;

  const mime = MIME_BY_FORMAT[meta.format];
  if (
    mime &&
    !needsOrientationFix &&
    original.length <= limits.maxBytes &&
    Math.max(width, height) <= limits.maxEdge
  ) {
    return { bytes: original, mime, width, height };
  }

  let edge = Math.min(limits.maxEdge, Math.max(width, height));
  for (let round = 0; round < 6; round++) {
    for (const quality of [90, 82, 74, 66, 58, 50]) {
      const { data, info } = await sharp(original, { failOn: "none" })
        .rotate()
        .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      if (data.length <= limits.maxBytes) {
        return { bytes: data, mime: "image/jpeg", width: info.width, height: info.height };
      }
    }
    edge = Math.floor(edge * 0.8);
  }
  throw new Error(`Could not shrink ${path.basename(file)} below ${limits.maxBytes} bytes`);
}

/** A still frame from a video using ffmpeg (on the server). Null if ffmpeg is missing or can't read it. */
async function ffmpegFrame(file: string, atSeconds = 1): Promise<Buffer | null> {
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      execFile(
        "ffmpeg",
        ["-v", "error", "-ss", String(atSeconds), "-i", file, "-frames:v", "1", "-vf", "scale='min(720,iw)':-2", "-f", "image2pipe", "-vcodec", "png", "-"],
        { timeout: 30_000, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
        (e, stdout) => (e || stdout.length === 0 ? reject(e ?? new Error("no frame")) : resolve(stdout)),
      ),
    );
  } catch {
    // Very short clips have nothing at one second in; try the first frame instead.
    try {
      return await new Promise<Buffer>((resolve, reject) =>
        execFile(
          "ffmpeg",
          ["-v", "error", "-i", file, "-frames:v", "1", "-vf", "scale='min(720,iw)':-2", "-f", "image2pipe", "-vcodec", "png", "-"],
          { timeout: 30_000, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
          (e, stdout) => (e || stdout.length === 0 ? reject(e ?? new Error("no frame")) : resolve(stdout)),
        ),
      );
    } catch {
      return null;
    }
  }
}

/**
 * The very first frame of a video as a JPEG (at most 1280 wide and 2 MB, which suits a YouTube thumbnail). Needs ffmpeg,
 * which the server has. Null when it can't be made, so the caller can carry on without a thumbnail.
 */
export async function firstFrameJpeg(file: string): Promise<Buffer | null> {
  const frame = await ffmpegFrame(file, 0);
  if (!frame) return null;
  for (const quality of [92, 85, 75, 65]) {
    const jpeg = await sharp(frame, { failOn: "none" })
      .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#000000" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (jpeg.length <= 2 * 1024 * 1024) return jpeg;
  }
  return null;
}

/** A still frame from a video using macOS QuickLook, which needs no extra software. Null if it can't. */
async function quickLookFrame(file: string): Promise<Buffer | null> {
  if (process.platform !== "darwin") return null;
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "social-scheduler-ql-"));
  try {
    await new Promise<void>((resolve, reject) =>
      execFile("qlmanage", ["-t", "-s", "720", "-o", out, file], { timeout: 8_000 }, (e) => (e ? reject(e) : resolve())),
    );
    const png = (await fs.readdir(out)).find((f) => f.endsWith(".png"));
    return png ? await fs.readFile(path.join(out, png)) : null;
  } catch {
    return null;
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
}

/** ffmpeg first (works on the server and anywhere it's installed), then QuickLook on a Mac. */
async function videoFrame(file: string): Promise<Buffer | null> {
  return (await ffmpegFrame(file)) ?? (await quickLookFrame(file));
}

const VIDEO_PLACEHOLDER = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360"><rect width="360" height="360" fill="#26302b"/><polygon points="145,110 145,250 255,180" fill="#ffffff" opacity="0.85"/></svg>`,
);

export async function thumbnail(file: string, edge: number): Promise<Buffer> {
  if (mediaKindOf(file) === "video") {
    const frame = await videoFrame(file);
    return sharp(frame ?? VIDEO_PLACEHOLDER)
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: false })
      .jpeg({ quality: 78 })
      .toBuffer();
  }
  return sharp(file, { failOn: "none" })
    .rotate()
    .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
}

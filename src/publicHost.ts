import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getJsonSetting, setJsonSetting } from "./db.ts";

/**
 * Instagram, Threads and TikTok photos only accept media from a public web address. This uploads
 * a file to an S3-compatible bucket (Cloudflare R2, AWS S3, Backblaze B2...) just for the moment
 * it's needed, and deletes it again afterwards.
 */

export interface HostConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Where the bucket is reachable on the web, for example https://media.example.com */
  publicBaseUrl: string;
}

const KEY = "public_host";

export function getHostConfig(): HostConfig | null {
  const c = getJsonSetting<Partial<HostConfig>>(KEY, {});
  if (!c.endpoint || !c.bucket || !c.accessKeyId || !c.secretAccessKey || !c.publicBaseUrl) return null;
  return { region: "auto", ...c } as HostConfig;
}

/** What the browser may see: everything except the secret. */
export function publicHostSettings() {
  const c = getJsonSetting<Partial<HostConfig>>(KEY, {});
  return {
    endpoint: c.endpoint ?? "",
    region: c.region ?? "auto",
    bucket: c.bucket ?? "",
    accessKeyId: c.accessKeyId ?? "",
    publicBaseUrl: c.publicBaseUrl ?? "",
    secretSet: Boolean(c.secretAccessKey),
    configured: getHostConfig() !== null,
  };
}

export function saveHostConfig(update: Partial<HostConfig>): void {
  const current = getJsonSetting<Partial<HostConfig>>(KEY, {});
  const next = { ...current };
  for (const [key, value] of Object.entries(update)) {
    if (typeof value !== "string") continue;
    // A blank secret means "keep the one I already saved".
    if (key === "secretAccessKey" && value.trim() === "") continue;
    (next as Record<string, string>)[key] = value.trim();
  }
  setJsonSetting(KEY, next);
}

export function clientFor(c: Pick<HostConfig, "endpoint" | "region" | "accessKeyId" | "secretAccessKey">): S3Client {
  return new S3Client({
    region: c.region || "auto",
    endpoint: c.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    // R2 and several other S3-compatible stores reject the extra checksums newer SDKs add by default.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export interface HostedFile {
  /** Exactly one of these. Use `file` for large files (streamed), `bytes` for small ones. */
  file?: string;
  bytes?: Buffer;
  contentType: string;
  extension: string;
}

/**
 * Uploads the file, runs `use` with its public URL, then always deletes it again.
 * Throws a plain-English error if no host has been set up.
 */
export async function withPublicUrl<T>(source: HostedFile, use: (url: string) => Promise<T>): Promise<T> {
  const config = getHostConfig();
  if (!config) {
    throw new Error("This platform needs an image host. Set one up in Settings > Image host (Cloudflare R2 or any S3-compatible bucket).");
  }
  const client = clientFor(config);
  const key = `social-scheduler/${crypto.randomUUID()}.${source.extension.replace(/^\./, "")}`;

  if (source.file) {
    await new Upload({
      client,
      params: { Bucket: config.bucket, Key: key, Body: createReadStream(source.file), ContentType: source.contentType },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
    }).done();
  } else {
    await client.send(
      new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: source.bytes, ContentType: source.contentType }),
    );
  }

  try {
    return await use(`${config.publicBaseUrl.replace(/\/+$/, "")}/${key}`);
  } finally {
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })).catch(() => {});
  }
}

// A 1x1 PNG, for the "Test" button.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Uploads a tiny image, checks the public address really serves it, then deletes it. */
export async function testHost(): Promise<string> {
  return withPublicUrl({ bytes: TINY_PNG, contentType: "image/png", extension: "png" }, async (url) => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Uploaded fine, but ${url} returned ${res.status} when fetched. Check that the bucket allows public access and that the public address is right.`,
      );
    }
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) {
      throw new Error(`Uploaded fine, but ${url} served "${type}" instead of an image. The public address may point at the wrong place.`);
    }
    return `Works: uploaded, fetched ${path.basename(url)} from the public address, and deleted it.`;
  });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

process.env.SOCIAL_SCHEDULER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "infra-test-"));
const { oauth1Header, pct } = await import("../src/oauth1.ts");
const { saveHostConfig, withPublicUrl, testHost, getHostConfig, publicHostSettings } = await import("../src/publicHost.ts");
const { pollUntil, errorDetail, fetchJson, ApiError } = await import("../src/http.ts");

describe("OAuth 1.0a signing", () => {
  it("matches X's published signing example", () => {
    // From X's "Creating a signature" documentation (api.x.com host). The expected value is the documented one.
    const header = oauth1Header(
      "POST",
      "https://api.x.com/1.1/statuses/update.json?include_entities=true",
      {
        consumerKey: "xvz1evFS4wEEPTGEFPHBog",
        consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      },
      {
        bodyParams: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
        nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
        timestamp: "1318622958",
      },
    );
    assert.ok(header.includes(`oauth_signature="${pct("Ls93hJiZbQ3akF3HF3x1Bz8/zU4=")}"`), header);
  });

  it("percent-encodes strictly", () => {
    assert.equal(pct("Ladies + Gentlemen!"), "Ladies%20%2B%20Gentlemen%21");
    assert.equal(pct("(*)'"), "%28%2A%29%27");
  });
});

describe("http helpers", () => {
  it("finds the useful message in each platform's error shape", () => {
    assert.equal(errorDetail({ error: { message: "Meta says no" } }, "x"), "Meta says no");
    assert.equal(errorDetail({ error: "invalid_grant", error_description: "Bad code" }, "x"), "Bad code");
    assert.equal(errorDetail({ detail: "X says no" }, "x"), "X says no");
    assert.equal(errorDetail({ json: { errors: [["SUBREDDIT_NOEXIST", "that subreddit doesn't exist"]] } }, "x"), "SUBREDDIT_NOEXIST: that subreddit doesn't exist");
    assert.equal(errorDetail({}, "fallback"), "fallback");
  });

  it("polls until a value arrives, and times out otherwise", async () => {
    let n = 0;
    assert.equal(await pollUntil("thing", async () => (++n >= 3 ? "done" : undefined), { everyMs: 1, timeoutMs: 1000 }), "done");
    await assert.rejects(() => pollUntil("never", async () => undefined, { everyMs: 5, timeoutMs: 30 }), /Timed out waiting for never/);
  });
});

describe("public image host (S3-compatible)", () => {
  const requests: { method: string; url: string; type?: string }[] = [];
  const objects = new Map<string, Buffer>();
  let server: http.Server;
  let base: string;

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        requests.push({ method: req.method!, url: req.url!, type: req.headers["content-type"] });
        const key = req.url!.split("?")[0];
        if (req.method === "PUT") {
          objects.set(key, Buffer.concat(chunks));
          res.writeHead(200, { ETag: '"abc"' }).end();
        } else if (req.method === "DELETE") {
          objects.delete(key);
          res.writeHead(204).end();
        } else if (req.method === "GET" && key.startsWith("/public/")) {
          // The "public web address": serves whatever was stored under the same key.
          const stored = objects.get(key.replace("/public/", "/test-bucket/"));
          if (!stored) return void res.writeHead(404).end();
          res.writeHead(200, { "Content-Type": "image/png" }).end(stored);
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
    fs.rmSync(process.env.SOCIAL_SCHEDULER_DATA!, { recursive: true, force: true });
  });

  it("explains what to do when no host is set up", async () => {
    assert.equal(getHostConfig(), null);
    await assert.rejects(() => withPublicUrl({ bytes: Buffer.from("x"), contentType: "image/png", extension: "png" }, async () => 1), /Settings > Image host/);
  });

  it("never exposes the secret key to the browser, and keeps it when the field is left blank", () => {
    saveHostConfig({
      endpoint: base,
      region: "auto",
      bucket: "test-bucket",
      accessKeyId: "AKIATEST",
      secretAccessKey: "super-secret",
      publicBaseUrl: `${base}/public`,
    });
    assert.equal(JSON.stringify(publicHostSettings()).includes("super-secret"), false);
    assert.equal(publicHostSettings().secretSet, true);
    saveHostConfig({ secretAccessKey: "" });
    assert.equal(getHostConfig()!.secretAccessKey, "super-secret");
  });

  it("uploads, hands out a public URL, and always deletes afterwards", async () => {
    requests.length = 0;
    let seenUrl = "";
    const result = await withPublicUrl({ bytes: Buffer.from("PNGDATA"), contentType: "image/png", extension: ".png" }, async (url) => {
      seenUrl = url;
      return "used";
    });
    assert.equal(result, "used");
    assert.match(seenUrl, new RegExp(`^${base}/public/social-scheduler/[0-9a-f-]+\\.png$`));
    assert.deepEqual(requests.map((r) => r.method), ["PUT", "DELETE"]);
    assert.equal(objects.size, 0, "the object should have been removed");
  });

  it("deletes even when the platform step fails", async () => {
    requests.length = 0;
    await assert.rejects(
      () => withPublicUrl({ bytes: Buffer.from("x"), contentType: "image/png", extension: "png" }, async () => { throw new Error("Instagram said no"); }),
      /Instagram said no/,
    );
    assert.deepEqual(requests.map((r) => r.method), ["PUT", "DELETE"]);
  });

  it("streams a large file from disk", async () => {
    const file = path.join(process.env.SOCIAL_SCHEDULER_DATA!, "video.mp4");
    fs.writeFileSync(file, Buffer.alloc(300_000, 7));
    requests.length = 0;
    await withPublicUrl({ file, contentType: "video/mp4", extension: "mp4" }, async () => "ok");
    assert.ok(requests.some((r) => r.method === "PUT"));
    assert.equal(objects.size, 0);
  });

  it("the Test button checks the public address really serves the image", async () => {
    assert.match(await testHost(), /^Works:/);
    saveHostConfig({ publicBaseUrl: `${base}/wrong` });
    await assert.rejects(() => testHost(), /returned 404/);
  });
});

describe("fetchJson", () => {
  it("turns a failed response into a readable ApiError", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Bad token" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      await assert.rejects(
        () => fetchJson(url, {}, "Facebook sign-in"),
        (e: unknown) => e instanceof ApiError && e.status === 400 && /Facebook sign-in failed \(400\): Bad token/.test(e.message),
      );
    } finally {
      server.close();
    }
  });
});

describe("reading the server's memory use", () => {
  it("works out what is in use from /proc/meminfo, counting reclaimable memory as free", async () => {
    const { parseMeminfo } = await import("../src/resources.ts");
    const text = "MemTotal:        1015808 kB\nMemFree:          200000 kB\nMemAvailable:     700000 kB\nBuffers: 1 kB\n";
    assert.deepEqual(parseMeminfo(text), { totalMb: 992, usedMb: 308 });
    assert.equal(parseMeminfo("nonsense"), null);
  });

  it("keeps the highest reading it has seen, and says nothing where there is no /proc (a Mac)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { readMemory } = await import("../src/resources.ts");
    const file = path.join(os.tmpdir(), `meminfo-${process.pid}`);
    fs.writeFileSync(file, "MemTotal: 1024000 kB\nMemAvailable: 512000 kB\n");
    assert.deepEqual(readMemory(file), { totalMb: 1000, usedMb: 500, peakMb: 500 });
    fs.writeFileSync(file, "MemTotal: 1024000 kB\nMemAvailable: 819200 kB\n");
    assert.equal(readMemory(file)!.usedMb, 200);
    assert.equal(readMemory(file)!.peakMb, 500, "the peak does not fall");
    fs.rmSync(file);
    assert.equal(readMemory("/nonexistent/meminfo"), null);
  });
});

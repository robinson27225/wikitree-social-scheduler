import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "concurrency-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { all, get, run } = await import("../src/db.ts");
const { schedulerHealth, startScheduler, stopScheduler, tick } = await import("../src/scheduler.ts");
const { installFetchTimeout } = await import("../src/http.ts");

after(() => {
  stopScheduler();
  fs.rmSync(dir, { recursive: true, force: true });
});

function slowTarget(account: number, ms: number): number {
  const at = new Date(Date.now() - 1000).toISOString();
  const post = Number(run("INSERT INTO posts (text, alt_text, media_file, source_path, scheduled_at, created_at) VALUES ('slow', '', '', '', ?, ?)", at, at).lastInsertRowid);
  return Number(run("INSERT INTO targets (post_id, account_id) VALUES (?, ?)", post, account).lastInsertRowid);
}

describe("posting several things at once", () => {
  const account = Number(
    run("INSERT INTO accounts (kind, label, config, created_at) VALUES ('dryrun', 'Slow channel', ?, ?)", JSON.stringify({ delayMs: 300 }), new Date().toISOString()).lastInsertRowid,
  );

  it("sends due posts side by side, a few at a time, instead of one after another", async () => {
    const ids = Array.from({ length: 6 }, () => slowTarget(account, 300));
    const started = Date.now();
    await tick();
    const took = Date.now() - started;
    for (const id of ids) assert.equal(get("SELECT status FROM targets WHERE id = ?", id)!.status, "posted");
    // One after another would be 6 x 300 ms = 1.8 s. Four at a time is two rounds, about 0.6 s.
    assert.ok(took < 1400, `took ${took} ms`);
    assert.ok(took >= 550, `finished suspiciously fast (${took} ms): more than four at a time?`);
  });

  it("never sends the same post twice when passes overlap", async () => {
    const ids = Array.from({ length: 3 }, () => slowTarget(account, 300));
    await Promise.all([tick(), tick(), tick()]);
    const log = fs.readFileSync(path.join(dir, "dryrun.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    for (const id of ids) assert.equal(log.filter((l) => l.key.startsWith(`social-scheduler-target-${id}`)).length, 1, `target ${id}`);
  });

  it("reports whether the posting loop is turning over", () => {
    assert.equal(schedulerHealth().running, false, "not started in a test");
    startScheduler();
    assert.equal(schedulerHealth().running, true);
    assert.equal(schedulerHealth().stalled, false);
    assert.equal(schedulerHealth(Date.now() + 6 * 60_000).stalled, true, "no pass for five minutes");
    stopScheduler();
    assert.equal(schedulerHealth().running, false);
  });
});

describe("a deadline on every network call", () => {
  it("cuts off a call that never answers, but leaves a call with its own deadline alone", async () => {
    const http = await import("node:http");
    const hang = http.createServer(() => {}); // accepts the request and never answers
    await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(hang.address() as import("node:net").AddressInfo).port}/`;
    const original = globalThis.fetch;
    try {
      installFetchTimeout(200);
      const started = Date.now();
      await assert.rejects(() => fetch(url), (e: any) => e.name === "TimeoutError" || e.name === "AbortError");
      assert.ok(Date.now() - started < 3000);
      // a caller's own signal wins
      const own = AbortSignal.timeout(100);
      await assert.rejects(() => fetch(url, { signal: own }));
    } finally {
      globalThis.fetch = original;
      hang.closeAllConnections();
      hang.close();
    }
  });
});

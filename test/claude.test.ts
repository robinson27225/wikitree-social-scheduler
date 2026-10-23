import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import { startFake, type Fake } from "./fake.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-test-"));
process.env.SOCIAL_SCHEDULER_DATA = dir;

const { draft, explainClaudeError } = await import("../src/claude.ts");

let api: Fake;
let reply: { status: number; json: unknown };
const picture = path.join(dir, "pic.png");

before(async () => {
  await sharp({ create: { width: 200, height: 100, channels: 3, background: "#2f6f4f" } }).png().toFile(picture);
  api = await startFake(() => reply);
  process.env.ANTHROPIC_BASE_URL = api.base;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-0123456789abcdef";
});
after(() => {
  api.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const message = (text: string) => ({
  status: 200,
  json: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
});

describe("Draft with Claude, against a stand-in for Anthropic", () => {
  it("sends the picture, the brief and the limits, and splits the answer into options", async () => {
    reply = message("First option\n---\nSecond option\n---\nThird option");
    api.requests.length = 0;
    const options = await draft({ kind: "text", mediaPath: picture, brief: "Our census project", charLimit: 280, platforms: ["Bluesky", "Mastodon"] }, null);
    assert.deepEqual(options, ["First option", "Second option", "Third option"]);
    const sent = api.requests[0].json<any>();
    assert.equal(api.requests[0].path, "/v1/messages");
    const h = api.requests[0].headers;
    assert.ok(h["x-api-key"] === "sk-ant-test-key-0123456789abcdef" || h.authorization === "Bearer sk-ant-test-key-0123456789abcdef", "the key is sent");
    assert.ok(sent.model);
    assert.match(sent.system, /style guide/i);
    const parts = sent.messages[0].content;
    assert.equal(parts[0].type, "image");
    assert.equal(parts[0].source.type, "base64");
    assert.match(parts.at(-1).text, /Our census project/);
    assert.match(parts.at(-1).text, /at most 280 characters/);
    assert.match(parts.at(-1).text, /Bluesky, Mastodon/);
  });

  it("writes alt text as a single answer", async () => {
    reply = message("A green rectangle.");
    assert.deepEqual(await draft({ kind: "alt", mediaPath: picture, brief: "", charLimit: 1500, platforms: [] }, null), ["A green rectangle."]);
  });

  it("says plainly when Anthropic rejects the key, is busy, or doesn't know the model", async () => {
    const failure = async (status: number, type: string) => {
      reply = { status, json: { type: "error", error: { type, message: "nope" } } };
      return draft({ kind: "text", mediaPath: null, brief: "hello", charLimit: 280, platforms: [] }, null).then(
        () => { throw new Error("expected a failure"); },
        (e) => explainClaudeError(e),
      );
    };
    const rejected = await failure(401, "authentication_error");
    assert.equal(rejected.status, 401);
    assert.match(rejected.message, /rejected your API key/);
    const busy = await failure(429, "rate_limit_error");
    assert.equal(busy.status, 429);
    assert.match(busy.message, /rate limiting/);
    const model = await failure(404, "not_found_error");
    assert.equal(model.status, 400);
    assert.match(model.message, /model/);
  });

  it("explains a refusal, and refuses to start without something to write about", async () => {
    reply = { status: 200, json: { ...(message("") as any).json, content: [], stop_reason: "refusal" } };
    await assert.rejects(() => draft({ kind: "text", mediaPath: null, brief: "hello", charLimit: 280, platforms: [] }, null), /declined/);
    await assert.rejects(() => draft({ kind: "text", mediaPath: null, brief: "", charLimit: 280, platforms: [] }, null), /Tell Claude/);
    await assert.rejects(() => draft({ kind: "alt", mediaPath: null, brief: "", charLimit: 280, platforms: [] }, null), /no image/);
  });
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";

const goodServer = {
  AUTH_MODE: "google",
  PUBLIC_URL: "https://wikitree-social.fly.dev",
  GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "secret",
  ADMIN_EMAILS: "Azure@example.com, second@example.com",
  DATA_KEY: "dGVzdC1kYXRhLWtleS1mb3ItYXV0aC10ZXN0cy0wMTIzNDU2Nzg5",
};

describe("local mode", () => {
  it("is the default and listens only on this computer", () => {
    const c = loadConfig({ PORT: "5000" });
    assert.equal(c.authMode, "local");
    assert.equal(c.bindHost, "127.0.0.1");
    assert.deepEqual([...c.allowedHosts].sort(), ["127.0.0.1:5000", "localhost:5000"]);
    assert.equal(c.secureCookies, false);
  });

  it("refuses to listen on the network, because it has no login", () => {
    assert.throws(() => loadConfig({ BIND_HOST: "0.0.0.0" }), ConfigError);
    assert.throws(() => loadConfig({ BIND_HOST: "192.168.1.5" }), /only listen on this computer/);
    assert.doesNotThrow(() => loadConfig({ BIND_HOST: "localhost" }));
  });

  it("rejects nonsense", () => {
    assert.throws(() => loadConfig({ PORT: "abc" }), /PORT/);
    assert.throws(() => loadConfig({ PORT: "70000" }), /PORT/);
    assert.throws(() => loadConfig({ AUTH_MODE: "none" }), /AUTH_MODE/);
    assert.throws(() => loadConfig({ BRIEF_TOKEN: "short" }), /BRIEF_TOKEN/);
    assert.throws(() => loadConfig({ LOGIN_RATE_MAX: "0" }), /LOGIN_RATE_MAX/);
  });
});

describe("server (google) mode", () => {
  it("only lets Google's addresses be replaced while testing on localhost", () => {
    assert.throws(() => loadConfig({ ...goodServer, GOOGLE_TOKEN_URL: "https://evil.example.com/token" }), /only be set while testing on localhost/);
    const dev = loadConfig({ ...goodServer, PUBLIC_URL: "http://localhost:4173", GOOGLE_TOKEN_URL: "http://localhost:9/token" });
    assert.equal(dev.google?.tokenUrl, "http://localhost:9/token");
    assert.equal(loadConfig(goodServer).google?.tokenUrl, "https://oauth2.googleapis.com/token");
  });

  it("can restrict sign-in to one Workspace domain, and keeps the administrators inside it", () => {
    assert.equal(loadConfig({ ...goodServer, GOOGLE_ALLOWED_DOMAIN: "@WikiTree.com", ADMIN_EMAILS: "azure@wikitree.com" }).allowedDomain, "wikitree.com");
    assert.throws(() => loadConfig({ ...goodServer, GOOGLE_ALLOWED_DOMAIN: "wikitree.com" }), /must all be @wikitree\.com/);
    assert.throws(() => loadConfig({ ...goodServer, GOOGLE_ALLOWED_DOMAIN: "not a domain" }), /GOOGLE_ALLOWED_DOMAIN/);
    assert.equal(loadConfig(goodServer).allowedDomain, null);
  });

  it("accepts a complete, safe setup", () => {
    const c = loadConfig(goodServer);
    assert.equal(c.authMode, "google");
    assert.equal(c.publicUrl, "https://wikitree-social.fly.dev");
    assert.equal(c.bindHost, "0.0.0.0");
    assert.equal(c.secureCookies, true);
    assert.equal(c.trustProxy, true);
    assert.deepEqual(c.adminEmails, ["azure@example.com", "second@example.com"]);
    assert.deepEqual([...c.allowedHosts], ["wikitree-social.fly.dev"]);
    assert.deepEqual([...c.allowedOrigins], ["https://wikitree-social.fly.dev"]);
  });

  it("says exactly what is missing", () => {
    for (const key of ["PUBLIC_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ADMIN_EMAILS", "DATA_KEY"]) {
      const env: Record<string, string | undefined> = { ...goodServer };
      delete env[key];
      assert.throws(() => loadConfig(env), new RegExp(key), `without ${key}`);
    }
  });

  it("insists on https except for localhost testing", () => {
    assert.throws(() => loadConfig({ ...goodServer, PUBLIC_URL: "http://wikitree-social.fly.dev" }), /https/);
    const dev = loadConfig({ ...goodServer, PUBLIC_URL: "http://localhost:4173", PORT: "4173" });
    assert.equal(dev.secureCookies, false);
    assert.equal(dev.bindHost, "127.0.0.1");
    assert.ok(dev.allowedHosts.has("127.0.0.1:4173"));
  });

  it("wants only an address, no path, and real email addresses", () => {
    assert.throws(() => loadConfig({ ...goodServer, PUBLIC_URL: "https://x.fly.dev/app" }), /no path/);
    assert.throws(() => loadConfig({ ...goodServer, ADMIN_EMAILS: "not-an-email" }), /email/);
  });
});

describe("the app itself", () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, NO_OPEN: "1", ...env },
      encoding: "utf8",
      timeout: 15_000,
    });

  it("refuses to start on a network address in local mode", () => {
    const r = run({ BIND_HOST: "0.0.0.0", PORT: "4999" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /only listen on this computer/);
  });
});

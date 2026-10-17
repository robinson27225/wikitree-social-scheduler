import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

process.env.SOCIAL_SCHEDULER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "migration-test-"));
const { ensureLibraryNeverReusesIds } = await import("../src/db.ts");

describe("library ids", () => {
  it("are rebuilt so they can never be reused, keeping existing ones and skipping any a post still names", () => {
    const db = new DatabaseSync(":memory:");
    // the table as it was before the fix
    db.exec(`
      CREATE TABLE library (id INTEGER PRIMARY KEY, name TEXT NOT NULL, stored TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE posts (id INTEGER PRIMARY KEY, source_path TEXT NOT NULL);
      INSERT INTO library VALUES (1, 'a.png', 'a.png', 'sha-a', 'image', 10, 'now'), (2, 'b.png', 'b.png', 'sha-b', 'image', 10, 'now');
      INSERT INTO posts (source_path) VALUES ('library:1'), ('library:7'), ('');
    `);
    ensureLibraryNeverReusesIds(db);
    assert.deepEqual((db.prepare("SELECT id, name FROM library ORDER BY id").all() as any[]).map((r) => [r.id, r.name]), [[1, "a.png"], [2, "b.png"]]);

    // 7 was used by a post whose file has since been deleted: the next file must not take it
    db.prepare("INSERT INTO library (name, stored, sha256, kind, size, created_at) VALUES ('c.png', 'c.png', 'sha-c', 'image', 1, 'now')").run();
    assert.equal((db.prepare("SELECT id FROM library WHERE name = 'c.png'").get() as any).id, 8);

    db.prepare("DELETE FROM library WHERE id = 8").run();
    db.prepare("INSERT INTO library (name, stored, sha256, kind, size, created_at) VALUES ('d.png', 'd.png', 'sha-d', 'image', 1, 'now')").run();
    assert.equal((db.prepare("SELECT id FROM library WHERE name = 'd.png'").get() as any).id, 9, "a deleted id stays retired");

    ensureLibraryNeverReusesIds(db); // running it again changes nothing
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM library").get() as any).n, 3);
    db.close();
  });
});

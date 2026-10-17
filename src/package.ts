import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * What goes into a hand-over package. An allow-list, not "everything except": a new file or folder
 * (a data folder, a .env, a backup) stays out unless someone deliberately adds it here.
 */
export const PACKAGE_CONTENTS = [
  "src",
  "public",
  "scripts",
  "docs",
  "test",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "Dockerfile",
  "docker-entrypoint.sh",
  "fly.toml",
  ".dockerignore",
  "README.md",
  ".gitignore",
];

/** Makes a zip of the program (no accounts, no tokens, no scheduled posts) that can be set up on another computer. */
export async function buildPackage(root: string, outDir: string): Promise<{ file: string; files: number }> {
  const pkg = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8")) as { version: string };
  const day = new Date().toISOString().slice(0, 10);
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), "ss-package-"));
  try {
    const top = path.join(staging, "social-scheduler");
    await fsp.mkdir(top);
    let files = 0;
    for (const entry of PACKAGE_CONTENTS) {
      const from = path.join(root, entry);
      if (!fs.existsSync(from)) continue;
      await fsp.cp(from, path.join(top, entry), {
        recursive: true,
        filter: (src) => {
          if (path.basename(src) === ".DS_Store") return false;
          if (fs.statSync(src).isFile()) files++;
          return true;
        },
      });
    }
    await fsp.mkdir(outDir, { recursive: true });
    const file = path.join(outDir, `social-scheduler-${pkg.version}-${day}.zip`);
    await fsp.rm(file, { force: true });
    await run("zip", ["-r", "-q", file, "social-scheduler"], { cwd: staging });
    return { file, files };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

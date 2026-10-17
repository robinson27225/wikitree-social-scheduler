// Makes a hand-over zip with no secrets in it:  npm run package
import path from "node:path";
import { buildPackage } from "../src/package.ts";

const root = path.resolve(import.meta.dirname, "..");
const { file, files } = await buildPackage(root, path.join(root, "dist"));
console.log(`Package ready: ${file}  (${files} files)`);
console.log("It contains the program and the guides only: no accounts, tokens or scheduled posts.");
console.log("To also hand over the queue and sign-ins, make an encrypted backup too:  npm run backup");

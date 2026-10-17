// Prints the same digest the app shows at /api/brief, without needing the app to be running.
import { buildBrief } from "../src/brief.ts";

console.log(buildBrief().text);

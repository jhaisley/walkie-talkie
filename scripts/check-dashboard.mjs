// Parse the dashboard's inline <script> exactly as a browser would. A SyntaxError anywhere in
// it kills the ENTIRE script, so "the string is present in the HTML" proves nothing.
import { readFileSync } from "node:fs";
const html = readFileSync(process.argv[2], "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (scripts.length === 0) { console.error("  FAIL: no inline <script> found"); process.exit(1); }
let bad = 0;
scripts.forEach((src, i) => {
  try {
    new Function(src);                       // parse only; never executed
    console.log(`  script #${i + 1}: parses OK (${src.split("\n").length} lines)`);
  } catch (e) {
    bad++;
    console.error(`  script #${i + 1}: ${e.name}: ${e.message}`);
    const m = /(\d+):(\d+)/.exec(e.stack ?? "");
    if (m) console.error(`    near: ${src.split("\n")[Number(m[1]) - 1]?.trim()}`);
  }
});
process.exit(bad ? 1 : 0);

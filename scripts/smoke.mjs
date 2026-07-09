// Standalone smoke test for the cmux spawn + name-read mechanism.
// Runs WITHOUT the LLM: creates a surface, launches a bare `pi`, reads its
// agent name from the title, prints it, then closes the surface.
// A bare idle pi makes no API calls, so this is free.

import { spawnSync } from "node:child_process";

const SURFACE_RE = /surface:[0-9]+/;
const AGENT_NAME_RE = /[a-z]+-[a-z]+-[0-9]+/;
const cwd = process.argv[2] || process.cwd();

function cmux(args, timeoutMs = 5000) {
  const res = spawnSync("cmux", args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. identify
  const idRaw = cmux(["identify", "--json", "--id-format", "both"]);
  const id = JSON.parse(idRaw.stdout);
  const paneRef = id.caller?.pane_ref;
  console.log("caller pane_ref:", paneRef);
  if (!paneRef) { console.error("no pane ref"); process.exit(1); }

  // 2. new surface
  const surfRaw = cmux(["new-surface", "--type", "terminal", "--pane", paneRef, "--focus", "false", "--working-directory", cwd]);
  const surfaceRef = (surfRaw.stdout + surfRaw.stderr).match(SURFACE_RE)?.[0];
  console.log("new surface:", surfaceRef);
  if (!surfaceRef) { console.error("no surface ref; stderr:", surfRaw.stderr); process.exit(1); }

  // 3. launch bare pi
  const launch = cmux(["send", "--surface", surfaceRef, `cd ${cwd} && pi\n`]);
  console.log("launch send status:", launch.status);

  // 4. poll tree for agent name
  const deadline = Date.now() + 30000;
  let name;
  while (Date.now() < deadline) {
    const tree = cmux(["tree"], 3000).stdout;
    for (const line of tree.split("\n")) {
      if (line.includes(surfaceRef)) {
        const m = line.match(AGENT_NAME_RE);
        if (m) { name = m[0]; break; }
      }
    }
    if (name) break;
    await sleep(500);
  }
  console.log("agent name:", name);

  // 5. close the surface to clean up
  const close = cmux(["close-surface", "--surface", surfaceRef], 3000);
  console.log("close status:", close.status, (close.stderr || close.stdout).trim());
}

main().catch((e) => { console.error(e); process.exit(1); });
// Verify broker-scan can list intercom sessions and find a live peer by name.
import { scanIntercomSessions, findPeerByName } from "../broker-scan.ts";

const sessions = await scanIntercomSessions(4000);
console.log(`scanned ${sessions.length} sessions:`);
for (const s of sessions) {
  console.log(`  - ${s.name ?? "(unnamed)"} id=${s.id.slice(0, 12)}… pid=${s.pid} cwd=${s.cwd}`);
}
const me = findPeerByName(sessions, "silver-gar-51", process.pid);
console.log("\nfindPeerByName('silver-gar-51', exclude self pid):", me ? `FOUND id=${me.id.slice(0,12)}…` : "not found");
const meIncluding = sessions.find((s) => s.name?.toLowerCase() === "silver-gar-51");
console.log("silver-gar-51 present at all?", meIncluding ? `yes pid=${meIncluding.pid}` : "no");
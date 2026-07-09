/**
 * pi-cmux-spawn — Spawn a new pi agent in a cmux terminal surface and bridge
 * it to the caller via pi-intercom.
 *
 * The extension registers a single tool, `spawn_agent`, that any agent can
 * call to create a *new* collaborating agent. The caller does not need to know
 * that the new agent lives in a cmux terminal surface — it just gets back an
 * agent name (and, when intercom is reachable, a session id) plus the exact
 * intercom command to talk to it.
 *
 * Flow:
 *   1. Create a new cmux terminal surface (tab) in the caller's pane, no focus steal.
 *   2. Launch a bare `pi` in that surface (so it gets an auto-generated agent
 *      name from pi-agent-identity and registers with pi-intercom).
 *   3. Read the new agent's name from the cmux surface title.
 *   4. Best-effort: look up its intercom session id via the intercom broker.
 *   5. Return the name (+ id) and the intercom send command to reach it.
 *
 * Install: pi install git:github.com/elecnix/pi-cmux-spawn
 * Test:    pi -e ./index.ts
 */

import { spawnSync } from "node:child_process";
import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { scanIntercomSessions, findPeerByName } from "./broker-scan.ts";

const AGENT_NAME_RE = /[a-z]+-[a-z]+-[0-9]+/;
const SURFACE_RE = /surface:[0-9]+/;
const POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 30_000;

interface CmuxIdentify {
  caller?: { pane_ref?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cmuxJson(args: string[], timeoutMs = 5000): unknown | undefined {
  const res = spawnSync("cmux", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error || res.status !== 0) return undefined;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return undefined;
  }
}

function cmuxText(args: string[], timeoutMs = 5000): string {
  const res = spawnSync("cmux", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) return "";
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

function identifyCallerPane(): string | undefined {
  const id = cmuxJson(["identify", "--json", "--id-format", "both"]) as CmuxIdentify | undefined;
  return id?.caller?.pane_ref;
}

/** Create a new terminal surface in the caller's pane; return its surface ref. */
function createSurface(paneRef: string, cwd: string): string | undefined {
  const out = cmuxText(
    ["new-surface", "--type", "terminal", "--pane", paneRef, "--focus", "false", "--working-directory", cwd],
    5000,
  );
  return out.match(SURFACE_RE)?.[0];
}

/** Launch a bare `pi` in the given surface. */
function launchPi(surfaceRef: string, cwd: string): void {
  const cmd = `cd ${cwd} && pi\n`;
  spawnSync("cmux", ["send", "--surface", surfaceRef, cmd], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Poll the cmux tree for the new agent's auto-generated name on its surface title. */
async function readAgentName(
  surfaceRef: string,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tree = cmuxText(["tree"], 3000);
    for (const line of tree.split("\n")) {
      if (!line.includes(surfaceRef)) continue;
      const m = line.match(AGENT_NAME_RE);
      if (m) return m[0];
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Create a new collaborating pi agent in a new terminal surface and bridge it via pi-intercom. " +
      "Returns the new agent's name (and intercom session id when available) plus the exact intercom " +
      "command to send it a message. The new agent boots idle and ready; send it a task over intercom " +
      "(fire-and-forget), then end your turn — its reply arrives later as a 📨 intercom notification.",
    promptSnippet:
      "Create a new collaborating agent that replies over pi-intercom. Use spawn_agent to delegate async work to a fresh agent.",
    promptGuidelines: [
      "Use spawn_agent when the user asks to create, spawn, or delegate to a new agent that can collaborate over intercom. After calling it, send the task to the returned agent name via the intercom tool, then end your turn.",
    ],
    parameters: Type.Object({
      task: Type.Optional(Type.String({
        description:
          "Optional initial task/prompt for the new agent. When provided, the result includes a " +
          "ready-to-send intercom call pre-filled with this task. The calling agent sends it (so the " +
          "new agent sees the real caller as the sender).",
      })),
      cwd: Type.Optional(Type.String({
        description:
          "Working directory for the new agent. Defaults to the current working directory.",
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = params.cwd?.trim() || ctx.cwd;

      // 1. cmux must be available and we must be running inside a cmux pane.
      const paneRef = identifyCallerPane();
      if (!paneRef) {
        return {
          content: [{ type: "text", text:
            "❌ spawn_agent must run inside a cmux terminal pane (could not identify caller pane via `cmux identify`)." }],
          details: { error: true },
        };
      }

      // 2. Capture existing intercom session ids so we can diff after launch
      //    (avoids matching stale ghost registrations from the agent-identity
      //    daemon that share the new agent's randomly-generated name).
      let beforeIds = new Set<string>();
      try {
        const before = await scanIntercomSessions(3000);
        beforeIds = new Set(before.map((s) => s.id));
      } catch {
        // Non-fatal; fall back to name-only matching below.
      }

      // 3. Create the new surface.
      const surfaceRef = createSurface(paneRef, cwd);
      if (!surfaceRef) {
        return {
          content: [{ type: "text", text: "❌ Failed to create a new cmux terminal surface." }],
          details: { error: true },
        };
      }

      // 4. Launch a bare pi in it (gets an auto agent name + registers with intercom).
      launchPi(surfaceRef, cwd);

      // 5. Read the new agent's name from the surface title.
      const agentName = await readAgentName(surfaceRef);
      if (!agentName) {
        return {
          content: [{ type: "text", text:
            `⚠️ Launched pi in ${surfaceRef} but could not read its agent name within ${READY_TIMEOUT_MS / 1000}s. ` +
            `The new surface exists; run \`cmux tree\` to inspect it, or \`intercom list\` to find the peer.` }],
          details: { surfaceRef, cwd, error: true },
        };
      }

      // 6. Best-effort: look up the intercom session id by name + cwd,
      //    excluding ids that existed before launch (ghost dedup).
      let sessionId: string | undefined;
      try {
        const sessions = await scanIntercomSessions(4000);
        const peer = findPeerByName(sessions, agentName, process.pid, cwd, beforeIds);
        if (peer) sessionId = peer.id;
      } catch {
        // Non-fatal: the name is enough for intercom send.
      }

      // 7. Build the intercom instructions for the caller.
      //    Prefer the session id as the `to` target: the agent-identity daemon
      //    keeps ghost registrations for offline agents, so a name can be
      //    ambiguous ("Multiple sessions named X are connected"). The id is
      //    unambiguous. Fall back to the name only if we couldn't resolve an id.
      const task = params.task?.trim();
      const messageArg = task
        ? task.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        : "<your message here>";
      const target = sessionId ?? agentName;
      const intercomCall = `intercom({ action: "send", to: "${target}", message: "${messageArg}" })`;

      const lines: string[] = [
        `✅ Spawned a new agent.`,
        ``,
        `- **Agent name:** ${agentName}`,
        ...(sessionId ? [`- **Intercom session id:** ${sessionId}`] : [`- **Intercom session id:** (not resolved — target by name below; if \`intercom send\` reports "Multiple sessions named", run \`intercom list\` and use the session id)`]),
        `- **Surface:** ${surfaceRef}`,
        `- **Working directory:** ${cwd}`,
        ``,
        `**How to talk to it over intercom:**`,
        ``,
        'Send a message (fire-and-forget), then END YOUR TURN. Its reply arrives later as a 📨 intercom notification:',
        ``,
        "```",
        intercomCall,
        "```",
        ``,
        ...(sessionId ? [`Use the **session id** above as the \`to\` target (not the name) — it's unambiguous even when offline-agent ghosts share the name.`] : []),
        ...(task
          ? [`The task above is pre-filled from your \`task\` parameter. Send it now, then stop. The new agent will do the work and reply over intercom.`]
          : [`Replace \`<your message here>\` with the task you want it to do. The new agent is idle and ready.`]),
        ``,
        `Tip: you can also list peers with \`intercom({ action: "list" })\`.`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { agentName, sessionId, surfaceRef, cwd },
      };
    },
  });

  // Convenience slash command for humans.
  pi.registerCommand("spawn-agent", {
    description: "Spawn a new pi agent in a cmux tab and print its intercom address",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const paneRef = identifyCallerPane();
      if (!paneRef) {
        ctx.ui.notify("Not inside a cmux pane", "error");
        return;
      }
      let beforeIds = new Set<string>();
      try {
        const before = await scanIntercomSessions(3000);
        beforeIds = new Set(before.map((s) => s.id));
      } catch {}
      const surfaceRef = createSurface(paneRef, cwd);
      if (!surfaceRef) {
        ctx.ui.notify("Failed to create cmux surface", "error");
        return;
      }
      launchPi(surfaceRef, cwd);
      ctx.ui.notify(`Launching pi in ${surfaceRef}…`, "info");
      const agentName = await readAgentName(surfaceRef);
      if (!agentName) {
        ctx.ui.notify(`Launched in ${surfaceRef} but could not read agent name`, "warning");
        return;
      }
      let sessionId: string | undefined;
      try {
        const sessions = await scanIntercomSessions(4000);
        const peer = findPeerByName(sessions, agentName, process.pid, cwd, beforeIds);
        if (peer) sessionId = peer.id;
      } catch {}
      ctx.ui.notify(
        `New agent: ${agentName}${sessionId ? ` (session ${sessionId.slice(0, 8)}…)` : ""} — talk via intercom`,
        "info",
      );
    },
  });
}
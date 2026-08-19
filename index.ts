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
import { randomUUID } from "node:crypto";
import { scanIntercomSessions, findPeerByName } from "./broker-scan.ts";

// General "send as the current session" event contract, provided by pi-intercom.
// Duplicated here as loose-coupled string constants (the way pi-subagents does
// for its own intercom events) so this extension has no hard import dependency
// on pi-intercom. pi-intercom listens for INTERCOM_EXTENSION_SEND_EVENT and
// forwards the message through the CURRENT session's own intercom client, so
// the broker records the message's `from` as THIS session — sender identity is
// preserved and replies route back natively. A matching result event carries
// { delivered, reason } so delivery can be confirmed, not assumed.
const INTERCOM_EXTENSION_SEND_EVENT = "intercom:extension-send";
const INTERCOM_EXTENSION_SEND_RESULT_EVENT = "intercom:extension-send-result";

/**
 * Deliver `text` to `toSessionId` over intercom AS the current session, by
 * emitting the pi-intercom "send as current session" event. Resolves with the
 * broker's delivery outcome. Never rejects — failures are reported, not
 * thrown, so the caller can surface them honestly.
 */
async function sendTaskAsCurrentSession(
  pi: ExtensionAPI,
  toSessionId: string,
  text: string,
  timeoutMs = 10_000,
): Promise<{ delivered: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    let settled = false;
    const finish = (result: { delivered: boolean; reason?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(result);
    };
    const off = pi.events.on(INTERCOM_EXTENSION_SEND_RESULT_EVENT, (data) => {
      if (!data || typeof data !== "object") return;
      const r = data as { requestId?: unknown; delivered?: unknown; reason?: unknown };
      if (r.requestId !== requestId) return;
      finish({
        delivered: r.delivered === true,
        reason: typeof r.reason === "string" ? r.reason : undefined,
      });
    });
    const timer = setTimeout(
      () => finish({ delivered: false, reason: "send timeout (pi-intercom may not be installed or reachable)" }),
      timeoutMs,
    );
    try {
      pi.events.emit(INTERCOM_EXTENSION_SEND_EVENT, { to: toSessionId, message: text, requestId });
    } catch (e) {
      finish({ delivered: false, reason: `failed to emit send event: ${String((e as Error).message ?? e)}` });
    }
  });
}

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
      "Returns the new agent's name (and intercom session id when available). With auto_send=true the " +
      "extension delivers the task to the new agent over intercom itself and reports whether delivery " +
      "succeeded — you do not send it yourself. Without auto_send, the result includes a ready-to-send " +
      "intercom call to use. The reply arrives later as a 📨 intercom notification.",
    promptSnippet:
      "Create a new collaborating agent that replies over pi-intercom. Use spawn_agent to delegate async work to a fresh agent.",
    promptGuidelines: [
      "Use spawn_agent when the user asks to create, spawn, or delegate to a new agent that can collaborate over intercom. With auto_send=true the extension delivers the task directly and reports the outcome; otherwise send the task to the returned agent name via the intercom tool, then end your turn.",
    ],
    parameters: Type.Object({
      task: Type.Optional(Type.String({
        description:
          "Optional initial task/prompt for the new agent. If provided together with auto_send=true, " +
          "the extension sends it directly to the new agent over intercom itself and reports whether " +
          "delivery succeeded — you do not send it yourself. Without auto_send, the result includes a " +
          "ready-to-send intercom call pre-filled with this task.",
      })),
      cwd: Type.Optional(Type.String({
        description:
          "Working directory for the new agent. Defaults to the current working directory.",
      })),
      wait_for_ready: Type.Optional(Type.Boolean({
        description:
          "Wait for the new agent to boot and register with intercom before returning (up to 30s). " +
          "Default true. Set to false to return immediately after launch — get back only the surface " +
          "ref and cwd; the agent will be reachable by name/id within a few seconds.",
        default: true,
      })),
      auto_send: Type.Optional(Type.Boolean({
        description:
          "When true and task is provided, the extension sends the task to the new agent over intercom " +
          "as the CURRENT session itself (via the pi-intercom ‘send as current session’ event) and reports " +
          "whether delivery succeeded; it does NOT queue a follow-up for you to send. The message's `from` " +
          "is this session, so replies route back to you natively. One shot, no retry. Requires pi-intercom " +
          "to be installed, and wait_for_ready to also be true (enforced). Default false.",
        default: false,
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = params.cwd?.trim() || ctx.cwd;
      const waitForReady = params.wait_for_ready !== false; // defaults true
      const autoSend = params.auto_send === true;
      const task = params.task?.trim();

      // ── Shared preamble: cmux + surface + launch ───────────────────

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
      let beforeIds = new Set<string>();
      try {
        const before = await scanIntercomSessions(3000);
        beforeIds = new Set(before.map((s) => s.id));
      } catch { /* fall back to name-only matching */ }

      // 3. Create the new surface.
      const surfaceRef = createSurface(paneRef, cwd);
      if (!surfaceRef) {
        return {
          content: [{ type: "text", text: "❌ Failed to create a new cmux terminal surface." }],
          details: { error: true },
        };
      }

      // 4. Launch a bare pi in it.
      launchPi(surfaceRef, cwd);

      // ── Fast path: don't wait ──────────────────────────────────────

      if (!waitForReady) {
        const hint = `The new agent is booting. When it is ready (a few seconds), find it with \`intercom list\` (look for a new session whose cwd is \`${cwd}\`). Target it by session id, not name, to avoid ghost- duplicate issues.`;
        return {
          content: [{ type: "text", text:
            `✅ Launched a new pi agent in ${surfaceRef} (\`${cwd}\`).\n\n${hint}` }],
          details: { surfaceRef, cwd, waitForReady: false },
        };
      }

      // ── Wait for readiness: name + session id ──────────────────────

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
      } catch { /* non-fatal */ }

      // ── Auto-send: deliver the task to the new agent directly ────────
      //
      // The extension sends the task over intercom itself — it does NOT queue a
      // follow-up that asks the calling agent to do the send. One shot, no retry:
      // the broker's `delivered` ack is the confirmation; a failed delivery (broker
      // at capacity, peer not registered, timeout) is surfaced honestly so the
      // caller can escalate instead of silently losing the task. See issue #2.

      if (autoSend && task) {
        // The new agent registers with intercom shortly after boot. If the first
        // scan (step 6) missed it, poll a few times before giving up — direct
        // send needs the peer's session id (sending by name is ambiguous: the
        // broker rejects when multiple sessions share a name).
        if (!sessionId) {
          const pollDeadline = Date.now() + 6_000;
          while (!sessionId && Date.now() < pollDeadline) {
            await sleep(1_000);
            try {
              const sessions = await scanIntercomSessions(4000);
              const peer = findPeerByName(sessions, agentName, process.pid, cwd, beforeIds);
              if (peer) sessionId = peer.id;
            } catch { /* keep polling */ }
          }
        }

        if (!sessionId) {
          const escapedTask = task.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const sendCmd = `intercom({ action: "send", to: "${agentName}", message: "${escapedTask}" })`;
          return {
            content: [{ type: "text", text:
              `⚠️ Spawned **${agentName}** in ${surfaceRef} (\`${cwd}\`), but could not resolve its intercom session id in time, so the task was NOT delivered. The new agent is idle with no task. Retry shortly, or send the task yourself:\n\n\`\`\`\n${sendCmd}\n\`\`\`` }],
            details: { agentName, sessionId, surfaceRef, cwd, autoSend: true, delivered: false, reason: "session id not resolved" },
          };
        }

        const result = await sendTaskAsCurrentSession(pi, sessionId, task);

        if (result.delivered) {
          return {
            content: [{ type: "text", text:
              `✅ Spawned **${agentName}** in ${surfaceRef} (\`${cwd}\`) and delivered the task to it over intercom (session \`${sessionId.slice(0, 12)}…\`). The reply arrives later as a 📨 notification.` }],
            details: { agentName, sessionId, surfaceRef, cwd, autoSend: true, delivered: true },
          };
        }

        const escapedTask = task.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const sendCmd = `intercom({ action: "send", to: "${sessionId}", message: "${escapedTask}" })`;
        return {
          content: [{ type: "text", text:
            `⚠️ Spawned **${agentName}** in ${surfaceRef} (\`${cwd}\`), but the task was NOT delivered over intercom: ${result.reason ?? "unknown reason"}. The new agent is idle with no task — do not assume it received the work. The broker may be at capacity (the send will keep failing until capacity frees), or the peer may not be registered yet. You can retry, or surface this failure. Retry command:\n\n\`\`\`\n${sendCmd}\n\`\`\`` }],
          details: { agentName, sessionId, surfaceRef, cwd, autoSend: true, delivered: false, reason: result.reason },
        };
      }

      // ── Manual-send path: return instructions ──────────────────────

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
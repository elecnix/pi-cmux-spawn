/**
 * Minimal, best-effort read-only client for the pi-intercom broker.
 *
 * Used by spawn_agent to look up a freshly-launched peer's intercom session id
 * by name + cwd. We connect, register a short-lived "scanner" session, ask for
 * the session list, then unregister and disconnect. The scanner is never used
 * to send messages, and it unregisters in a `finally` so it never lingers.
 *
 * This intentionally duplicates the broker framing protocol (4-byte
 * big-endian length prefix + JSON) rather than importing the intercom package,
 * so this extension has no hard dependency on pi-intercom's internals.
 */

import { createConnection, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ScannedSession {
  id: string;
  name?: string;
  cwd: string;
  pid: number;
  model: string;
}

const SOCKET_PATH = join(homedir(), ".pi/agent/intercom/broker.sock");

function writeMessage(socket: Socket, msg: unknown): void {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}

/** Connect, register, list sessions, unregister, disconnect. Best-effort. */
export function scanIntercomSessions(timeoutMs = 4000): Promise<ScannedSession[]> {
  return new Promise((resolve) => {
    if (!existsSync(SOCKET_PATH)) {
      resolve([]);
      return;
    }

    let settled = false;
    const finish = (value: ScannedSession[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve(value);
    };

    const socket = createConnection(SOCKET_PATH);
    const timer = setTimeout(() => finish([]), timeoutMs);

    let buffer = Buffer.alloc(0);
    let registered = false;
    let gotList = false;
    let pendingList: ScannedSession[] = [];

    const handleMessage = (msg: Record<string, unknown>) => {
      if (!registered) {
        if (msg.type === "registered") {
          registered = true;
          // Ask for the current session list.
          try {
            writeMessage(socket, { type: "list", requestId: "scan" });
          } catch {
            finish([]);
          }
        } else {
          // Unexpected pre-registration message — bail.
          finish([]);
        }
        return;
      }

      if (msg.type === "sessions" && !gotList) {
        gotList = true;
        const sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
        pendingList = sessions
          .filter((s): s is Record<string, unknown> =>
            typeof s === "object" && s !== null)
          .map((s) => ({
            id: String(s.id ?? ""),
            name: typeof s.name === "string" ? s.name : undefined,
            cwd: String(s.cwd ?? ""),
            pid: Number(s.pid ?? 0),
            model: String(s.model ?? ""),
          }))
          .filter((s) => s.id.length > 0);
        // Unregister and return.
        try {
          writeMessage(socket, { type: "unregister" });
        } catch {}
        finish(pendingList);
        return;
      }

      if (msg.type === "error") {
        finish([]);
        return;
      }
      // Ignore other message types (presence, session_joined, etc.).
    };

    const reader = (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) return;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(payload.toString("utf-8"));
        } catch {
          finish([]);
          return;
        }
        try {
          handleMessage(msg);
        } catch {
          finish([]);
          return;
        }
      }
    };

    socket.on("connect", () => {
      // Register a transient scanner session so the broker lets us list.
      const now = Date.now();
      const registration = {
        name: "cmux-spawn-scanner",
        cwd: process.cwd(),
        model: "scanner",
        pid: process.pid,
        startedAt: now,
        lastActivity: now,
        status: "scanning",
      };
      try {
        writeMessage(socket, { type: "register", session: registration });
      } catch {
        finish([]);
      }
    });

    socket.on("data", reader);
    socket.on("error", () => finish([]));
    socket.on("close", () => finish(gotList ? pendingList : []));
  });
}

/**
 * Find a peer session by agent name (and optionally cwd), excluding the
 * caller's own pid. Returns the matching session, or undefined.
 */
export function findPeerByName(
  sessions: ScannedSession[],
  name: string,
  excludePid?: number,
  cwd?: string,
): ScannedSession | undefined {
  const target = name.toLowerCase();
  return sessions.find(
    (s) =>
      s.name?.toLowerCase() === target &&
      s.pid !== excludePid &&
      (cwd === undefined || s.cwd === cwd),
  );
}
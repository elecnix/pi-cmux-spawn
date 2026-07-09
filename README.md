# pi-cmux-spawn

Spawn a **new** [pi](https://pi.dev) agent in a [cmux](https://cmux.com) terminal surface and bridge it to the caller via [pi-intercom](https://github.com/nicobailon/pi-intercom).

The extension registers a single tool, **`spawn_agent`**, that any agent can call to create a collaborating agent. The caller does not need to know that the new agent lives in a cmux surface — it just gets back an agent name (and, when intercom is reachable, a session id) plus the exact `intercom` command to reach it.

## Install

```bash
pi install git:github.com/elecnix/pi-cmux-spawn
```

Then run `/reload` inside pi.

Requires (already part of a standard setup):

- `cmux` (macOS terminal multiplexer)
- `pi-agent-identity` — gives the new agent an auto-generated name
- `pi-intercom` — lets agents talk to each other by name
- `cmux hooks setup pi` — so pi surfaces get a `π - <name> - <context>` title

## Usage

An agent calls the tool:

```ts
spawn_agent({ task: "Investigate the failing tests in packages/foo and report back." })
```

It returns:

```
✅ Spawned a new agent.

- Agent name: tidal-grouse-50
- Intercom session id: session-abc123…
- Surface: surface:36
- Working directory: /Users/you/Source/repo/main

How to talk to it over intercom:

  intercom({ action: "send", to: "tidal-grouse-50", message: "Investigate the failing tests…" })
```

The caller then sends the task over intercom (fire-and-forget) and ends its turn. The new agent does the work and replies over intercom; the reply arrives as a 📨 notification that starts a new turn.

## How it works

1. `cmux identify` → caller's pane ref.
2. `cmux new-surface --type terminal --pane <ref> --focus false --working-directory <cwd>` → new surface ref (no focus steal).
3. `cmux send --surface <ref> "cd <cwd> && pi\n"` → launches a bare `pi` (idle, ready).
4. Polls `cmux tree` for the new surface title and extracts the auto-generated agent name (`word-word-digits`).
5. Best-effort: connects to the pi-intercom broker, registers a transient "scanner" session, lists peers, finds the new agent by name + cwd, unregisters, and returns its intercom session id.
6. Returns the name (+ id) and the intercom send command.

The broker scan is best-effort: if intercom is unavailable, the tool still succeeds with just the agent name, which is sufficient for `intercom send`.

## Test locally

```bash
pi -e ./index.ts -p "Use the spawn_agent tool to create a new agent with the task 'report ready', then tell me the result."
```

## License

MIT
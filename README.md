# claude-orchestrator

A Claude Code plugin that turns one session into the **orchestrator** of a fleet of coding agents, plus a live **orchestrator view** pane beside the chat so you can see the whole fleet at a glance.

It has two parts:

- **The `orchestrator` skill:** the session plans the work, spawns task leads (Claude Opus), researchers (Claude Haiku) and coders (non-Anthropic models through [Pi](https://pi.dev)) via [agent-manager](https://github.com/wainmann/agent-manager), keeps project state in `.orchestrator/`, and runs autonomously until every task is verified done or parked. It asks you one kickoff question, then never prompts again.
- **The orchestrator view:** a read-only pane, refreshed every 5 seconds, showing:
  - the orchestrator session itself and its project folder
  - **Fleet:** every live agent with status and tool; errored and waiting agents sort to the top
  - **Tasks:** the shared agent-manager task list (blocked tasks flagged, finished ones counted)
  - **Reservations:** file leases held by agents
  - **Plans**, recent **decisions** and the latest **ledger** section from `.orchestrator/`

  A pop-up notice fires when an agent turns *waiting* or *errored* (the moments the orchestrator should step in), and the status line keeps a summary such as `orch · 3 live · 2 working · 1 waiting · 4 open tasks`.

The view never sends, kills or archives anything. It only reads.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install orchestrator --marketplace metajar/claude-orchestrator
```

Answer `y` to add the marketplace, then pick a scope (user scope is the usual choice).

From a shell:

```
claude plugin install orchestrator --marketplace metajar/claude-orchestrator
```

In the Claude desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `metajar/claude-orchestrator`, then **Add plugin**.

## Requirements

- **agent-manager**, with the orchestrator session launched from it so the session has the agent-manager MCP tools. The task list and reservations only answer inside an agent-manager session.
- **Pi** (pi.dev) for the non-Anthropic coder models.
- **Lightpanda** is installed by the skill on first run if missing.

## Use

- Say "orchestrate this" (or "you're the orchestrator") in a session started from agent-manager. The skill loads and the view opens by itself.
- A session whose agent-manager name starts with `orchestrator` also opens the view at startup.
- `/orch-view` opens the view by hand at any time.

Outside agent-manager the view still opens; the fleet and task sections say they are unavailable, and the `.orchestrator/` files still show.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .      # run a session with this checkout loaded
```

## License

MIT

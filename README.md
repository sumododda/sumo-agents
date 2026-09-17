# sumo-agents

One repo you open and talk to. It works across every other project on the machine, remembers what you
tell it so you never explain twice, learns each project as you go, and hands big work to cheaper
sub-agents. Built for Claude Code; the core is harness-neutral.

The repo holds only the process. Everything learned lives in `~/.sumo-agents/` on each machine and is
never committed — a work laptop and a personal one learn separately.

## Set up a machine

Needs Node 22.13+ and Claude Code.

```sh
git clone <this repo> ~/sumo-agents && cd ~/sumo-agents
node bin/mem.mjs setup     # creates ~/.sumo-agents, links `mem` into a directory on your PATH
mem doctor                 # nine checks; every line should say ok
claude                     # open it here. Approve the project hooks once when asked.
```

Then just talk. Mention a project the way you normally would; the first time, the agent finds it on
disk, confirms the path with you, and registers it.

## Update a machine

```sh
cd ~/sumo-agents && git pull
mem doctor                 # first line shows the commit now running — compare it with GitHub
```

That is all: `mem` runs straight from the repo, so new code is live the moment it is pulled, and the
database upgrades itself the next time it is opened. Your memory is not touched — it lives in
`~/.sumo-agents/`, outside the repo. Run `mem setup` again only if `mem doctor` tells you to (you moved
the repo, or changed Node versions). Start a new Claude Code session afterwards, so it loads the new
`AGENTS.md` and hooks.

## What happens while you talk

| When | What runs | Cost to the model you chat with |
|---|---|---|
| Session starts | A hook prints the core block: your global preferences, workflows, projects, where you left off, open jobs, things to confirm. Hard cap 800 tokens. | ≤ 800 tokens, once |
| You send a message | A hook stores it word for word (secrets redacted). First mention of a project adds its card: path, stack, commands, your rules for it, gotchas. | 0, or ≤ 200 once per project |
| The agent is about to run a shell command a taught workflow gates (`gh pr create`, for a workflow taught with `--gate 'gh(-axi)? pr create'`) | A hook holds the command back once and hands the agent the workflow's steps. It follows them, then runs the command. The same steps ride in with your message when you ask for the thing yourself. | 0 until it fires |
| The agent is about to ask you something — a turn ending on a question, or the question tool | A hook searches memory with the question's own words, in plain code. If something close is there, the agent is handed it once and carries on instead of waiting for you; if nothing is, the question reaches you untouched. | 0 unless memory answers |
| The assistant finishes a turn | A hook wakes the **scribe** — a detached, headless Haiku call that reads the new turns and proposes memories. Code checks every proposal against what you actually typed before saving it. | 0 |
| 3 finished sessions pile up | The **dream** pass reads them side by side: contradictions, repeated corrections, routines worth naming. | 0 |

What you state is saved silently. What the model could not tie to your exact words is held and put
to you as a one-line question at the next session start. Nothing from web pages, files or tool output
can become a memory.

## See what it knows

```sh
mem export                         # everything, readable, grouped by project
mem prime                          # exactly what a new session is shown
mem project show <name>            # a project's card
mem search "<words>" [--project <name>]
mem search "<words>" --turns       # what you literally typed
mem history <id>                   # what a memory replaced, and what replaced it
mem gate <workflow-id> '<regex>'   # which shell commands a workflow must come before  (off to remove)
mem scribe show                    # exactly what the cheap model would be sent right now
mem scribe stats                   # what the background passes have cost
mem forget <id>                    # stop it being true (history kept);  --purge erases it for good
```

`mem help` lists the rest. Ids look like `m12` (memories) and `j3` (jobs).

## Delegation

The main agent does small things itself. Big, parallel or reading-heavy work goes to a sub-agent through
a written brief (`mem job new`): `scout` (Haiku, cannot edit) for investigation, `worker` (Sonnet) for
changes. Both refuse to start without a job. A blocked sub-agent asks; the main agent checks memory
before it asks you. Briefs, notes, answers and reports live in `~/.sumo-agents/jobs/<id>/`, so a job
started today can be picked up tomorrow.

## What it costs

Measured on this machine, Claude Code 2.1, Haiku 4.5, subscription login:

- One scribe call: about 4,300 tokens in, 300–600 out, **$0.011–0.013**, 4–8 s, in the background.
- 30 labelled turns over six conversations: **$0.07**. It remembered 16 of 16 things it should, put
  16 of 16 in the right project, proved all 16 with a real quote, and remembered 0 of 14 throwaway turns.
- The always-loaded prompt (`AGENTS.md`) is about 570 tokens.

`mem config scribe.model sonnet` switches the writer's model; `off` makes the chat model save directly.

## Tests

```sh
npm test                              # 68 tests, no network, no model calls (recorded answers)
node probes/scope-accuracy.mjs        # live: real model, about 7 cents
```

## Layout

```
AGENTS.md            the only always-loaded instructions (CLAUDE.md just imports it)
guides/              read on demand: memory · projects · workflows · delegation
prompts/             system prompts for the scribe and dream passes
bin/mem.mjs  src/    the `mem` CLI — Node, zero dependencies, SQLite full-text search
.claude/             hooks, the `mem` permission, the scout and worker agents, /dream
test/  probes/       the suite, and the live measurement
docs/PLAN.md         the design, the evidence behind it, and what was measured while building it
```

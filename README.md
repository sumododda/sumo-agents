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
a written brief (`mem job new`). All three refuse to start without a job:

| Sub-agent | Model | Can edit | For |
|---|---|---|---|
| `scout` | Haiku | no | finding, tracing, auditing, summarizing — anything reading-heavy |
| `worker` | Sonnet | yes | building and fixing |
| `reviewer` | Opus | no | judging a change it did not write |

A blocked sub-agent asks; the main agent checks memory before it asks you. Briefs, notes, answers,
reports and check results live in `~/.sumo-agents/jobs/<id>/`, so a job started today can be picked up
tomorrow. One worker per project at a time — they share a working tree, and `mem job new` says so when
a second one is created.

## How coding work gets done

Three kinds of work have a written way of doing them. Each is a short numbered list in `guides/`, read
only when that work comes up:

| You type | Guide | The gist |
|---|---|---|
| `/fix <what is wrong>` | `guides/fix.md` | What changed recently → make it fail on demand → find *where* it breaks before saying *why* → one cause at a time, each with evidence → fix where it starts → the same reproduction passes |
| `/feature <what to build>` | `guides/feature.md` | Size it (experiment · change to existing code · new subsystem) → agree what done means → tests first, seen failing → build without touching them → name a wrong implementation that would still pass, and kill it |
| `/review <what to judge>` | `guides/review.md` | A reviewer that did not write the code, reading only the change: first "does it do what was asked" (missing · extra · misunderstood), then "can it be trusted"; every finding has a file:line and a concrete way it fails |

You do not have to type the command: `AGENTS.md` tells the agent to read the matching guide first.

**`--guide`** is how the same steps reach a sub-agent. `mem job new --guide fix` pastes `guides/fix.md`
into the worker's brief, so a delegated fix is done the same way as one done in the conversation. A
reviewer job always carries `guides/review.md`.

## How a worker's DONE is checked

Whoever did the work does not grade it. A worker's `DONE` rests on what the project's own checks say,
run by `mem` — not on what the report says.

```
mem job new            records where the work starts: the tree exactly as it is, your uncommitted
                       edits included, so they are never counted as the job's
mem job baseline <id>  the worker's first step — runs the project's checks before any edit and records
                       what already fails
   … the worker works …
mem job verify <id>    runs the same checks and gives the verdict, without closing anything
mem job finish <id> --status DONE
                       uses that verdict if the files have not moved since, otherwise runs the checks
                       again — and refuses DONE while anything is blocking
```

Which commands are "the project's checks": its `check` script or Makefile target when it has one (that
is the project's own gate), otherwise its `test`, `lint` and `typecheck` commands — the same ones shown
on the project card. Each gets nine minutes (`SUMO_AGENTS_CHECK_TIMEOUT_MS`); the end of its output is
kept in the job's folder.

| The verdict says | Meaning | Effect |
|---|---|---|
| a check `FAILED` that passed at the baseline | the job broke it | **blocks DONE** |
| a check `FAILED` and no baseline was taken | nothing shows it was already broken, so it counts as the job's | **blocks DONE** |
| a test that already existed was edited, renamed or deleted | tests judge the change; they are not part of it | **blocks DONE** — unless the job was created with `--tests-may-change` |
| a check `was already failing` | broken before the job began, and still is | allowed; both outputs are kept to compare |
| `look at:` added lines with `eslint-disable`, `@ts-ignore`, `# noqa`, `.skip(`, `t.Skip(` … | a checker was told to look away | allowed, and printed beside the STATUS line for a person to judge |
| `note:` not a git repository / no commands | it could not be known | said, never guessed |

A refused worker always has an honest way out, and the refusal names it: fix it, finish as `FAILED`, or
`mem job ask`. When the checks cannot run on this machine, `--accept "<why>"` takes the work anyway and
marks it `DONE (UNVERIFIED …)` in the STATUS line and in the report. So a plain `STATUS: DONE` from a
worker means the checks agreed.

A baseline asked for after the first edit is refused: it would call the job's own breakage "already
there". New test files are always welcome — only tests that were there before the job are protected.

The worker's report has two sections for things that would otherwise go unsaid: **Concerns** (finished,
but not sure of) and **Decisions** (each call made on your behalf: what, why, what it costs if wrong).
A running worker settles small questions itself and lists them; it stops to ask only for something
destructive, security-sensitive, outside the project, or too unclear to do without guessing.

## Reviews

```sh
mem job new --project <slug> --agent reviewer --reviews <job id> --title "review j12"   # that job's change
mem job new --project <slug> --agent reviewer --title "review the tree"                  # whatever is uncommitted
```

What was asked for goes on stdin — a review is against that, not against taste. The reviewer is handed
the whole change as one file (`changes.diff` in its job folder; `mem job changes <id>` writes the same
file for any worker job), the original brief, and the author's report marked as *claims, not facts*.
It reports: asked vs built · findings, worst first · minor (listed, never a reason to reopen the work) ·
what the change alone could not show.

The reviewer runs in a fresh context on a stronger model than the worker, on purpose: review in a
separate session finds more than re-reading in the same one, and a weaker judge makes work worse
rather than better. Findings are still claims — `guides/review.md` ends with how to receive them.

## What a project card tells you about hygiene

`mem project add` scans what the project declares about itself. Besides stack and commands, the card
says what is absent — `not set up here: a lint command, a CI workflow` — so that "nothing failed" is
never mistaken for "it was checked". A `check` script or target counts as the project's gate and stands
in for test and lint. `mem project rescan <slug>` after setting one up.

## What is enforced, and what is only asked

| Enforced by code | Asked in a prompt |
|---|---|
| a worker's DONE against the project's checks and a baseline | the steps in `guides/fix.md`, `feature.md`, `review.md` |
| existing tests untouched by a worker | the rules in `AGENTS.md` for work done in the conversation itself |
| no reviewer or scout can edit (no edit tools) | a worker running `mem job baseline` first — though skipping it only hurts the worker |
| a taught workflow's steps before a gated shell command | |
| no job, no sub-agent | |

The split is deliberate: a line in a prompt is a request, and the things that are cheap to check by
running something are checked by running something.

## What it costs

Measured on this machine, Claude Code 2.1, Haiku 4.5, subscription login:

- One scribe call: about 4,300 tokens in, 300–600 out, **$0.011–0.013**, 4–8 s, in the background.
- 30 labelled turns over six conversations: **$0.07**. It remembered 16 of 16 things it should, put
  16 of 16 in the right project, proved all 16 with a real quote, and remembered 0 of 14 throwaway turns.
- The always-loaded prompt (`AGENTS.md`) is about 600 tokens, and a test keeps it there.

`mem config scribe.model sonnet` switches the writer's model; `off` makes the chat model save directly.

## Tests

```sh
npm test                              # 88 tests, no network, no model calls (recorded answers)
node probes/scope-accuracy.mjs        # live: real model, about 7 cents
```

## Layout

```
AGENTS.md            the only always-loaded instructions (CLAUDE.md just imports it)
guides/              read on demand: memory · projects · workflows · delegation · fix · feature · review
prompts/             system prompts for the scribe and dream passes
bin/mem.mjs  src/    the `mem` CLI — Node, zero dependencies, SQLite full-text search
.claude/             hooks, the `mem` permission, the scout, worker and reviewer agents, /dream /fix /feature /review
test/  probes/       the suite, and the live measurement
docs/PLAN.md         the design, the evidence behind it, and what was measured while building it
```
